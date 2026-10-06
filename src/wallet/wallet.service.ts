import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, WalletEntrySource, WalletEntryType } from '@prisma/client';
import * as crypto from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { VanProviderRegistry } from '../payments/van-provider-registry.service';
import { PaystackProvider } from '../payments/providers/paystack.provider';
import { v4 as uuidv4 } from 'uuid';

export interface LedgerMovement {
  walletId: string;
  amount: string; // decimal as string — never a JS float, to avoid precision bugs with money
  source: WalletEntrySource;
  idempotencyKey: string;
  providerReference?: string;
  relatedLedgerEntryId?: string;
  metadata?: Record<string, unknown>;
}

// Type alias for whichever Prisma client we're handed — either the normal
// singleton, or the transactional client inside a $transaction callback.
export type PrismaTx = Prisma.TransactionClient | PrismaService;

@Injectable()
export class WalletService {
  private readonly logger = new Logger(WalletService.name);

  constructor(
    private prisma: PrismaService,
    private vanProviderRegistry: VanProviderRegistry,
    private paystackProvider: PaystackProvider,
  ) {}

  async getWalletByUserId(userId: string) {
    const wallet = await this.prisma.wallet.findUnique({ where: { userId } });
    if (!wallet) throw new NotFoundException('Wallet not found.');
    return wallet;
  }

  // ── Balance is ALWAYS derived, never read from a stored column. ──────────
  // This is the single most important rule from our design: summing an
  // append-only ledger means two concurrent writes can never silently
  // overwrite each other into a wrong number the way a stored `balance += x`
  // update could under a race condition.
  async getBalance(walletId: string, tx: PrismaTx = this.prisma): Promise<Prisma.Decimal> {
    const result = await tx.walletLedgerEntry.aggregate({
      where: { walletId, type: WalletEntryType.CREDIT },
      _sum: { amount: true },
    });
    const credits = result._sum.amount ?? new Prisma.Decimal(0);

    const debitResult = await tx.walletLedgerEntry.aggregate({
      where: { walletId, type: WalletEntryType.DEBIT },
      _sum: { amount: true },
    });
    const debits = debitResult._sum.amount ?? new Prisma.Decimal(0);

    return credits.minus(debits);
  }

  // Withdrawable balance excludes any amount currently locked as guarantor
  // collateral (see loan module) — a guarantor cannot withdraw funds they've
  // committed to back someone else's loan.
  async getAvailableBalance(walletId: string): Promise<Prisma.Decimal> {
    const [balance, wallet] = await Promise.all([
      this.getBalance(walletId),
      this.prisma.wallet.findUniqueOrThrow({ where: { id: walletId } }),
    ]);
    return balance.minus(wallet.lockedBalance);
  }

  async getWalletSummary(userId: string) {
    const wallet = await this.getWalletByUserId(userId);
    const balance = await this.getBalance(wallet.id);
    const available = balance.minus(wallet.lockedBalance);
    return {
      walletId: wallet.id,
      balance: balance.toFixed(2),
      lockedBalance: wallet.lockedBalance.toFixed(2),
      availableBalance: available.toFixed(2),
      vanAccountNumber: wallet.vanAccountNumber,
      vanBankName: wallet.vanBankName,
      vanProvider: wallet.vanProvider,
    };
  }

