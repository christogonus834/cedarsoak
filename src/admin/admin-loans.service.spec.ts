import { Test } from '@nestjs/testing';
import { ConflictException, ForbiddenException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AdminLoansService } from './admin-loans.service';
import { PrismaService } from '../prisma/prisma.service';
import { WalletService } from '../wallet/wallet.service';

describe('AdminLoansService.disburse — separation of duties', () => {
  let service: AdminLoansService;
  let prisma: any;
  let walletService: any;

  const approvedLoan = {
    id: 'loan-1',
    cooperativeId: 'coop-1',
    status: 'APPROVED',
    approvedByUserId: 'admin-A',
    amount: new Prisma.Decimal(5000),
    guarantorMembershipId: 'guarantor-membership-1',
    borrowerMembershipId: 'borrower-membership-1',
  };

  beforeEach(async () => {
    prisma = {
      loan: { findUnique: jest.fn(), update: jest.fn() },
      membership: { findUniqueOrThrow: jest.fn() },
    };
    walletService = {
      getWalletByUserId: jest.fn(),
      lockCollateral: jest.fn(),
      releaseCollateral: jest.fn(),
      credit: jest.fn(),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        AdminLoansService,
        { provide: PrismaService, useValue: prisma },
        { provide: WalletService, useValue: walletService },
      ],
    }).compile();

    service = moduleRef.get(AdminLoansService);
  });

  it('REFUSES disbursement when the disbursing admin is the same person who approved', async () => {
    prisma.loan.findUnique.mockResolvedValue(approvedLoan);

    await expect(service.disburse('coop-1', 'loan-1', 'admin-A')).rejects.toThrow(ForbiddenException);

    // Critically: no money should move and no collateral should be touched
    // when this rule fires.
    expect(walletService.lockCollateral).not.toHaveBeenCalled();
    expect(walletService.credit).not.toHaveBeenCalled();
  });

  it('allows disbursement when a DIFFERENT admin performs it', async () => {
    prisma.loan.findUnique.mockResolvedValue(approvedLoan);
    prisma.membership.findUniqueOrThrow
      .mockResolvedValueOnce({ userId: 'guarantor-user' })
      .mockResolvedValueOnce({ userId: 'borrower-user' });
    walletService.getWalletByUserId
      .mockResolvedValueOnce({ id: 'guarantor-wallet' })
      .mockResolvedValueOnce({ id: 'borrower-wallet' });
    walletService.lockCollateral.mockResolvedValue({});
    walletService.credit.mockResolvedValue({});
    prisma.loan.update.mockResolvedValue({ ...approvedLoan, status: 'ACTIVE', disbursedByUserId: 'admin-B' });

    const result = await service.disburse('coop-1', 'loan-1', 'admin-B');

    expect(result.status).toBe('ACTIVE');
    expect(walletService.lockCollateral).toHaveBeenCalledWith('guarantor-wallet', '5000');
    expect(walletService.credit).toHaveBeenCalledWith(
      expect.objectContaining({ walletId: 'borrower-wallet', source: 'LOAN_DISBURSEMENT' }),
    );
  });

  it('releases the just-locked collateral if crediting the borrower fails afterward', async () => {
    prisma.loan.findUnique.mockResolvedValue(approvedLoan);
    prisma.membership.findUniqueOrThrow
      .mockResolvedValueOnce({ userId: 'guarantor-user' })
      .mockResolvedValueOnce({ userId: 'borrower-user' });
    walletService.getWalletByUserId
      .mockResolvedValueOnce({ id: 'guarantor-wallet' })
      .mockResolvedValueOnce({ id: 'borrower-wallet' });
    walletService.lockCollateral.mockResolvedValue({});
    walletService.credit.mockRejectedValue(new Error('unexpected failure'));

    await expect(service.disburse('coop-1', 'loan-1', 'admin-B')).rejects.toThrow('unexpected failure');

    expect(walletService.releaseCollateral).toHaveBeenCalledWith('guarantor-wallet', '5000');
  });

  it('refuses to disburse a loan that is not in APPROVED status', async () => {
    prisma.loan.findUnique.mockResolvedValue({ ...approvedLoan, status: 'REQUESTED' });

    await expect(service.disburse('coop-1', 'loan-1', 'admin-B')).rejects.toThrow(ConflictException);
  });

  it('refuses to approve or reject a loan that is not in REQUESTED status', async () => {
    prisma.loan.findUnique.mockResolvedValue({ ...approvedLoan, status: 'ACTIVE' });

    await expect(service.approve('coop-1', 'loan-1', 'admin-A')).rejects.toThrow(ConflictException);
    await expect(service.reject('coop-1', 'loan-1', 'admin-A', 'some reason')).rejects.toThrow(ConflictException);
  });
});
