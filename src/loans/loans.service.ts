import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { WalletService } from '../wallet/wallet.service';
import { MembershipsService } from '../memberships/memberships.service';
import { getCurrentPeriod } from '../common/utils/period.util';
import { RequestLoanDto } from './dto/request-loan.dto';

// ── Design decision, made explicit ──────────────────────────────────────
// "Savings" throughout this module means WALLET BALANCE (specifically
// available balance — total balance minus whatever is already locked as
// someone else's collateral), not cumulative historical contributions.
// Contributions are money that has already left the wallet permanently (paid
// to the cooperative), so they can't be what gets locked as loan collateral —
// only money still sitting in the wallet can be. This also matches the
// "Save Money" wallet concept from the app design: it's the money a member
// currently holds in the system, not a running total of everything they've
// ever paid in.
@Injectable()
export class LoansService {
  constructor(
    private prisma: PrismaService,
    private walletService: WalletService,
    private membershipsService: MembershipsService,
  ) {}

  async getEligibility(userId: string, membershipId: string) {
    const membership = await this.membershipsService.assertMembershipOwnership(userId, membershipId);
    const cooperative = await this.prisma.cooperative.findUniqueOrThrow({ where: { id: membership.cooperativeId } });

    const wallet = await this.walletService.getWalletByUserId(userId);
    const availableBalance = await this.walletService.getAvailableBalance(wallet.id);
    const maxLoanAmount = availableBalance.times(cooperative.loanMultiplier);

    return {
      currentSavings: availableBalance.toFixed(2),
      loanMultiplier: cooperative.loanMultiplier.toFixed(2),
      maxLoanAmount: maxLoanAmount.toFixed(2),
      interestPercent: cooperative.loanInterestPercent.toFixed(2),
    };
  }

  async requestLoan(userId: string, membershipId: string, dto: RequestLoanDto) {
    const borrowerMembership = await this.membershipsService.assertMembershipOwnership(userId, membershipId);
    const cooperative = await this.prisma.cooperative.findUniqueOrThrow({
      where: { id: borrowerMembership.cooperativeId },
    });

    const amount = new Prisma.Decimal(dto.amount);
    if (amount.lte(0)) {
      throw new BadRequestException('Loan amount must be greater than zero.');
    }

    // ── Borrower eligibility: up to loanMultiplier × their available wallet balance. ──
    const borrowerWallet = await this.walletService.getWalletByUserId(userId);
    const borrowerAvailable = await this.walletService.getAvailableBalance(borrowerWallet.id);
    const maxLoanAmount = borrowerAvailable.times(cooperative.loanMultiplier);

    if (amount.gt(maxLoanAmount)) {
      throw new BadRequestException(
        `Requested amount exceeds your maximum eligible loan of ₦${maxLoanAmount.toFixed(2)} (${cooperative.loanMultiplier}x your current savings).`,
      );
    }

    // ── Guarantor eligibility: never trust the guarantorMembershipId at face
    // value — re-verify it's a real, active membership in THIS cooperative,
    // isn't the borrower's own, and has enough available balance to cover
    // the requested amount. ──
    if (dto.guarantorMembershipId === membershipId) {
      throw new BadRequestException('You cannot guarantee your own loan.');
    }

    const guarantorMembership = await this.prisma.membership.findUnique({
      where: { id: dto.guarantorMembershipId },
    });
    if (
      !guarantorMembership ||
      guarantorMembership.cooperativeId !== borrowerMembership.cooperativeId ||
      guarantorMembership.status !== 'ACTIVE'
    ) {
      throw new NotFoundException('Guarantor membership not found in this cooperative.');
    }

    const guarantorWallet = await this.walletService.getWalletByUserId(guarantorMembership.userId);
    const guarantorAvailable = await this.walletService.getAvailableBalance(guarantorWallet.id);

    if (guarantorAvailable.lt(amount)) {
      throw new BadRequestException(
        "The selected guarantor does not have sufficient available savings to back this loan amount.",
      );
    }

    // Collateral is NOT locked yet at request time — only once an admin
    // actually approves the loan (see AdminLoansService). Locking at request
    // time would tie up a guarantor's funds for a request that might be
    // rejected; the commitment only becomes binding on approval.
    return this.prisma.loan.create({
      data: {
        cooperativeId: borrowerMembership.cooperativeId,
        borrowerMembershipId: membershipId,
        guarantorMembershipId: dto.guarantorMembershipId,
        amount: dto.amount,
        interestPercent: cooperative.loanInterestPercent,
        status: 'REQUESTED',
      },
    });
  }

