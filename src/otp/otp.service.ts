import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';

const MAX_VERIFICATION_ATTEMPTS = 5;

@Injectable()
export class OtpService {
  constructor(
    private prisma: PrismaService,
    private notifications: NotificationsService,
    private configService: ConfigService,
  ) {}

  // Generates a 6-digit numeric code, hashes it before storage (same
  // discipline as passwords — a database leak should never hand out usable
  // OTP codes), and sends it via the requested channel. Any previous
  // unconsumed OTP for the same user+purpose is left in place but becomes
  // irrelevant once a new one is issued, since verify() always checks
  // against the newest one.
  async generateAndSend(params: {
    userId?: string;
    destination: string;
    channel: 'EMAIL' | 'SMS';
    purpose: string;
  }) {
    const code = this.generateNumericCode(6);
    const codeHash = this.hashCode(code);
    const expiryMinutes = this.configService.get<number>('otpExpiryMinutes') || 10;

    await this.prisma.otp.create({
      data: {
        userId: params.userId,
        destination: params.destination,
        channel: params.channel,
        purpose: params.purpose,
        codeHash,
        expiresAt: new Date(Date.now() + expiryMinutes * 60_000),
      },
    });

    if (params.channel === 'EMAIL') {
      await this.notifications.sendOtpEmail(params.destination, code, params.purpose);
    } else {
      await this.notifications.sendOtpSms(params.destination, code, params.purpose);
    }
  }

  // Verifies against the MOST RECENT unconsumed, unexpired OTP for this
  // destination+purpose. Rate-limited per-OTP (not just per-endpoint) via
  // `attempts` — five wrong guesses invalidates that OTP entirely, closing
  // the window for someone to brute-force a 6-digit code across many tries.
  async verify(params: { destination: string; purpose: string; code: string }): Promise<boolean> {
    const otp = await this.prisma.otp.findFirst({
      where: { destination: params.destination, purpose: params.purpose, consumedAt: null },
      orderBy: { createdAt: 'desc' },
    });

    if (!otp) {
      throw new BadRequestException('No active verification code found. Please request a new one.');
    }

    if (otp.expiresAt < new Date()) {
      throw new BadRequestException('This code has expired. Please request a new one.');
    }

    if (otp.attempts >= MAX_VERIFICATION_ATTEMPTS) {
      throw new BadRequestException('Too many incorrect attempts. Please request a new code.');
    }

    const providedHash = this.hashCode(params.code);
    const isValid = crypto.timingSafeEqual(
      Buffer.from(providedHash),
      Buffer.from(otp.codeHash),
    );

    if (!isValid) {
      await this.prisma.otp.update({ where: { id: otp.id }, data: { attempts: { increment: 1 } } });
      throw new BadRequestException('Incorrect code.');
    }

    await this.prisma.otp.update({ where: { id: otp.id }, data: { consumedAt: new Date() } });
    return true;
  }

  private generateNumericCode(length: number): string {
    // crypto.randomInt is cryptographically secure — Math.random() would NOT
    // be appropriate here, since a predictable OTP defeats the entire point.
    const max = 10 ** length;
    const code = crypto.randomInt(0, max);
    return code.toString().padStart(length, '0');
  }

  private hashCode(code: string): string {
    // SHA-256 (not argon2) is intentional here: OTP codes are short-lived
    // (minutes) and low-entropy by nature (6 digits), so the slow,
    // memory-hard properties argon2 provides for passwords aren't the
    // relevant defense — the real protections are the attempt limit above
    // and the short expiry window, not hash slowness.
    return crypto.createHash('sha256').update(code).digest('hex');
  }
}
