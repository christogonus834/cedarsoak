import { Test } from '@nestjs/testing';
import { UnauthorizedException } from '@nestjs/common';
import { AuthService } from './auth.service';
import { PrismaService } from '../prisma/prisma.service';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { OtpService } from '../otp/otp.service';
import { NotificationsService } from '../notifications/notifications.service';
import { RiskService } from '../risk/risk.service';

describe('AuthService.refresh — reuse detection', () => {
  let service: AuthService;
  let prisma: any;
  let riskService: any;

  const activeUser = { id: 'user-1', email: 'a@b.com', role: 'MEMBER', isActive: true };

  beforeEach(async () => {
    prisma = {
      refreshToken: { findUnique: jest.fn(), update: jest.fn(), updateMany: jest.fn(), create: jest.fn() },
      auditLog: { create: jest.fn() },
      $transaction: jest.fn((ops: any[]) => Promise.all(ops)),
    };
    riskService = { untrustAllDevices: jest.fn() };

    const moduleRef = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: PrismaService, useValue: prisma },
        { provide: JwtService, useValue: { signAsync: jest.fn().mockResolvedValue('signed-jwt') } },
        { provide: ConfigService, useValue: { get: (k: string) => (k === 'jwt.refreshExpiresIn' ? '7d' : 'secret') } },
        { provide: OtpService, useValue: {} },
        { provide: NotificationsService, useValue: {} },
        { provide: RiskService, useValue: riskService },
      ],
    }).compile();

    service = moduleRef.get(AuthService);
  });

  it('throws on a token that does not exist at all, with NO reuse handling triggered', async () => {
    prisma.refreshToken.findUnique.mockResolvedValue(null);

    await expect(service.refresh('unknown-token')).rejects.toThrow(UnauthorizedException);
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
    expect(riskService.untrustAllDevices).not.toHaveBeenCalled();
  });

  it('treats a REUSED (already revoked) token as a theft signal: revokes all sessions and logs it', async () => {
    prisma.refreshToken.findUnique.mockResolvedValue({
      id: 'token-1',
      userId: 'user-1',
      revokedAt: new Date(), // already used once before
      expiresAt: new Date(Date.now() + 100_000),
      user: activeUser,
    });

    await expect(service.refresh('reused-token')).rejects.toThrow(UnauthorizedException);

    expect(prisma.refreshToken.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: 'user-1', revokedAt: null } }),
    );
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ actorUserId: 'user-1', action: 'REFRESH_TOKEN_REUSE_DETECTED' }),
      }),
    );
    expect(riskService.untrustAllDevices).toHaveBeenCalledWith('user-1');
  });

  it('a merely EXPIRED (never-reused) token does NOT trigger reuse handling', async () => {
    prisma.refreshToken.findUnique.mockResolvedValue({
      id: 'token-1',
      userId: 'user-1',
      revokedAt: null,
      expiresAt: new Date(Date.now() - 1000), // expired, but never revoked/reused
      user: activeUser,
    });

    await expect(service.refresh('expired-token')).rejects.toThrow(UnauthorizedException);

    expect(prisma.auditLog.create).not.toHaveBeenCalled();
    expect(riskService.untrustAllDevices).not.toHaveBeenCalled();
  });

  it('a valid, unused, unexpired token is rotated normally', async () => {
    prisma.refreshToken.findUnique.mockResolvedValue({
      id: 'token-1',
      userId: 'user-1',
      revokedAt: null,
      expiresAt: new Date(Date.now() + 100_000),
      user: activeUser,
    });

    const result = await service.refresh('valid-token');

    expect(prisma.refreshToken.update).toHaveBeenCalledWith({
      where: { id: 'token-1' },
      data: { revokedAt: expect.any(Date) },
    });
    expect(result.accessToken).toBe('signed-jwt');
    expect(riskService.untrustAllDevices).not.toHaveBeenCalled();
  });
});
