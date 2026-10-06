import { Test } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import * as crypto from 'crypto';
import { OtpService } from './otp.service';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { ConfigService } from '@nestjs/config';

function sha256(value: string) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

describe('OtpService', () => {
  let service: OtpService;
  let prisma: any;

  beforeEach(async () => {
    prisma = {
      otp: { create: jest.fn(), findFirst: jest.fn(), update: jest.fn() },
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        OtpService,
        { provide: PrismaService, useValue: prisma },
        { provide: NotificationsService, useValue: { sendOtpEmail: jest.fn(), sendOtpSms: jest.fn() } },
        { provide: ConfigService, useValue: { get: () => 10 } },
      ],
    }).compile();

    service = moduleRef.get(OtpService);
  });

  it('rejects verification when no active OTP exists for the destination', async () => {
    prisma.otp.findFirst.mockResolvedValue(null);

    await expect(
      service.verify({ destination: 'a@b.com', purpose: 'PASSWORD_RESET', code: '123456' }),
    ).rejects.toThrow('No active verification code found');
  });

  it('rejects an expired OTP even if the code is otherwise correct', async () => {
    prisma.otp.findFirst.mockResolvedValue({
      id: 'otp-1',
      codeHash: sha256('123456'),
      expiresAt: new Date(Date.now() - 1000), // already expired
      attempts: 0,
    });

    await expect(
      service.verify({ destination: 'a@b.com', purpose: 'PASSWORD_RESET', code: '123456' }),
    ).rejects.toThrow('expired');
  });

  it('rejects and increments attempts on a wrong code', async () => {
    prisma.otp.findFirst.mockResolvedValue({
      id: 'otp-1',
      codeHash: sha256('123456'),
      expiresAt: new Date(Date.now() + 60_000),
      attempts: 0,
    });

    await expect(
      service.verify({ destination: 'a@b.com', purpose: 'PASSWORD_RESET', code: '999999' }),
    ).rejects.toThrow('Incorrect code');

    expect(prisma.otp.update).toHaveBeenCalledWith({
      where: { id: 'otp-1' },
      data: { attempts: { increment: 1 } },
    });
  });

  it('blocks further attempts once the max attempt count is reached, even with the right code', async () => {
    prisma.otp.findFirst.mockResolvedValue({
      id: 'otp-1',
      codeHash: sha256('123456'),
      expiresAt: new Date(Date.now() + 60_000),
      attempts: 5, // already at the limit
    });

    await expect(
      service.verify({ destination: 'a@b.com', purpose: 'PASSWORD_RESET', code: '123456' }),
    ).rejects.toThrow('Too many incorrect attempts');
  });

  it('accepts a correct, unexpired code and marks it consumed', async () => {
    prisma.otp.findFirst.mockResolvedValue({
      id: 'otp-1',
      codeHash: sha256('123456'),
      expiresAt: new Date(Date.now() + 60_000),
      attempts: 0,
    });

    const result = await service.verify({
      destination: 'a@b.com',
      purpose: 'PASSWORD_RESET',
      code: '123456',
    });

    expect(result).toBe(true);
    expect(prisma.otp.update).toHaveBeenCalledWith({
      where: { id: 'otp-1' },
      data: { consumedAt: expect.any(Date) },
    });
  });
});
