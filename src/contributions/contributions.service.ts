import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { WalletService } from '../wallet/wallet.service';
import { MembershipsService } from '../memberships/memberships.service';
import { getCurrentPeriod, getPeriodDueDate, isPeriodInFuture } from '../common/utils/period.util';

@Injectable()
export class ContributionsService {
  private readonly logger = new Logger(ContributionsService.name);

  constructor(
    private prisma: PrismaService,
    private walletService: WalletService,
    private membershipsService: MembershipsService,
  ) {}

  // Returns exactly what the "Pay Monthly Contribution" screen needs:
  // cooperative name, period, base amount, penalty, and total due — all
  // computed server-side, never trusting anything the client might send.
  async getContributionSummary(userId: string, membershipId: string, period?: string) {
    const membership = await this.membershipsService.assertMembershipOwnership(userId, membershipId);
    const cooperative = await this.prisma.cooperative.findUniqueOrThrow({
      where: { id: membership.cooperativeId },
    });
    const resolvedPeriod = period || getCurrentPeriod();
    const obligation = await this.getOrCreateObligation(membershipId, resolvedPeriod, cooperative);

    const totalDue = obligation.baseAmount.plus(obligation.penaltyAmount);

    return {
      cooperativeName: cooperative.name,
      period: resolvedPeriod,
      baseAmount: obligation.baseAmount.toFixed(2),
      penaltyAmount: obligation.penaltyAmount.toFixed(2),
      totalDue: totalDue.toFixed(2),
      status: obligation.status,
      isLate: obligation.penaltyAmount.gt(0),
    };
  }

  // ── The core money-movement operation of this module. ───────────────────
  // Three things must happen together or not at all: the wallet is debited,
  // a cooperative-side ledger entry is recorded, and the obligation is
  // marked paid. All three are composed into ONE database transaction using
  // WalletService's transaction-composable primitive (debitWithinTransaction)
  // rather than three separate operations that could partially fail.
  async payContribution(
    userId: string,
    membershipId: string,
    params: { amount: string; idempotencyKey: string; period?: string },
  ) {
    const membership = await this.membershipsService.assertMembershipOwnership(userId, membershipId);

    const ledgerIdempotencyKey = `contrib:${params.idempotencyKey}`;

    // Idempotent replay check BEFORE attempting anything — if this exact
    // request already succeeded (e.g. the client retried after a dropped
    // connection but the original request actually went through), return the
    // original result instead of re-running any logic or re-validating the
    // amount against what might now be a different obligation state.
    const existing = await this.prisma.ledgerEntry.findUnique({
      where: { idempotencyKey: ledgerIdempotencyKey },
    });
    if (existing) {
      this.logger.warn(`Idempotent replay detected for contribution payment: ${params.idempotencyKey}`);
      return existing;
    }

    const cooperative = await this.prisma.cooperative.findUniqueOrThrow({
      where: { id: membership.cooperativeId },
    });

    const resolvedPeriod = params.period || getCurrentPeriod();
    if (isPeriodInFuture(resolvedPeriod)) { throw new BadRequestException("Cannot pay a contribution for a future period."); }

    const obligation = await this.getOrCreateObligation(membershipId, resolvedPeriod, cooperative);

    if (obligation.status === 'PAID') {
      throw new ConflictException('This contribution has already been paid for this period.');
    }

    // ── EXACT AMOUNT ENFORCEMENT ─────────────────────────────────────────
    // Per explicit design requirement: a member cannot pay more or less than
    // the exact amount owed. No partial payments, no overpayment, no
    // "closest match" rounding. This is checked against the amount THIS
    // SERVER just calculated from the cooperative's configured contribution
    // amount plus any late penalty — never against a number the client sent
    // or displayed.
    const totalDue = obligation.baseAmount.plus(obligation.penaltyAmount);
    const paidAmount = new Prisma.Decimal(params.amount);

    if (!paidAmount.equals(totalDue)) {
      throw new BadRequestException(
        `Payment amount must be exactly ₦${totalDue.toFixed(2)}. Partial or excess payments are not accepted.`,
      );
    }

    const wallet = await this.walletService.getWalletByUserId(userId);

    try {
      return await this.prisma.$transaction(
        async (tx: Prisma.TransactionClient) => {
          const walletDebit = await this.walletService.debitWithinTransaction(tx, {
            walletId: wallet.id,
            amount: params.amount,
            source: 'COOPERATIVE_PAYMENT',
            idempotencyKey: `wallet-debit:${params.idempotencyKey}`,
          });

          const ledgerEntry = await tx.ledgerEntry.create({
            data: {
              membershipId,
              type: 'CONTRIBUTION_PAYMENT',
              amount: totalDue,
              period: resolvedPeriod,
              idempotencyKey: ledgerIdempotencyKey,
              walletLedgerEntryId: walletDebit.id,
            },
          });

          await tx.contributionObligation.update({
            where: { id: obligation.id },
            data: { status: 'PAID', paidAt: new Date() },
          });

          return ledgerEntry;
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
    } catch (err) {
      // A concurrent identical request (same idempotencyKey) may have
      // completed a split second earlier and won the unique-constraint race —
      // that's a successful outcome for the caller, not an error to surface.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const winner = await this.prisma.ledgerEntry.findUnique({
          where: { idempotencyKey: ledgerIdempotencyKey },
        });
        if (winner) return winner;
      }
      throw err;
    }
  }

  async getPaymentHistory(userId: string, membershipId: string) {
    await this.membershipsService.assertMembershipOwnership(userId, membershipId);
    return this.prisma.ledgerEntry.findMany({
      where: { membershipId },
      orderBy: { createdAt: 'desc' },
    });
  }

  // Lazily creates the obligation row for a given membership+period on first
  // access, and recomputes the late penalty if the due date has since passed
  // and it hasn't been applied yet. Once PAID, an obligation is never
  // mutated again by this method — corrections go through the admin
  // Payment Adjustment flow (a separate, audited module), never here.
  private async getOrCreateObligation(
    membershipId: string,
    period: string,
    cooperative: { contributionAmount: Prisma.Decimal; latePenaltyAmount: Prisma.Decimal },
  ) {
    const existing = await this.prisma.contributionObligation.findUnique({
      where: { membershipId_period: { membershipId, period } },
    });

    const dueDate = getPeriodDueDate(period);
    const isPastDue = new Date() > dueDate;

    if (existing) {
      if (existing.status === 'PENDING' && isPastDue && existing.penaltyAmount.eq(0)) {
        return this.prisma.contributionObligation.update({
          where: { id: existing.id },
          data: { penaltyAmount: cooperative.latePenaltyAmount, status: 'OVERDUE' },
        });
      }
      return existing;
    }

    return this.prisma.contributionObligation.create({
      data: {
        membershipId,
        period,
        baseAmount: cooperative.contributionAmount,
        penaltyAmount: isPastDue ? cooperative.latePenaltyAmount : 0,
        status: isPastDue ? 'OVERDUE' : 'PENDING',
        dueDate,
      },
    });
  }
}
