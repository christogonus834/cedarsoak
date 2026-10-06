import { Test } from '@nestjs/testing';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { LoansService } from './loans.service';
import { PrismaService } from '../prisma/prisma.service';
import { WalletService } from '../wallet/wallet.service';
import { MembershipsService } from '../memberships/memberships.service';

describe('LoansService.repayLoan', () => {
  let service: LoansService;
  let prisma: any;
  let walletService: any;

  const activeLoan = {
    id: 'loan-1',
    borrowerMembershipId: 'membership-1',
    guarantorMembershipId: 'guarantor-membership-1',
    amount: new Prisma.Decimal(5000),
    interestPercent: new Prisma.Decimal(0), // zero interest simplifies the outstanding-amount math for these tests
    disbursedAt: new Date(),
    status: 'ACTIVE',
  };

  beforeEach(async () => {
    prisma = {
      ledgerEntry: { findUnique: jest.fn().mockResolvedValue(null), aggregate: jest.fn(), create: jest.fn() },
      loan: { findUnique: jest.fn().mockResolvedValue(activeLoan), update: jest.fn() },
      membership: { findUniqueOrThrow: jest.fn() },
      wallet: { findUniqueOrThrow: jest.fn(), update: jest.fn() },
      $transaction: jest.fn(),
    };
    walletService = {
      getWalletByUserId: jest.fn().mockResolvedValue({ id: 'borrower-wallet' }),
      debitWithinTransaction: jest.fn(),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        LoansService,
        { provide: PrismaService, useValue: prisma },
        { provide: WalletService, useValue: walletService },
        { provide: MembershipsService, useValue: { assertMembershipOwnership: jest.fn() } },
      ],
    }).compile();

    service = moduleRef.get(LoansService);
  });

  it('rejects a repayment that exceeds the outstanding balance', async () => {
    prisma.ledgerEntry.aggregate.mockResolvedValue({ _sum: { amount: new Prisma.Decimal(0) } }); // nothing repaid yet, outstanding = 5000

    await expect(
      service.repayLoan('user-1', 'membership-1', 'loan-1', {
        amount: '5000.01',
        idempotencyKey: 'a1111111-1111-1111-1111-111111111111',
      }),
    ).rejects.toThrow('exceeds the outstanding balance');
  });

  it('rejects repaying a loan that is not ACTIVE', async () => {
    prisma.loan.findUnique.mockResolvedValue({ ...activeLoan, status: 'REPAID' });

    await expect(
      service.repayLoan('user-1', 'membership-1', 'loan-1', {
        amount: '100',
        idempotencyKey: 'a1111111-1111-1111-1111-111111111111',
      }),
    ).rejects.toThrow(ConflictException);
  });

  it('allows a partial repayment below the outstanding balance', async () => {
    prisma.ledgerEntry.aggregate.mockResolvedValue({ _sum: { amount: new Prisma.Decimal(0) } });
    prisma.$transaction.mockImplementation(async (callback: any) => {
      const tx = {
        ledgerEntry: { create: jest.fn().mockResolvedValue({ id: 'repayment-1' }) },
        loan: { update: jest.fn() },
        membership: { findUniqueOrThrow: jest.fn() },
        wallet: { findUniqueOrThrow: jest.fn(), update: jest.fn() },
      };
      walletService.debitWithinTransaction.mockResolvedValue({ id: 'debit-1' });
      return callback(tx);
    });

    const result = await service.repayLoan('user-1', 'membership-1', 'loan-1', {
      amount: '2000', // partial — well below the 5000 outstanding
      idempotencyKey: 'a1111111-1111-1111-1111-111111111111',
    });

    expect(result).toEqual({ id: 'repayment-1' });
  });

  it('marks the loan REPAID and releases guarantor collateral on a full repayment', async () => {
    prisma.ledgerEntry.aggregate.mockResolvedValue({ _sum: { amount: new Prisma.Decimal(0) } }); // outstanding = full 5000

    let loanUpdateCalled = false;
    let walletDecrementCalled = false;

    prisma.$transaction.mockImplementation(async (callback: any) => {
      const tx = {
        ledgerEntry: { create: jest.fn().mockResolvedValue({ id: 'repayment-final' }) },
        loan: {
          update: jest.fn().mockImplementation((args: any) => {
            loanUpdateCalled = true;
            expect(args.data.status).toBe('REPAID');
            return { ...activeLoan, status: 'REPAID' };
          }),
        },
        membership: { findUniqueOrThrow: jest.fn().mockResolvedValue({ userId: 'guarantor-user' }) },
        wallet: {
          findUniqueOrThrow: jest.fn().mockResolvedValue({ id: 'guarantor-wallet' }),
          update: jest.fn().mockImplementation((args: any) => {
            walletDecrementCalled = true;
            expect(args.data.lockedBalance.decrement).toEqual(activeLoan.amount);
            return {};
          }),
        },
      };
      walletService.debitWithinTransaction.mockResolvedValue({ id: 'debit-final' });
      return callback(tx);
    });

    const result = await service.repayLoan('user-1', 'membership-1', 'loan-1', {
      amount: '5000', // exactly the full outstanding amount
      idempotencyKey: 'a1111111-1111-1111-1111-111111111111',
    });

    expect(result).toEqual({ id: 'repayment-final' });
    expect(loanUpdateCalled).toBe(true);
    expect(walletDecrementCalled).toBe(true);
  });
});
