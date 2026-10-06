import { Test } from '@nestjs/testing';
import { RiskService } from './risk.service';
import { PrismaService } from '../prisma/prisma.service';
import { ConfigService } from '@nestjs/config';

const RISK_CONFIG = {
  enabled: true,
  timezone: 'Africa/Lagos',
  quietHoursStart: 23,
  quietHoursEnd: 5,
  minBaselineEvents: 5,
  hourToleranceHours: 2,
};

describe('RiskService.evaluate', () => {
  let service: RiskService;
  let prisma: any;

  beforeEach(async () => {
    prisma = {
      deviceFingerprint: { findUnique: jest.fn() },
      loginEvent: { findMany: jest.fn().mockResolvedValue([]) },
      auditLog: { findFirst: jest.fn().mockResolvedValue(null) },
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        RiskService,
        { provide: PrismaService, useValue: prisma },
        { provide: ConfigService, useValue: { get: () => RISK_CONFIG } },
      ],
    }).compile();

    service = moduleRef.get(RiskService);
  });

  // A fixed, known-daytime moment so hour-of-day assertions are deterministic
  // regardless of when the test suite actually runs.
  const NOON_LAGOS = new Date('2026-01-15T12:00:00+01:00');

  it('a MEMBER with one signal (new device) is NOT challenged — members need two or more', async () => {
    prisma.deviceFingerprint.findUnique.mockResolvedValue(null); // new device
    prisma.loginEvent.findMany.mockResolvedValue([
      { ipPrefix: '10.0.0', hourOfDay: 12 }, // same network, same hour as now -> not a NEW_NETWORK or UNUSUAL_HOUR signal
    ]);

    const result = await service.evaluate({ id: 'user-1', role: 'MEMBER' }, { ipPrefix: '10.0.0', fingerprintHash: 'new-device' }, NOON_LAGOS);

    expect(result.reasons).toEqual(['NEW_DEVICE']);
    expect(result.challenge).toBe(false);
  });

  it('a MEMBER with two signals (new device AND new network) IS challenged', async () => {
    prisma.deviceFingerprint.findUnique.mockResolvedValue(null);
    prisma.loginEvent.findMany.mockResolvedValue([{ ipPrefix: '10.0.0', hourOfDay: 12 }]);

    const result = await service.evaluate(
      { id: 'user-1', role: 'MEMBER' },
      { ipPrefix: '99.99.99', fingerprintHash: 'new-device' }, // different network too
      NOON_LAGOS,
    );

    expect(result.reasons).toEqual(expect.arrayContaining(['NEW_DEVICE', 'NEW_NETWORK']));
    expect(result.challenge).toBe(true);
  });

  it('a COOPERATIVE_ADMIN with just ONE signal IS challenged — zero trust for privileged accounts', async () => {
    prisma.deviceFingerprint.findUnique.mockResolvedValue({ isTrusted: true }); // known device
    prisma.loginEvent.findMany.mockResolvedValue([{ ipPrefix: '10.0.0', hourOfDay: 12 }]);

    const result = await service.evaluate(
      { id: 'admin-1', role: 'COOPERATIVE_ADMIN' },
      { ipPrefix: '99.99.99', fingerprintHash: 'known-device' }, // only the network differs
      NOON_LAGOS,
    );

    expect(result.reasons).toEqual(['NEW_NETWORK']);
    expect(result.challenge).toBe(true);
  });

  it('an admin with a trusted device, known network, and normal hour is NOT challenged', async () => {
    prisma.deviceFingerprint.findUnique.mockResolvedValue({ isTrusted: true });
    prisma.loginEvent.findMany.mockResolvedValue([
      { ipPrefix: '10.0.0', hourOfDay: 12 },
      { ipPrefix: '10.0.0', hourOfDay: 13 },
      { ipPrefix: '10.0.0', hourOfDay: 11 },
      { ipPrefix: '10.0.0', hourOfDay: 12 },
      { ipPrefix: '10.0.0', hourOfDay: 14 },
    ]);

    const result = await service.evaluate(
      { id: 'admin-1', role: 'SUPER_ADMIN' },
      { ipPrefix: '10.0.0', fingerprintHash: 'known-device' },
      NOON_LAGOS,
    );

    expect(result.reasons).toEqual([]);
    expect(result.challenge).toBe(false);
  });

  it('a token-theft signal challenges EVERYONE, even a member with zero other signals', async () => {
    prisma.deviceFingerprint.findUnique.mockResolvedValue({ isTrusted: true });
    prisma.loginEvent.findMany.mockResolvedValue([{ ipPrefix: '10.0.0', hourOfDay: 12 }]);
    prisma.auditLog.findFirst.mockResolvedValue({ id: 'audit-1' }); // reuse detected recently

    const result = await service.evaluate(
      { id: 'user-1', role: 'MEMBER' },
      { ipPrefix: '10.0.0', fingerprintHash: 'known-device' },
      NOON_LAGOS,
    );

    expect(result.reasons).toContain('RECENT_TOKEN_THEFT_SIGNAL');
    expect(result.challenge).toBe(true);
  });

  it('before any login history exists, a MEMBER logging in late at night is NOT flagged for hour alone', async () => {
    prisma.deviceFingerprint.findUnique.mockResolvedValue({ isTrusted: true });
    prisma.loginEvent.findMany.mockResolvedValue([]); // no baseline at all

    const lateNight = new Date('2026-01-15T02:00:00+01:00'); // 2am WAT
    const result = await service.evaluate(
      { id: 'user-1', role: 'MEMBER' },
      { ipPrefix: '10.0.0', fingerprintHash: 'known-device' },
      lateNight,
    );

    expect(result.reasons).not.toContain('UNUSUAL_HOUR');
  });

  it('before any login history exists, an ADMIN logging in late at night IS flagged for hour', async () => {
    prisma.deviceFingerprint.findUnique.mockResolvedValue({ isTrusted: true });
    prisma.loginEvent.findMany.mockResolvedValue([]);

    const lateNight = new Date('2026-01-15T02:00:00+01:00');
    const result = await service.evaluate(
      { id: 'admin-1', role: 'COOPERATIVE_ADMIN' },
      { ipPrefix: '10.0.0', fingerprintHash: 'known-device' },
      lateNight,
    );

    expect(result.reasons).toContain('UNUSUAL_HOUR');
  });

  it('does nothing when risk checks are disabled via config', async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        RiskService,
        { provide: PrismaService, useValue: prisma },
        { provide: ConfigService, useValue: { get: () => ({ ...RISK_CONFIG, enabled: false }) } },
      ],
    }).compile();
    const disabledService = moduleRef.get(RiskService);

    const result = await disabledService.evaluate({ id: 'user-1', role: 'SUPER_ADMIN' }, { ipPrefix: null, fingerprintHash: null });
    expect(result).toEqual({ challenge: false, reasons: [] });
  });
});

describe('RiskService.isQuietHour', () => {
  let service: RiskService;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        RiskService,
        { provide: PrismaService, useValue: {} },
        { provide: ConfigService, useValue: { get: () => RISK_CONFIG } },
      ],
    }).compile();
    service = moduleRef.get(RiskService);
  });

  it('correctly handles the overnight wrap (23:00 -> 05:00)', () => {
    expect(service.isQuietHour(23)).toBe(true);
    expect(service.isQuietHour(2)).toBe(true);
    expect(service.isQuietHour(4)).toBe(true);
    expect(service.isQuietHour(5)).toBe(false);
    expect(service.isQuietHour(12)).toBe(false);
    expect(service.isQuietHour(22)).toBe(false);
  });
});
