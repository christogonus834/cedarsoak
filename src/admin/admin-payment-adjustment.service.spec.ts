import { Test } from '@nestjs/testing';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AdminPaymentAdjustmentService } from './admin-payment-adjustment.service';
import { PrismaService } from '../prisma/prisma.service';
import { WalletService } from '../wallet/wallet.service';

describe('AdminPaymentAdjustmentService', () => {
  let service: AdminPaymentAdjustmentService;
  let prisma: any;
  let walletService: any;

  const cooperativeId = 'coop-1';
  const otherCooperativeId = 'coop-2';

  beforeEach(async () => {
    prisma = {
      ledgerEntry: { findUnique: jest.fn(), findFirst: jest.fn() },
      wallet: { findUniqueOrThrow: jest.fn() },
      contributionObligation: { findUnique: jest.fn() },
      auditLog: { create: jest.fn() },
      $transaction: jest.fn(),
    };
    walletService = { creditWithinTransaction: jest.fn() };

    const moduleRef = await Test.createTestingModule({
      providers: [
        AdminPaymentAdjustmentService,
        { provide: PrismaService, useValue: prisma },
        { provide: WalletService, useValue: walletService },
      ],
    }).compile();

    service = moduleRef.get(AdminPaymentAdjustmentService);
  });

  it('rejects when the ledger entry does not belong to this cooperative (never reveals it belongs to another)', async () => {
    prisma.ledgerEntry.findUnique.mockResolvedValue({
      id: 'entry-1',
      type: 'CONTRIBUTION_PAYMENT',
      membership: { cooperativeId: otherCooperativeId, userId: 'user-1' },
    });

    await expect(
      service.reverseContributionPayment({
        cooperativeId,
        ledgerEntryId: 'entry-1',
        adminUserId: 'admin-1',
        reason: 'Some reason here',
        memberConsentNote: 'Confirmed via phone call',
      }),
    ).rejects.toThrow(NotFoundException);
  });

  it('rejects reversing a non-CONTRIBUTION_PAYMENT entry', async () => {
    prisma.ledgerEntry.findUnique.mockResolvedValue({
      id: 'entry-1',
      type: 'LOAN_REPAYMENT',
      membership: { cooperativeId, userId: 'user-1' },
    });

    await expect(
      service.reverseContributionPayment({
        cooperativeId,
        ledgerEntryId: 'entry-1',
        adminUserId: 'admin-1',
        reason: 'Some reason here',
        memberConsentNote: 'Confirmed via phone call',
      }),
    ).rejects.toThrow('Only contribution payments can be reversed');
  });

  it('refuses to reverse a payment that has already been adjusted once', async () => {
    prisma.ledgerEntry.findUnique.mockResolvedValue({
      id: 'entry-1',
      type: 'CONTRIBUTION_PAYMENT',
      membershipId: 'membership-1',
      membership: { cooperativeId, userId: 'user-1' },
    });
    prisma.ledgerEntry.findFirst.mockResolvedValue({ id: 'existing-adjustment' }); // already adjusted

    await expect(
      service.reverseContributionPayment({
        cooperativeId,
        ledgerEntryId: 'entry-1',
        adminUserId: 'admin-1',
        reason: 'Some reason here',
        memberConsentNote: 'Confirmed via phone call',
      }),
    ).rejects.toThrow(ConflictException);
  });

  it('credits the wallet back and reopens the obligation on a valid first-time reversal', async () => {
    const originalEntry = {
      id: 'entry-1',
      type: 'CONTRIBUTION_PAYMENT',
      membershipId: 'membership-1',
      period: '2026-01',
      amount: new Prisma.Decimal(50000),
      membership: { cooperativeId, userId: 'user-1' },
    };
    prisma.ledgerEntry.findUnique.mockResolvedValue(originalEntry);
    prisma.ledgerEntry.findFirst.mockResolvedValue(null); // not yet adjusted
    prisma.wallet.findUniqueOrThrow.mockResolvedValue({ id: 'wallet-1' });
    prisma.contributionObligation.findUnique.mockResolvedValue({
      id: 'obligation-1',
      status: 'PAID',
    });

    prisma.$transaction.mockImplementation(async (callback: any) => {
      const tx = {
        ledgerEntry: { create: jest.fn().mockResolvedValue({ id: 'adjustment-1' }) },
        contributionObligation: { update: jest.fn().mockResolvedValue({ status: 'OVERDUE' }) },
      };
      walletService.creditWithinTransaction.mockResolvedValue({ id: 'credit-1' });
      return callback(tx);
    });

    const result = await service.reverseContributionPayment({
      cooperativeId,
      ledgerEntryId: 'entry-1',
      adminUserId: 'admin-1',
      reason: 'Member paid twice by mistake',
      memberConsentNote: 'Member confirmed via phone call',
    });

    expect(result).toEqual({ id: 'adjustment-1' });
    expect(walletService.creditWithinTransaction).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ walletId: 'wallet-1', amount: '50000', source: 'ADJUSTMENT' }),
    );
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          actorUserId: 'admin-1',
          action: 'PAYMENT_ADJUSTMENT',
        }),
      }),
    );
  });
});