  // Renamed from provisionVirtualAccount to make the BVN requirement visible
  // at the call site. Monnify's reserved-account API REQUIRES a raw BVN in
  // the request (confirmed against their live docs) — but our security
  // design never stores a raw BVN. The resolution: the BVN is accepted here
  // as a plain function argument, used exactly once for the outbound call to
  // Monnify, and never written to any column. We persist only bvnVerified
  // (true once Monnify accepts it) and bvnHash (a one-way SHA-256, kept only
  // to detect the same BVN being reused across multiple accounts).
  //
  // Idempotent: if the wallet already has a VAN, returns it instead of
  // generating a duplicate — calling this twice (e.g. a retried request from
  // a flaky connection) is always safe.
  async verifyBvnAndProvisionAccount(userId: string, bvn: string) {
    const wallet = await this.getWalletByUserId(userId);
    if (wallet.vanAccountNumber) {
      return wallet; // already provisioned — nothing to do
    }

    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    const provider = await this.vanProviderRegistry.getActiveProvider();

    const accountReference = `user-${userId}`; // stable, unique per user

    // This call both validates the BVN (Monnify rejects malformed/invalid
    // BVNs with a clear error, which propagates up as a 4xx to the caller)
    // AND provisions the account, in one round trip — there is no separate
    // "verify BVN" step that would require storing the raw number for later.
    const generated = await provider.generateVirtualAccount({
      accountReference,
      accountName: `${user.firstName} ${user.lastName}`,
      customerEmail: user.email,
      customerPhone: user.phoneNumber,
      bvn,
    });

    const bvnHash = crypto.createHash('sha256').update(bvn).digest('hex');

    const [, updatedWallet] = await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: userId },
        data: { bvnVerified: true, bvnHash },
      }),
      this.prisma.wallet.update({
        where: { userId },
        data: {
          vanProvider: generated.provider,
          vanAccountNumber: generated.accountNumber,
          vanBankName: generated.bankName,
          vanAccountReference: generated.accountReference,
        },
      }),
    ]);

    return updatedWallet;
  }

  // Called ONLY by the webhook controller, after signature verification AND
  // independent transaction re-verification against the provider's own API.
  // This method itself still enforces idempotency via the unique constraint —
  // defense in depth, in case the webhook is ever (mis)called twice.
  async creditFromVerifiedProviderTransaction(params: {
    accountReference: string;
    amount: string;
    providerReference: string;
    provider: string;
    raw: unknown;
  }) {
    const wallet = await this.prisma.wallet.findUnique({
      where: { vanAccountReference: params.accountReference },
    });
    if (!wallet) {
      // This would mean a provider sent us a webhook for an account reference
      // we don't recognize — log loudly, this is worth investigating, never
      // silently drop it.
      this.logger.error(
        `Webhook credit failed: no wallet found for accountReference=${params.accountReference}`,
      );
      throw new NotFoundException('No wallet matches this account reference.');
    }

    return this.credit({
      walletId: wallet.id,
      amount: params.amount,
      source: WalletEntrySource.VAN_FUNDING,
      // Using the PROVIDER's own transaction reference as the idempotency key
      // is what makes a retried/duplicate webhook safe — Monnify (or any
      // provider) may send the same webhook more than once on their end.
      idempotencyKey: `${params.provider}:${params.providerReference}`,
      providerReference: params.providerReference,
      metadata: { raw: params.raw as Record<string, unknown> },
    });
  }


  // ── Transaction-composable primitives ────────────────────────────────────
  // creditWithinTransaction/debitWithinTransaction do the actual work and
  // accept a `tx` client, so OTHER services (e.g. ContributionsService) can
  // include a wallet movement as part of a larger atomic transaction — for
  // example, debiting a wallet AND updating a contribution obligation AND
  // writing a cooperative-side ledger entry, all as one all-or-nothing unit.
  // credit()/debit() below are the standalone versions everything else uses,
  // and are just thin wrappers that open their own transaction and delegate here.
  //
  // IMPORTANT for callers composing these into a larger transaction: if the
  // outer transaction fails for an unrelated reason AFTER this insert
  // succeeds, Postgres rolls back the whole thing including this insert —
  // that's the entire point. But idempotency-conflict handling (P2002) is
  // NOT caught inside these primitives, because once a query errors inside a
  // transaction, that transaction is aborted and nothing else in it can run
  // safely afterward — catching and continuing on the same connection would
  // be incorrect. Callers composing their own transaction must check for an
  // existing record (via idempotencyKey) BEFORE starting the transaction, and
  // catch P2002 around the whole `$transaction(...)` call, exactly like
  // ContributionsService.payContribution() does.

  async creditWithinTransaction(tx: PrismaTx, movement: LedgerMovement) {
    if (new Prisma.Decimal(movement.amount).lte(0)) {
      throw new BadRequestException('Credit amount must be greater than zero.');
    }
    return tx.walletLedgerEntry.create({
      data: {
        walletId: movement.walletId,
        type: WalletEntryType.CREDIT,
        source: movement.source,
        amount: movement.amount,
        idempotencyKey: movement.idempotencyKey,
        providerReference: movement.providerReference,
        relatedLedgerEntryId: movement.relatedLedgerEntryId,
        metadata: movement.metadata as Prisma.InputJsonValue,
      },
    });
  }

  async debitWithinTransaction(tx: PrismaTx, movement: LedgerMovement) {
    const amount = new Prisma.Decimal(movement.amount);
    if (amount.lte(0)) {
      throw new BadRequestException('Debit amount must be greater than zero.');
    }

    const currentBalance = await this.getBalance(movement.walletId, tx);
    const wallet = await tx.wallet.findUniqueOrThrow({ where: { id: movement.walletId } });
    const availableBalance = currentBalance.minus(wallet.lockedBalance);

    if (availableBalance.lt(amount)) {
      throw new BadRequestException('Insufficient wallet balance.');
    }

    return tx.walletLedgerEntry.create({
      data: {
        walletId: movement.walletId,
        type: WalletEntryType.DEBIT,
        source: movement.source,
        amount: movement.amount,
        idempotencyKey: movement.idempotencyKey,
        providerReference: movement.providerReference,
        relatedLedgerEntryId: movement.relatedLedgerEntryId,
        metadata: movement.metadata as Prisma.InputJsonValue,
      },
    });
  }

  // Idempotency is enforced at the database level via the unique constraint
  // on `idempotencyKey` in the schema — this method is safe to call twice
  // with the same key (e.g. a retried webhook) and will not double-credit.
  async credit(movement: LedgerMovement) {
    try {
      return await this.creditWithinTransaction(this.prisma, movement);
    } catch (err) {
      return this.handleIdempotencyConflict(err, movement.idempotencyKey);
    }
  }

  // ── Debit: money going OUT of the wallet (cooperative payment, withdrawal). ─
  // This runs inside a serializable transaction: the balance is recomputed
  // and checked *inside* the same transaction as the insert, so two
  // simultaneous debit requests can't both read "sufficient funds" against
  // the same starting balance and overdraw the wallet. If Postgres detects a
  // serialization conflict, Prisma throws and the caller should retry once.
  async debit(movement: LedgerMovement) {
    try {
      return await this.prisma.$transaction(
        (tx: Prisma.TransactionClient) => this.debitWithinTransaction(tx, movement),
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
    } catch (err) {
      return this.handleIdempotencyConflict(err, movement.idempotencyKey);
    }
  }

  // Locks a portion of a guarantor's balance as loan collateral. Called by the
  // loan module on approval — flagged in our design doc as a required
  // mechanic so a guarantor can't withdraw committed savings mid-loan.
  async lockCollateral(walletId: string, amount: string) {
    const decimalAmount = new Prisma.Decimal(amount);
    return this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const wallet = await tx.wallet.findUniqueOrThrow({ where: { id: walletId } });
      const balance = await this.getBalance(walletId, tx);
      const available = balance.minus(wallet.lockedBalance);

      if (available.lt(decimalAmount)) {
        throw new BadRequestException(
          'Guarantor does not have sufficient available savings to back this loan.',
        );
      }

      return tx.wallet.update({
        where: { id: walletId },
        data: { lockedBalance: { increment: decimalAmount } },
      });
    });
  }

  async releaseCollateral(walletId: string, amount: string) {
    return this.prisma.wallet.update({
      where: { id: walletId },
      data: { lockedBalance: { decrement: new Prisma.Decimal(amount) } },
    });
  }

  // ── Withdrawals: wallet -> bank account, via Paystack. ──────────────────
  //
  // Sequence, matching our "money movement is a state machine" principle:
  //   1. Resolve + confirm the destination account (catches typos/fraud).
  //   2. Debit the wallet immediately (reserves the funds; uses the same
  //      race-condition-safe debit() as everything else).
  //   3. Create a WithdrawalRequest row (PENDING) tracking this specific attempt.
  //   4. Ask Paystack to initiate the transfer.
  //   5. If Paystack's own call fails outright, immediately credit the wallet
  //      back — the funds were reserved but the transfer never actually
  //      started, so there's nothing to wait on.
  //   6. If Paystack accepts it, the outcome (success/failure) is confirmed
  //      later via the webhook + independent verification, NOT by trusting
  //      this initiation response — see resolveWithdrawalFromWebhook().
  async initiateWithdrawal(userId: string, params: {
    amount: string;
    bankAccountNumber: string;
    bankCode: string;
  }) {
    const wallet = await this.getWalletByUserId(userId);

    // Step 1 — never send money to an unconfirmed account.
    const { accountName } = await this.paystackProvider.resolveAccount(
      params.bankAccountNumber,
      params.bankCode,
    );

    const idempotencyKey = uuidv4();

    // Step 2 — debit() itself re-checks available balance inside a
    // Serializable transaction, so this is safe even under concurrent
    // withdrawal attempts from the same wallet.
    const debitEntry = await this.debit({
      walletId: wallet.id,
      amount: params.amount,
      source: WalletEntrySource.WITHDRAWAL,
      idempotencyKey,
      metadata: { bankAccountNumber: params.bankAccountNumber, bankCode: params.bankCode },
    });

    // Step 3
    const withdrawalRequest = await this.prisma.withdrawalRequest.create({
      data: {
        walletId: wallet.id,
        amount: params.amount,
        bankAccountNumber: params.bankAccountNumber,
        bankCode: params.bankCode,
        resolvedAccountName: accountName,
        idempotencyKey,
        debitLedgerEntryId: debitEntry.id,
        status: 'PENDING',
      },
    });

    try {
      // Step 4
      const { recipientCode } = await this.paystackProvider.createRecipient({
        accountNumber: params.bankAccountNumber,
        bankCode: params.bankCode,
        accountName,
      });

      const amountKobo = Math.round(new Prisma.Decimal(params.amount).toNumber() * 100);

      const transfer = await this.paystackProvider.initiateTransfer({
        amountKobo,
        recipientCode,
        reference: idempotencyKey,
      });

      const resolvedStatus =
        transfer.status === 'success'
          ? 'SUCCESSFUL' // sandbox always returns this immediately, per Paystack's docs
          : transfer.status === 'otp'
            ? 'OTP_REQUIRED'
            : 'PENDING';

      return this.prisma.withdrawalRequest.update({
        where: { id: withdrawalRequest.id },
        data: {
          paystackTransferCode: transfer.transferCode,
          paystackRecipientCode: recipientCode,
          status: resolvedStatus,
        },
      });
    } catch (err) {
      // Step 5 — the transfer never actually started; give the money back.
      this.logger.error(`Withdrawal initiation failed for ${idempotencyKey}, reversing debit.`, err as Error);

      await this.credit({
        walletId: wallet.id,
        amount: params.amount,
        source: WalletEntrySource.ADJUSTMENT,
        idempotencyKey: `reversal:${idempotencyKey}`,
        metadata: { reason: 'withdrawal_initiation_failed', originalIdempotencyKey: idempotencyKey },
      });

      await this.prisma.withdrawalRequest.update({
        where: { id: withdrawalRequest.id },
        data: { status: 'FAILED', failureReason: 'Failed to initiate transfer with provider.' },
      });

      throw new BadRequestException(
        'We could not process your withdrawal right now. Your wallet balance has not been affected.',
      );
    }
  }

  // Called by the Paystack webhook handler, AFTER signature verification.
  // Exactly like the Monnify credit flow, we never trust the webhook payload
  // alone — we independently re-verify the transfer's status with Paystack
  // before doing anything to the ledger.
  async resolveWithdrawalFromWebhook(reference: string) {
    const withdrawalRequest = await this.prisma.withdrawalRequest.findUnique({
      where: { idempotencyKey: reference },
    });

    if (!withdrawalRequest) {
      this.logger.error(`Received a transfer webhook for unknown reference: ${reference}`);
      return;
    }

    // Already resolved — webhooks can be delivered more than once.
    if (withdrawalRequest.status === 'SUCCESSFUL' || withdrawalRequest.status === 'FAILED' || withdrawalRequest.status === 'REVERSED') {
      return withdrawalRequest;
    }

    const verified = await this.paystackProvider.verifyTransfer(reference);

    if (verified.status === 'success') {
      return this.prisma.withdrawalRequest.update({
        where: { id: withdrawalRequest.id },
        data: { status: 'SUCCESSFUL' },
      });
    }

    if (verified.status === 'failed' || verified.status === 'reversed') {
      // The debit already happened when the withdrawal was initiated — credit
      // it back now that we know the money never actually left (or came back).
      const reversalEntry = await this.credit({
        walletId: withdrawalRequest.walletId,
        amount: withdrawalRequest.amount.toString(),
        source: WalletEntrySource.ADJUSTMENT,
        idempotencyKey: `reversal:${reference}`,
        metadata: { reason: `withdrawal_${verified.status}`, originalIdempotencyKey: reference },
      });

      return this.prisma.withdrawalRequest.update({
        where: { id: withdrawalRequest.id },
        data: {
          status: verified.status === 'failed' ? 'FAILED' : 'REVERSED',
          reversalLedgerEntryId: reversalEntry.id,
          failureReason: `Provider reported status: ${verified.status}`,
        },
      });
    }

    // Still pending on Paystack's side — nothing to do yet, a later webhook
    // or the background reconciliation job will resolve this eventually.
    return withdrawalRequest;
  }

  // If a create() hits the unique idempotencyKey constraint (Prisma error
  // P2002), it means this exact operation was already processed — we return
  // the original entry instead of throwing, so retried requests (from a
  // flaky network, a duplicate webhook, or a double-tapped button) are safe.
  private async handleIdempotencyConflict(err: unknown, idempotencyKey: string) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      this.logger.warn(`Idempotent replay detected for key: ${idempotencyKey}`);
      const existing = await this.prisma.walletLedgerEntry.findUnique({
        where: { idempotencyKey },
      });
      if (existing) return existing;
    }
    throw err;
  }
}
