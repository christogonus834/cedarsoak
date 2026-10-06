import { Test } from '@nestjs/testing';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ContributionsService } from './contributions.service';
import { PrismaService } from '../prisma/prisma.service';
import { WalletService } from '../wallet/wallet.service';
import { MembershipsService } from '../memberships/memberships.service';

// This suite locks in the single most explicit business rule from our design
// conversation: a member cannot pay more or less than the exact amount owed.
// If a future change breaks this, these tests should fail loudly.
describe('ContributionsService', () => {
  let service: ContributionsService;
  let prisma: any;
  let walletService: any;
  let membershipsService: any;

  const membership = { id: 'membership-1', userId: 'user-1', cooperativeId: 'coop-1' };
  const cooperative = {
    id: 'coop-1',
    contributionAmount: new Prisma.Decimal(50000),
    latePenaltyAmount: new Prisma.Decimal(500),
  };

  beforeEach(async () => {
    prisma = {
      ledgerEntry: { findUnique: jest.fn(), create: jest.fn(), findMany: jest.fn() },
      cooperative: { findUniqueOrThrow: jest.fn().mockResolvedValue(cooperative) },
      contributionObligation: { findUnique: jest.fn(), create: jest.fn(), update: jest.fn() },
      $transaction: jest.fn(),
    };

    walletService = {
      getWalletByUserId: jest.fn().mockResolvedValue({ id: 'wallet-1' }),
      debitWithinTransaction: jest.fn(),
    };

    membershipsService = {
      assertMembershipOwnership: jest.fn().mockResolvedValue(membership),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        ContributionsService,
        { provide: PrismaService, useValue: prisma },
        { provide: WalletService, useValue: walletService },
        { provide: MembershipsService, useValue: membershipsService },
      ],
    }).compile();

    service = moduleRef.get(ContributionsService);
  });

  function mockPendingObligation(overrides: Partial<any> = {}) {
    prisma.ledgerEntry.findUnique.mockResolvedValue(null); // no idempotent replay
    prisma.contributionObligation.findUnique.mockResolvedValue({
      id: 'obligation-1',
      status: 'PENDING',
      baseAmount: new Prisma.Decimal(50000),
      penaltyAmount: new Prisma.Decimal(0),
      ...overrides,
    });
  }

  it('rejects a payment for less than the exact amount owed', async () => {
    mockPendingObligation();

    await expect(
      service.payContribution('user-1', 'membership-1', {
        amount: '49999.99',
        idempotencyKey: 'a1111111-1111-1111-1111-111111111111',
      }),
    ).rejects.toThrow(BadRequestException);

    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('rejects a payment for more than the exact amount owed (no overpayment allowed)', async () => {
    mockPendingObligation();

    await expect(
      service.payContribution('user-1', 'membership-1', {
        amount: '50000.01',
        idempotencyKey: 'a1111111-1111-1111-1111-111111111111',
      }),
    ).rejects.toThrow('Partial or excess payments are not accepted.');
  });

  it('rejects payment entirely if the obligation is already marked PAID', async () => {
    mockPendingObligation({ status: 'PAID' });

    await expect(
      service.payContribution('user-1', 'membership-1', {
        amount: '50000.00',
        idempotencyKey: 'a1111111-1111-1111-1111-111111111111',
      }),
    ).rejects.toThrow(ConflictException);
  });

  it('includes the late penalty in the required exact amount when overdue', async () => {
    // Obligation already flagged OVERDUE with a penalty applied.
    mockPendingObligation({ status: 'OVERDUE', penaltyAmount: new Prisma.Decimal(500) });

    // Paying only the base amount (without the penalty) should be rejected.
    await expect(
      service.payContribution('user-1', 'membership-1', {
        amount: '50000.00',
        idempotencyKey: 'a1111111-1111-1111-1111-111111111111',
      }),
    ).rejects.toThrow('₦50500.00');
  });

  it('accepts a payment that exactly matches base + penalty, and commits all three writes atomically', async () => {
    mockPendingObligation({ status: 'OVERDUE', penaltyAmount: new Prisma.Decimal(500) });

    const fakeLedgerEntry = { id: 'ledger-1' };
    prisma.$transaction.mockImplementation(async (callback: any) => {
      const tx = {
        ledgerEntry: { create: jest.fn().mockResolvedValue(fakeLedgerEntry) },
        contributionObligation: { update: jest.fn().mockResolvedValue({}) },
      };
      walletService.debitWithinTransaction.mockResolvedValue({ id: 'debit-1' });
      return callback(tx);
    });

    const result = await service.payContribution('user-1', 'membership-1', {
      amount: '50500.00',
      idempotencyKey: 'a1111111-1111-1111-1111-111111111111',
    });

    expect(result).toEqual(fakeLedgerEntry);
    expect(walletService.debitWithinTransaction).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ walletId: 'wallet-1', amount: '50500.00' }),
    );
  });

  it('returns the existing ledger entry on an idempotent replay instead of re-processing', async () => {
    const existingEntry = { id: 'ledger-existing' };
    prisma.ledgerEntry.findUnique.mockResolvedValue(existingEntry);

    const result = await service.payContribution('user-1', 'membership-1', {
      amount: '50000.00',
      idempotencyKey: 'a1111111-1111-1111-1111-111111111111',
    });

    expect(result).toEqual(existingEntry);
    expect(prisma.contributionObligation.findUnique).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('rejects a request to pay for a future period', async () => {
    mockPendingObligation();
    const now = new Date();
    const futureYear = now.getFullYear() + 1;

    await expect(
      service.payContribution('user-1', 'membership-1', {
        amount: '50000.00',
        idempotencyKey: 'a1111111-1111-1111-1111-111111111111',
        period: `${futureYear}-01`,
      }),
    ).rejects.toThrow('Cannot pay a contribution for a future period.');
  });
});