  async getMyLoans(userId: string, membershipId: string) {
    await this.membershipsService.assertMembershipOwnership(userId, membershipId);
    return this.prisma.loan.findMany({
      where: { borrowerMembershipId: membershipId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async getLoanDetail(userId: string, membershipId: string, loanId: string) {
    await this.membershipsService.assertMembershipOwnership(userId, membershipId);
    const loan = await this.getOwnedLoan(membershipId, loanId);
    return { ...loan, ...(await this.computeOutstanding(loan)) };
  }

  // ── Repayment: partial repayments are allowed (unlike contributions, which
  // require an exact amount) — this is a deliberate, sensible difference,
  // since loans are commonly paid down gradually. What's NOT allowed is
  // overpaying past the outstanding balance, or paying a non-ACTIVE loan. ──
  async repayLoan(userId: string, membershipId: string, loanId: string, params: { amount: string; idempotencyKey: string }) {
    await this.membershipsService.assertMembershipOwnership(userId, membershipId);
    const loan = await this.getOwnedLoan(membershipId, loanId);

    if (loan.status !== 'ACTIVE') {
      throw new ConflictException('This loan is not currently active.');
    }

    const repaymentIdempotencyKey = `loan-repayment:${params.idempotencyKey}`;
    const existing = await this.prisma.ledgerEntry.findUnique({ where: { idempotencyKey: repaymentIdempotencyKey } });
    if (existing) {
      return existing; // idempotent replay
    }

    const amount = new Prisma.Decimal(params.amount);
    if (amount.lte(0)) {
      throw new BadRequestException('Repayment amount must be greater than zero.');
    }

    const { outstanding } = await this.computeOutstanding(loan);
    if (amount.gt(outstanding)) {
      throw new BadRequestException(
        `Repayment amount exceeds the outstanding balance of ₦${outstanding}.`,
      );
    }

    const wallet = await this.walletService.getWalletByUserId(userId);
    const willFullyRepay = amount.eq(outstanding);

    try {
      return await this.prisma.$transaction(
        async (tx) => {
          const walletDebit = await this.walletService.debitWithinTransaction(tx, {
            walletId: wallet.id,
            amount: params.amount,
            source: 'LOAN_REPAYMENT',
            idempotencyKey: `wallet-debit:${repaymentIdempotencyKey}`,
          });

          const ledgerEntry = await tx.ledgerEntry.create({
            data: {
              membershipId,
              type: 'LOAN_REPAYMENT',
              amount: params.amount,
              period: getCurrentPeriod(),
              idempotencyKey: repaymentIdempotencyKey,
              walletLedgerEntryId: walletDebit.id,
              loanId: loan.id,
            },
          });

          if (willFullyRepay) {
            await tx.loan.update({
              where: { id: loan.id },
              data: { status: 'REPAID', repaidAt: new Date() },
            });

            // Release the guarantor's collateral now that the loan is fully
            // settled — this is the counterpart to the lock in
            // AdminLoansService.disburse().
            const guarantorMembership = await tx.membership.findUniqueOrThrow({
              where: { id: loan.guarantorMembershipId },
            });
            const guarantorWallet = await tx.wallet.findUniqueOrThrow({
              where: { userId: guarantorMembership.userId },
            });
            await tx.wallet.update({
              where: { id: guarantorWallet.id },
              data: { lockedBalance: { decrement: loan.amount } },
            });
          }

          return ledgerEntry;
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const winner = await this.prisma.ledgerEntry.findUnique({ where: { idempotencyKey: repaymentIdempotencyKey } });
        if (winner) return winner;
      }
      throw err;
    }
  }

  // ── Interest calculation, made explicit ──────────────────────────────
  // Simple (non-compounding) interest on the original principal:
  //   accruedInterest = principal × (interestPercent / 100) × periodsElapsed
  // "Monthly" is approximated here as a flat 30-day period rather than exact
  // calendar months, for simplicity in this first implementation — flagged
  // as an open item to refine (precise calendar-month billing cycles) before
  // this is relied on for real financial reporting.
  async computeOutstanding(loan: {
    id: string;
    amount: Prisma.Decimal;
    interestPercent: Prisma.Decimal;
    disbursedAt: Date | null;
    status: string;
  }) {
    const principal = loan.amount;

    let accruedInterest = new Prisma.Decimal(0);
    if (loan.disbursedAt && (loan.status === 'ACTIVE' || loan.status === 'REPAID')) {
      const msElapsed = Date.now() - loan.disbursedAt.getTime();
      const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
      const periodsElapsed = Math.max(1, Math.ceil(msElapsed / THIRTY_DAYS_MS));
      accruedInterest = principal.times(loan.interestPercent).dividedBy(100).times(periodsElapsed);
    }

    const totalOwed = principal.plus(accruedInterest);

    const repaymentSum = await this.prisma.ledgerEntry.aggregate({
      where: { loanId: loan.id, type: 'LOAN_REPAYMENT' },
      _sum: { amount: true },
    });
    const totalRepaid = repaymentSum._sum.amount ?? new Prisma.Decimal(0);

    const outstanding = totalOwed.minus(totalRepaid);

    return {
      principal: principal.toFixed(2),
      accruedInterest: accruedInterest.toFixed(2),
      totalOwed: totalOwed.toFixed(2),
      totalRepaid: totalRepaid.toFixed(2),
      outstanding: outstanding.toFixed(2),
    };
  }

  private async getOwnedLoan(membershipId: string, loanId: string) {
    const loan = await this.prisma.loan.findUnique({ where: { id: loanId } });
    if (!loan || loan.borrowerMembershipId !== membershipId) {
      throw new NotFoundException('Loan not found.');
    }
    return loan;
  }
}
