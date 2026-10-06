import { Test } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { WalletEntrySource } from '@prisma/client';
import { WalletService } from './wallet.service';
import { PrismaService } from '../prisma/prisma.service';
import { VanProviderRegistry } from '../payments/van-provider-registry.service';
import { PaystackProvider } from '../payments/providers/paystack.provider';

// These tests mock PrismaService entirely — no real database needed to run
// them. They exist to lock in the behaviors our design explicitly requires:
// derived balances, idempotent replay safety, and the insufficient-balance
// guard. If a future change breaks any of these, this suite should fail loudly.
//
// VanProviderRegistry and PaystackProvider are mocked as empty stubs here —
// this spec file only exercises the core ledger methods (credit/debit/
// getBalance), not the VAN provisioning or withdrawal flows, which have their
// own dedicated test coverage as those modules mature.
describe('WalletService', () => {
  let walletService: WalletService;
  let prisma: any;

  beforeEach(async () => {
    prisma = {
      walletLedgerEntry: {
        aggregate: jest.fn(),
        create: jest.fn(),
        findUnique: jest.fn(),
      },
      wallet: {
        findUniqueOrThrow: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn(),
      },
      $transaction: jest.fn(),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        WalletService,
        { provide: PrismaService, useValue: prisma },
        { provide: VanProviderRegistry, useValue: {} },
        { provide: PaystackProvider, useValue: {} },
      ],
    }).compile();

    walletService = moduleRef.get(WalletService);
  });

  describe('getBalance', () => {
    it('derives balance as total credits minus total debits', async () => {
      prisma.walletLedgerEntry.aggregate
        .mockResolvedValueOnce({ _sum: { amount: { minus: jest.fn() } } }) // placeholder, overridden below
        .mockResolvedValueOnce({ _sum: { amount: null } });

      // Simpler, explicit re-mock using real Prisma.Decimal-like behavior via
      // plain numbers wrapped in an object exposing .minus(), matching how the
      // real Prisma.Decimal API is used in the service.
      const Decimal = require('@prisma/client').Prisma.Decimal;
      prisma.walletLedgerEntry.aggregate
        .mockReset()
        .mockResolvedValueOnce({ _sum: { amount: new Decimal(500) } }) // credits
        .mockResolvedValueOnce({ _sum: { amount: new Decimal(200) } }); // debits

      const balance = await walletService.getBalance('wallet-1');
      expect(balance.toString()).toBe('300');
    });
  });

  describe('initiateWithdrawal', () => {
    it('credits the wallet back if the Paystack transfer call fails after the debit', async () => {
      const { Prisma } = require('@prisma/client');

      // Simulate a healthy debit (sufficient balance) inside $transaction.
      prisma.$transaction.mockImplementation(async (callback: any) => {
        const tx = {
          walletLedgerEntry: {
            aggregate: jest
              .fn()
              .mockResolvedValueOnce({ _sum: { amount: new Prisma.Decimal(5000) } })
              .mockResolvedValueOnce({ _sum: { amount: new Prisma.Decimal(0) } }),
            create: jest.fn().mockResolvedValue({ id: 'debit-entry-1' }),
          },
          wallet: {
            findUniqueOrThrow: jest.fn().mockResolvedValue({
              id: 'wallet-1',
              lockedBalance: new Prisma.Decimal(0),
            }),
          },
        };
        return callback(tx);
      });

      prisma.wallet.findUnique = jest.fn().mockResolvedValue({ id: 'wallet-1' });
      prisma.withdrawalRequest = {
        create: jest.fn().mockResolvedValue({ id: 'wr-1' }),
        update: jest.fn().mockResolvedValue({}),
      };

      const paystackProvider = {
        resolveAccount: jest.fn().mockResolvedValue({ accountName: 'Test User' }),
        createRecipient: jest.fn().mockRejectedValue(new Error('Paystack is down')),
      };

      const moduleRef = await Test.createTestingModule({
        providers: [
          WalletService,
          { provide: PrismaService, useValue: prisma },
          { provide: VanProviderRegistry, useValue: {} },
          { provide: PaystackProvider, useValue: paystackProvider },
        ],
      }).compile();

      const service = moduleRef.get(WalletService);

      // credit() will be called internally to reverse the debit — spy on it
      // to confirm it happens with the right shape, rather than re-mocking
      // the entire create() path a second time.
      const creditSpy = jest.spyOn(service, 'credit').mockResolvedValue({ id: 'reversal-1' } as any);

      await expect(
        service.initiateWithdrawal('user-1', {
          amount: '1000',
          bankAccountNumber: '0000000000',
          bankCode: '058',
        }),
      ).rejects.toThrow('We could not process your withdrawal right now');

      expect(creditSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          walletId: 'wallet-1',
          amount: '1000',
          source: WalletEntrySource.ADJUSTMENT,
        }),
      );
      expect(prisma.withdrawalRequest.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: 'FAILED' }) }),
      );
    });
  });

  describe('credit', () => {
    it('rejects a zero or negative amount before touching the database', async () => {
      await expect(
        walletService.credit({
          walletId: 'wallet-1',
          amount: '0',
          source: WalletEntrySource.VAN_FUNDING,
          idempotencyKey: 'key-1',
        }),
      ).rejects.toThrow(BadRequestException);

      expect(prisma.walletLedgerEntry.create).not.toHaveBeenCalled();
    });

    it('returns the original entry on an idempotent replay instead of erroring', async () => {
      const existingEntry = { id: 'entry-1', amount: '5000' };

      const { Prisma } = require('@prisma/client');
      const conflictError = Object.create(Prisma.PrismaClientKnownRequestError.prototype);
      conflictError.code = 'P2002';

      prisma.walletLedgerEntry.create.mockRejectedValueOnce(conflictError);
      prisma.walletLedgerEntry.findUnique.mockResolvedValueOnce(existingEntry);

      const result = await walletService.credit({
        walletId: 'wallet-1',
        amount: '5000',
        source: WalletEntrySource.VAN_FUNDING,
        idempotencyKey: 'duplicate-key',
      });

      expect(result).toEqual(existingEntry);
    });
  });

  describe('debit', () => {
    it('throws Insufficient wallet balance when the debit exceeds available funds', async () => {
      const { Prisma } = require('@prisma/client');

      prisma.$transaction.mockImplementation(async (callback: any) => {
        const tx = {
          walletLedgerEntry: {
            aggregate: jest
              .fn()
              .mockResolvedValueOnce({ _sum: { amount: new Prisma.Decimal(1000) } }) // credits
              .mockResolvedValueOnce({ _sum: { amount: new Prisma.Decimal(900) } }), // debits
            create: jest.fn(),
          },
          wallet: {
            findUniqueOrThrow: jest.fn().mockResolvedValue({
              id: 'wallet-1',
              lockedBalance: new Prisma.Decimal(0),
            }),
          },
        };
        return callback(tx);
      });

      // Available balance here is 1000 - 900 = 100, attempting to debit 5000.
      await expect(
        walletService.debit({
          walletId: 'wallet-1',
          amount: '5000',
          source: WalletEntrySource.COOPERATIVE_PAYMENT,
          idempotencyKey: 'debit-key-1',
        }),
      ).rejects.toThrow('Insufficient wallet balance.');
    });
  });
});
