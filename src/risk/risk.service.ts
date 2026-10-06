import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { ClientContextData } from '../common/utils/client-context.util';

export type RiskReason = 'NEW_DEVICE' | 'NEW_NETWORK' | 'UNUSUAL_HOUR' | 'RECENT_TOKEN_THEFT_SIGNAL';

export interface RiskAssessment {
  challenge: boolean; // true = block login until confirmed
  reasons: RiskReason[];
}

interface RiskConfig {
  enabled: boolean;
  timezone: string;
  quietHoursStart: number;
  quietHoursEnd: number;
  minBaselineEvents: number;
  hourToleranceHours: number;
}

const SUCCESSFUL_OUTCOMES = ['SUCCESS', 'CHALLENGE_PASSED'];

// ── How risk is decided (all thresholds configurable, see configuration.ts) ──
//
// Four signals are computed from the account's OWN history, not from global
// rules — "unusual" only means something relative to what's normal for that
// account:
//   NEW_DEVICE                 the device id has not been confirmed as trusted
//   NEW_NETWORK                the network prefix has not appeared in a past successful login
//   UNUSUAL_HOUR               outside the hours this account normally logs in; before a
//                              baseline exists, admin/staff logins in the late-night window
//                              count as unusual
//   RECENT_TOKEN_THEFT_SIGNAL  a stolen/reused refresh token was detected in the last 24h
//
// Decision:
//   admin / staff -> ANY single signal blocks login ("zero trust" for privileged accounts)
//   members       -> TWO or more signals block login (lighter, to avoid locking out
//                    ordinary people who got a new phone or travelled)
//   a token-theft signal blocks login for everyone
//
// Honest limitation: the device id is client-supplied, so it is a signal, not
// proof. Its real protection comes from being combined with the other signals
// and, when anything looks off, a code sent to the account's own email/phone.
@Injectable()
export class RiskService {
  constructor(
    private prisma: PrismaService,
    private configService: ConfigService,
  ) {}

  private get cfg(): RiskConfig {
    return this.configService.get<RiskConfig>('risk') as RiskConfig;
  }

  async evaluate(
    user: { id: string; role: string },
    ctx: ClientContextData,
    now: Date = new Date(),
  ): Promise<RiskAssessment> {
    const cfg = this.cfg;
    if (!cfg.enabled) {
      return { challenge: false, reasons: [] };
    }

    const isPrivileged = user.role !== 'MEMBER';
    const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

    const [device, events, tokenTheftSignal] = await Promise.all([
      ctx.fingerprintHash
        ? this.prisma.deviceFingerprint.findUnique({
            where: { userId_fingerprint: { userId: user.id, fingerprint: ctx.fingerprintHash } },
          })
        : Promise.resolve(null),
      this.prisma.loginEvent.findMany({
        where: { userId: user.id, outcome: { in: SUCCESSFUL_OUTCOMES } },
        orderBy: { createdAt: 'desc' },
        take: 50,
      }),
      this.prisma.auditLog.findFirst({
        where: { actorUserId: user.id, action: 'REFRESH_TOKEN_REUSE_DETECTED', createdAt: { gte: dayAgo } },
      }),
    ]);

    const reasons: RiskReason[] = [];

    // A missing device id is treated as an unrecognised device — an absent
    // signal must never be an easy way to skip the check.
    if (!device || !device.isTrusted) {
      reasons.push('NEW_DEVICE');
    }

    if (!ctx.ipPrefix || !events.some((e) => e.ipPrefix === ctx.ipPrefix)) {
      reasons.push('NEW_NETWORK');
    }

    const hour = this.hourInTimezone(now);
    if (this.isUnusualHour(hour, events.map((e) => e.hourOfDay), isPrivileged)) {
      reasons.push('UNUSUAL_HOUR');
    }

    if (tokenTheftSignal) {
      reasons.push('RECENT_TOKEN_THEFT_SIGNAL');
    }

    const challenge =
      reasons.includes('RECENT_TOKEN_THEFT_SIGNAL') || (isPrivileged ? reasons.length >= 1 : reasons.length >= 2);

    return { challenge, reasons };
  }

  async recordEvent(params: {
    userId: string;
    ctx: ClientContextData;
    outcome: 'SUCCESS' | 'CHALLENGED' | 'CHALLENGE_PASSED';
    reasons: RiskReason[];
    now?: Date;
  }) {
    const now = params.now ?? new Date();
    return this.prisma.loginEvent.create({
      data: {
        userId: params.userId,
        ipPrefix: params.ctx.ipPrefix,
        fingerprint: params.ctx.fingerprintHash,
        hourOfDay: this.hourInTimezone(now),
        outcome: params.outcome,
        reasons: params.reasons,
      },
    });
  }

  // Marks a device as trusted (or refreshes it). Only called after a login
  // that was either low-risk-and-known or explicitly confirmed with a code.
  async trustDevice(userId: string, fingerprintHash: string | null) {
    if (!fingerprintHash) return;
    await this.prisma.deviceFingerprint.upsert({
      where: { userId_fingerprint: { userId, fingerprint: fingerprintHash } },
      create: { userId, fingerprint: fingerprintHash, isTrusted: true },
      update: { isTrusted: true, lastSeenAt: new Date() },
    });
  }

  // Used after a stolen-token signal: every device stops being trusted, so
  // the next login for that account is treated as coming from a new device.
  async untrustAllDevices(userId: string) {
    await this.prisma.deviceFingerprint.updateMany({ where: { userId }, data: { isTrusted: false } });
  }

  isQuietHour(hour: number): boolean {
    const { quietHoursStart: start, quietHoursEnd: end } = this.cfg;
    return start > end ? hour >= start || hour < end : hour >= start && hour < end; // handles the 23 -> 05 wrap
  }

  // Hour of day (0-23) in the configured business timezone, not the server's
  // own timezone — a server hosted abroad must not shift what "late night"
  // means for Nigerian users.
  hourInTimezone(date: Date): number {
    const formatted = new Intl.DateTimeFormat('en-GB', {
      hour: 'numeric',
      hourCycle: 'h23',
      timeZone: this.cfg.timezone,
    }).format(date);
    return parseInt(formatted, 10) % 24;
  }

  private isUnusualHour(currentHour: number, pastHours: number[], isPrivileged: boolean): boolean {
    const { minBaselineEvents, hourToleranceHours } = this.cfg;

    if (pastHours.length >= minBaselineEvents) {
      // Enough history to judge: unusual = no past login within the
      // tolerance window of this hour (measured around the clock).
      return !pastHours.some((h) => this.circularHourDistance(h, currentHour) <= hourToleranceHours);
    }

    // Not enough history yet. Members are not judged; privileged accounts
    // fall back to the fixed late-night window rather than getting a free pass.
    return isPrivileged && this.isQuietHour(currentHour);
  }

  private circularHourDistance(a: number, b: number): number {
    const diff = Math.abs(a - b);
    return Math.min(diff, 24 - diff);
  }
}
