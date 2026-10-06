import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { WalletService } from '../wallet/wallet.service';
import { getCurrentPeriod, getPeriodDueDate } from '../common/utils/period.util';
import { v4 as uuidv4 } from 'uuid';

@Injectable()
export class AdminPaymentAdjustmentService {
  constructor(
    private prisma: PrismaService,
    private walletService: WalletService,
  ) {}

  // ── Reverses a contribution payment. ─────────────────────────────────────
  // Per our design: members never self-report disputes into the system —
  // they raise it with the admin (with consent as part of that human
  // process), and only the admin, through this audited endpoint, can correct
  // a payment. This method:
  //   1. Verifies the ledger entry belongs to THIS cooperative (never trusts
  //      the ledgerEntryId alone — same IDOR-prevention principle as everywhere else).
  //   2. Refuses to reverse something already reversed (an entry can only be
  //      adjusted once — this is a hard stop, not an idempotent replay).
  //   3. Credits the wallet back the exact original amount.
  //   4. Reopens the ContributionObligation so the member owes again.
  //   5. Writes a full before/after AuditLog entry — this is the record that
  //      makes the whole action provable after the fact.
  // Steps 3 and 4 happen in one transaction; nothing here uses the original
  // entry's own idempotency key, since this is a deliberate one-off admin
  // action, not a retryable client request.
  async reverseContributionPayment(params: {
    cooperativeId: string;
    ledgerEntryId: string;
    adminUserId: string;
    reason: string;
    memberConsentNote: string;
  }) {
    const originalEntry = await this.prisma.ledgerEntry.findUnique({
      where: { id: params.ledgerEntryId },
      include: { membership: true },
    });

    if (!originalEntry || originalEntry.membership.cooperativeId !== params.cooperativeId) {
      // Same reasoning as the scope guard: don't reveal whether this ID
      // exists at all if it belongs to a different cooperative.
      throw new NotFoundException('Payment record not found.');
    }

    if (originalEntry.type !== 'CONTRIBUTION_PAYMENT') {
      throw new ConflictException('Only contribution payments can be reversed through this endpoint.');
    }

    const alreadyAdjusted = await this.prisma.ledgerEntry.findFirst({
      where: { relatedLedgerEntryId: originalEntry.id, type: 'PAYMENT_ADJUSTMENT' },
    });
    if (alreadyAdjusted) {
      throw new ConflictException('This payment has already been adjusted.');
    }

    const wallet = await this.prisma.wallet.findUniqueOrThrow({
      where: { userId: originalEntry.membership.userId },
    });

    const beforeObligation = await this.prisma.contributionObligation.findUnique({
      where: { membershipId_period: { membershipId: originalEntry.membershipId, period: originalEntry.period } },
    });

    const result = await this.prisma.$transaction(async (tx) => {
      // Credit the wallet back — a fresh, admin-specific idempotency key
      // since this is a one-off action, not something a client would retry.
      const walletCredit = await this.walletService.creditWithinTransaction(tx, {
        walletId: wallet.id,
        amount: originalEntry.amount.toString(),
        source: 'ADJUSTMENT',
        idempotencyKey: `admin-reversal:${originalEntry.id}:${uuidv4()}`,
        metadata: { reason: params.reason, adminUserId: params.adminUserId },
      });

      const adjustmentEntry = await tx.ledgerEntry.create({
        data: {
          membershipId: originalEntry.membershipId,
          type: 'PAYMENT_ADJUSTMENT',
          amount: originalEntry.amount,
          period: originalEntry.period,
          idempotencyKey: `adjustment:${originalEntry.id}`,
          relatedLedgerEntryId: originalEntry.id,
          walletLedgerEntryId: walletCredit.id,
        },
      });

      // Reopen the obligation so the member owes again — never silently
      // leave it marked PAID after the payment behind it has been reversed.
      const isPastDue = new Date() > getPeriodDueDate(originalEntry.period);
      const updatedObligation = beforeObligation
        ? await tx.contributionObligation.update({
            where: { id: beforeObligation.id },
            data: { status: isPastDue ? 'OVERDUE' : 'PENDING', paidAt: null },
          })
        : null;

      return { adjustmentEntry, updatedObligation };
    });

    // Full before/after audit trail — this IS the record that proves what
    // happened, who did it, and why, per our design requirement.
    await this.prisma.auditLog.create({
      data: {
        actorUserId: params.adminUserId,
        action: 'PAYMENT_ADJUSTMENT',
        entityType: 'LedgerEntry',
        entityId: originalEntry.id,
        beforeState: {
          ledgerEntry: this.serializeEntry(originalEntry),
          obligationStatus: beforeObligation?.status ?? null,
        },
        afterState: {
          adjustmentEntry: this.serializeEntry(result.adjustmentEntry),
          obligationStatus: result.updatedObligation?.status ?? null,
        },
        metadata: {
          reason: params.reason,
          memberConsentNote: params.memberConsentNote,
        },
      },
    });

    return result.adjustmentEntry;
  }

  private serializeEntry(entry: { id: string; amount: unknown; period: string; type: string }) {
    // Decimal fields don't serialize cleanly into JSON by default — convert
    // explicitly so the audit log's before/after snapshots are readable.
    return { id: entry.id, amount: String(entry.amount), period: entry.period, type: entry.type };
  }
}
