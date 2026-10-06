import { Test } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { LoansService } from './loans.service';
import { PrismaService } from '../prisma/prisma.service';
import { WalletService } from '../wallet/wallet.service';
import { MembershipsService } from '../memberships/memberships.service';

describe('LoansService.requestLoan', () => {
  let service: LoansService;
  let prisma: any;
  let walletService: any;
  let membershipsService: any;

  const borrowerMembership = { id: 'borrower-1', userId: 'borrower-user', cooperativeId: 'coop-1' };
  const cooperative = {
    id: 'coop-1',
    loanMultiplier: new Prisma.Decimal(2),
    loanInterestPercent: new Prisma.Decimal(2),
  };

  beforeEach(async () => {
    prisma = {
      cooperative: { findUniqueOrThrow: jest.fn().mockResolvedValue(cooperative) },
      membership: { findUnique: jest.fn() },
      loan: { create: jest.fn() },
    };
    walletService = {
      getWalletByUserId: jest.fn(),
      getAvailableBalance: jest.fn(),
    };
    membershipsService = {
      assertMembershipOwnership: jest.fn().mockResolvedValue(borrowerMembership),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        LoansService,
        { provide: PrismaService, useValue: prisma },
        { provide: WalletService, useValue: walletService },
        { provide: MembershipsService, useValue: membershipsService },
      ],
    }).compile();

    service = moduleRef.get(LoansService);
  });

  it('rejects a loan request exceeding 2x the borrower\'s available balance', async () => {
    walletService.getWalletByUserId.mockResolvedValue({ id: 'wallet-borrower' });
    walletService.getAvailableBalance.mockResolvedValue(new Prisma.Decimal(10000)); // max = 20,000

    await expect(
      service.requestLoan('borrower-user', 'borrower-1', {
        amount: '20000.01',
        guarantorMembershipId: 'guarantor-1',
      }),
    ).rejects.toThrow('exceeds your maximum eligible loan');
  });

  it('rejects when the guarantor is the borrower\'s own membership', async () => {
    walletService.getWalletByUserId.mockResolvedValue({ id: 'wallet-borrower' });
    walletService.getAvailableBalance.mockResolvedValue(new Prisma.Decimal(10000));

    await expect(
      service.requestLoan('borrower-user', 'borrower-1', {
        amount: '5000',
        guarantorMembershipId: 'borrower-1', // same as their own membership
      }),
    ).rejects.toThrow('cannot guarantee your own loan');
  });

  it('rejects when the guarantor membership does not exist in the same cooperative', async () => {
    walletService.getWalletByUserId.mockResolvedValue({ id: 'wallet-borrower' });
    walletService.getAvailableBalance.mockResolvedValue(new Prisma.Decimal(10000));
    prisma.membership.findUnique.mockResolvedValue({
      id: 'guarantor-1',
      cooperativeId: 'DIFFERENT-COOP',
      status: 'ACTIVE',
      userId: 'guarantor-user',
    });

    await expect(
      service.requestLoan('borrower-user', 'borrower-1', {
        amount: '5000',
        guarantorMembershipId: 'guarantor-1',
      }),
    ).rejects.toThrow(NotFoundException);
  });

  it('rejects when the guarantor has insufficient available balance to cover the loan', async () => {
    walletService.getWalletByUserId
      .mockResolvedValueOnce({ id: 'wallet-borrower' }) // borrower
      .mockResolvedValueOnce({ id: 'wallet-guarantor' }); // guarantor
    walletService.getAvailableBalance
      .mockResolvedValueOnce(new Prisma.Decimal(10000)) // borrower available (max loan = 20,000)
      .mockResolvedValueOnce(new Prisma.Decimal(4999)); // guarantor available — less than requested 5000

    prisma.membership.findUnique.mockResolvedValue({
      id: 'guarantor-1',
      cooperativeId: 'coop-1',
      status: 'ACTIVE',
      userId: 'guarantor-user',
    });

    await expect(
      service.requestLoan('borrower-user', 'borrower-1', {
        amount: '5000',
        guarantorMembershipId: 'guarantor-1',
      }),
    ).rejects.toThrow('does not have sufficient available savings');
  });

  it('creates the loan as REQUESTED (no collateral locked yet) when everything checks out', async () => {
    walletService.getWalletByUserId
      .mockResolvedValueOnce({ id: 'wallet-borrower' })
      .mockResolvedValueOnce({ id: 'wallet-guarantor' });
    walletService.getAvailableBalance
      .mockResolvedValueOnce(new Prisma.Decimal(10000))
      .mockResolvedValueOnce(new Prisma.Decimal(5000));

    prisma.membership.findUnique.mockResolvedValue({
      id: 'guarantor-1',
      cooperativeId: 'coop-1',
      status: 'ACTIVE',
      userId: 'guarantor-user',
    });
    prisma.loan.create.mockResolvedValue({ id: 'loan-1', status: 'REQUESTED' });

    const result = await service.requestLoan('borrower-user', 'borrower-1', {
      amount: '5000',
      guarantorMembershipId: 'guarantor-1',
    });

    expect(result.status).toBe('REQUESTED');
    expect(prisma.loan.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'REQUESTED', amount: '5000' }),
      }),
    );
  });
});
