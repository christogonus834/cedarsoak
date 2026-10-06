import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { WalletService } from '../wallet/wallet.service';
import { LoanStatus } from '@prisma/client';

@Injectable()
export class AdminLoansService {
  constructor(
    private prisma: PrismaService,
    private walletService: WalletService,
  ) {}

  async list(cooperativeId: string, status?: LoanStatus) {
    return this.prisma.loan.findMany({
      where: { cooperativeId, ...(status ? { status } : {}) },
      include: {
        borrowerMembership: { include: { user: { select: { firstName: true, lastName: true } } } },
        guarantorMembership: { include: { user: { select: { firstName: true, lastName: true } } } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  // Approval alone does NOT move any money and does NOT lock collateral yet
  // — it just marks the loan as vetted and ready for disbursement. This is
  // step one of the two-person control; see disburse() for step two.
  async approve(cooperativeId: string, loanId: string, adminUserId: string) {
    const loan = await this.getScopedLoan(cooperativeId, loanId);

    if (loan.status !== 'REQUESTED') {
      throw new ConflictException('Only a REQUESTED loan can be approved.');
    }

    return this.prisma.loan.update({
      where: { id: loan.id },
      data: { status: 'APPROVED', approvedByUserId: adminUserId, approvedAt: new Date() },
    });
  }

  async reject(cooperativeId: string, loanId: string, adminUserId: string, reason: string) {
    const loan = await this.getScopedLoan(cooperativeId, loanId);

    if (loan.status !== 'REQUESTED') {
      throw new ConflictException('Only a REQUESTED loan can be rejected.');
    }

    return this.prisma.loan.update({
      where: { id: loan.id },
      data: {
        status: 'REJECTED',
        rejectedByUserId: adminUserId,
        rejectedAt: new Date(),
        rejectionReason: reason,
      },
    });
  }

  // ── Disbursement: the second, separate control. ──────────────────────────
  // Per our security design (Separation of Duties, control #25): no single
  // admin can both approve and disburse a loan. This is enforced HERE, not
  // just as a policy — a disbursement attempt by the same admin who approved
  // is rejected outright, regardless of role.
  //
  // Re-validates the guarantor's available balance fresh at disbursement
  // time (it may have changed since the original request, e.g. the
  // guarantor withdrew funds in the meantime) via lockCollateral(), which
  // performs its own atomic availability check and throws if insufficient.
  async disburse(cooperativeId: string, loanId: string, adminUserId: string) {
    const loan = await this.getScopedLoan(cooperativeId, loanId);

    if (loan.status !== 'APPROVED') {
      throw new ConflictException('Only an APPROVED loan can be disbursed.');
    }

    if (loan.approvedByUserId === adminUserId) {
      throw new ForbiddenException(
        'Separation of duties: the admin who approved this loan cannot also disburse it. A different admin must complete this step.',
      );
    }

    const guarantorMembership = await this.prisma.membership.findUniqueOrThrow({
      where: { id: loan.guarantorMembershipId },
    });
    const guarantorWallet = await this.walletService.getWalletByUserId(guarantorMembership.userId);

    const borrowerMembership = await this.prisma.membership.findUniqueOrThrow({
      where: { id: loan.borrowerMembershipId },
    });
    const borrowerWallet = await this.walletService.getWalletByUserId(borrowerMembership.userId);

    // Lock collateral FIRST — if the guarantor no longer has sufficient
    // available balance, this throws and nothing else happens (no partial
    // disbursement is possible).
    await this.walletService.lockCollateral(guarantorWallet.id, loan.amount.toString());

    try {
      await this.walletService.credit({
        walletId: borrowerWallet.id,
        amount: loan.amount.toString(),
        source: 'LOAN_DISBURSEMENT',
        idempotencyKey: `loan-disbursement:${loan.id}`,
        metadata: { loanId: loan.id },
      });
    } catch (err) {
      // If crediting the borrower fails after collateral was already locked,
      // release it immediately — never leave a guarantor's funds locked
      // against a loan that was never actually disbursed.
      await this.walletService.releaseCollateral(guarantorWallet.id, loan.amount.toString());
      throw err;
    }

    return this.prisma.loan.update({
      where: { id: loan.id },
      data: { status: 'ACTIVE', disbursedByUserId: adminUserId, disbursedAt: new Date() },
    });
  }

  private async getScopedLoan(cooperativeId: string, loanId: string) {
    const loan = await this.prisma.loan.findUnique({ where: { id: loanId } });
    if (!loan || loan.cooperativeId !== cooperativeId) {
      // Same IDOR-prevention principle as everywhere else — don't reveal
      // whether this loan exists in a different cooperative.
      throw new NotFoundException('Loan not found.');
    }
    return loan;
  }
}
