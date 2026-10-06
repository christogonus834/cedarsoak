import {
  ConflictException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as argon2 from 'argon2';
import * as crypto from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { OtpService } from '../otp/otp.service';
import { NotificationsService } from '../notifications/notifications.service';
import { RiskService } from '../risk/risk.service';
import { ClientContextData } from '../common/utils/client-context.util';

// Exported (not just internal) because TypeScript's declaration emission
// (tsconfig has `declaration: true`) needs to be able to name every type used
// in a public method's return signature — AuthController.refresh() ultimately
// returns a shape built from this interface, and an unexported type there
// causes a "cannot be named" compile error.
export interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

@Injectable()
export class AuthService {
  constructor(
    private prisma: PrismaService,
    private jwtService: JwtService,
    private configService: ConfigService,
    private otpService: OtpService,
    private notifications: NotificationsService,
    private riskService: RiskService,
  ) {}

  async register(dto: RegisterDto) {
    // Check both unique fields up front for a clean error message — but the real
    // guarantee against a race condition is the unique constraint in the database
    // schema (see schema.prisma), not this check. Two simultaneous requests with
    // the same email will still be caught safely at the DB level even if both pass
    // this check at the same instant.
    const existing = await this.prisma.user.findFirst({
      where: { OR: [{ email: dto.email }, { phoneNumber: dto.phoneNumber }] },
    });
    if (existing) {
      throw new ConflictException('An account with this email or phone number already exists.');
    }

    // argon2id: the current recommended password hashing algorithm — resistant to
    // GPU cracking attempts in a way plain bcrypt with a low cost factor is not.
    const passwordHash = await argon2.hash(dto.password, { type: argon2.argon2id });

    const user = await this.prisma.user.create({
      data: {
        email: dto.email,
        phoneNumber: dto.phoneNumber,
        firstName: dto.firstName,
        lastName: dto.lastName,
        passwordHash,
      },
    });

    // A new wallet row is created immediately — dedicated virtual account number
    // generation (Monnify/backup provider) happens asynchronously in the wallet
    // module, not inline here, so registration isn't slowed down or made fragile
    // by a third-party API call.
    await this.prisma.wallet.create({ data: { userId: user.id } });

    // Fire-and-forget: NotificationsService.safely() already catches its own
    // errors internally, so a Brevo outage never blocks or fails a
    // registration that otherwise succeeded — the account is real either way.
    void this.notifications.sendWelcomeEmail(user.email, user.firstName);

    const tokens = await this.issueTokenPair(user.id, user.email, user.role);
    return { user: this.toPublicUser(user), ...tokens };
  }

  // ── Forgot / Reset Password ────────────────────────────────────────────
  async forgotPassword(email: string) {
    const user = await this.prisma.user.findUnique({ where: { email } });

    // CRITICAL: always return the same response whether or not the email
    // exists. Returning a different message ("no account found" vs "code
    // sent") would let an attacker enumerate which emails have accounts on
    // the platform — the same principle as login's identical invalid-
    // credentials message.
    if (user) {
      await this.otpService.generateAndSend({
        userId: user.id,
        destination: user.email,
        channel: 'EMAIL',
        purpose: 'PASSWORD_RESET',
      });
    }

    return { message: 'If an account exists for this email, a reset code has been sent.' };
  }

  async resetPassword(params: { email: string; code: string; newPassword: string }) {
    const user = await this.prisma.user.findUnique({ where: { email: params.email } });

    // Deliberately vague error — same reasoning as above. We still need to
    // actually run otpService.verify() with SOME destination to avoid a
    // timing side-channel that reveals whether the email exists (an
    // instant response vs. one that took time to hash/compare), so we
    // verify against the real destination either way and only branch after.
    const otpValid = await this.otpService
      .verify({ destination: params.email, purpose: 'PASSWORD_RESET', code: params.code })
      .catch(() => false);

    if (!user || !otpValid) {
      throw new UnauthorizedException('Invalid or expired code.');
    }

    const passwordHash = await argon2.hash(params.newPassword, { type: argon2.argon2id });

    await this.prisma.user.update({ where: { id: user.id }, data: { passwordHash } });

    // A password reset is exactly the kind of event that should invalidate
    // every existing session — if the account was compromised, this closes
    // out any session an attacker may have been holding via a stolen
    // refresh token.
    await this.prisma.refreshToken.updateMany({
      where: { userId: user.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });

    return { message: 'Password has been reset. Please log in again.' };
  }

  // Returns EITHER a token pair (login allowed outright) OR
  // { challengeRequired: true, challengeId } (login blocked pending a code
  // sent to the account's own email/phone). No tokens exist in the second
  // case — the controller must not assume a token pair is always returned.
  async login(dto: LoginDto, ctx: ClientContextData) {
    const user = await this.prisma.user.findUnique({ where: { email: dto.email } });

    // Deliberately identical error for "no such user" and "wrong password" — never
    // reveal which one it was, since that lets an attacker enumerate valid emails.
    const invalidCredentials = () =>
      new UnauthorizedException('Invalid email or password.');

    if (!user) throw invalidCredentials();

    const passwordValid = await argon2.verify(user.passwordHash, dto.password);
    if (!passwordValid) throw invalidCredentials();

    if (!user.isActive) {
      throw new UnauthorizedException('This account has been deactivated.');
    }

    const assessment = await this.riskService.evaluate(user, ctx);

    if (assessment.challenge) {
      await this.riskService.recordEvent({ userId: user.id, ctx, outcome: 'CHALLENGED', reasons: assessment.reasons });
      const challenge = await this.createLoginChallenge(user, ctx);
      return { challengeRequired: true as const, challengeId: challenge.id, reasons: assessment.reasons };
    }

    await this.riskService.recordEvent({ userId: user.id, ctx, outcome: 'SUCCESS', reasons: [] });
    // A login that passed without triggering any signal is itself evidence
    // this device belongs to the account — extend/renew its trust.
    await this.riskService.trustDevice(user.id, ctx.fingerprintHash);

    const tokens = await this.issueTokenPair(user.id, user.email, user.role);
    return { user: this.toPublicUser(user), ...tokens };
  }

  // Admin/staff get the code on BOTH email and phone (two independent codes,
  // either one works) for stronger assurance on privileged accounts; members
  // get email only, matching the lighter-touch policy for that tier.
  private async createLoginChallenge(user: { id: string; role: string; email: string; phoneNumber: string }, ctx: ClientContextData) {
    const expiryMinutes = this.configService.get<number>('otpExpiryMinutes') || 10;
    const challenge = await this.prisma.loginChallenge.create({
      data: {
        userId: user.id,
        fingerprint: ctx.fingerprintHash,
        ipPrefix: ctx.ipPrefix,
        reasons: [],
        expiresAt: new Date(Date.now() + expiryMinutes * 60_000),
      },
    });

    await this.otpService.generateAndSend({
      userId: user.id,
      destination: user.email,
      channel: 'EMAIL',
      purpose: 'LOGIN_VERIFICATION',
    });

    if (user.role !== 'MEMBER') {
      await this.otpService.generateAndSend({
        userId: user.id,
        destination: user.phoneNumber,
        channel: 'SMS',
        purpose: 'LOGIN_VERIFICATION',
      });
    }

    return challenge;
  }

  async confirmLoginChallenge(params: { challengeId: string; code: string; ctx: ClientContextData }) {
    const challenge = await this.prisma.loginChallenge.findUnique({ where: { id: params.challengeId } });

    if (!challenge || challenge.consumedAt || challenge.expiresAt < new Date()) {
      throw new UnauthorizedException('This login confirmation has expired or is no longer valid. Please log in again.');
    }

    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: challenge.userId } });

    // Try the email code first, then the phone code if one was sent —
    // whichever the person actually received and used.
    let verified = false;
    try {
      verified = await this.otpService.verify({ destination: user.email, purpose: 'LOGIN_VERIFICATION', code: params.code });
    } catch (err) {
      if (user.role !== 'MEMBER') {
        verified = await this.otpService.verify({ destination: user.phoneNumber, purpose: 'LOGIN_VERIFICATION', code: params.code });
      } else {
        throw err;
      }
    }

    if (!verified) {
      throw new UnauthorizedException('Incorrect code.');
    }

    await this.prisma.loginChallenge.update({ where: { id: challenge.id }, data: { consumedAt: new Date() } });
    await this.riskService.recordEvent({ userId: user.id, ctx: params.ctx, outcome: 'CHALLENGE_PASSED', reasons: [] });
    await this.riskService.trustDevice(user.id, params.ctx.fingerprintHash);

    const tokens = await this.issueTokenPair(user.id, user.email, user.role);
    return { user: this.toPublicUser(user), ...tokens };
  }

  async refresh(refreshToken: string) {
    const tokenHash = this.hashToken(refreshToken);

    const stored = await this.prisma.refreshToken.findUnique({
      where: { tokenHash },
      include: { user: true },
    });

    if (!stored) {
      throw new UnauthorizedException('Invalid or expired refresh token.');
    }

    // Refresh token *rotation* means every refresh invalidates the old token
    // and issues a brand new one. If a token that was ALREADY revoked is
    // presented again, that is not ordinary expiry — it means either the
    // legitimate token was reused after rotation (a client bug) or a stolen
    // copy is being used after the real one already moved on. We can't tell
    // those apart from here, so we treat it as a theft signal either way:
    // every active session is revoked and the account is forced through the
    // adaptive-auth challenge on its next login, rather than silently
    // trusting whichever side asks first.
    if (stored.revokedAt) {
      await this.handleRefreshTokenReuse(stored.userId, stored.id);
      throw new UnauthorizedException('Invalid or expired refresh token.');
    }

    if (stored.expiresAt < new Date()) {
      throw new UnauthorizedException('Invalid or expired refresh token.');
    }

    if (!stored.user.isActive) {
      throw new UnauthorizedException('This account has been deactivated.');
    }

    // Revoke the used token immediately (rotation) before issuing a new pair.
    await this.prisma.refreshToken.update({
      where: { id: stored.id },
      data: { revokedAt: new Date() },
    });

    return this.issueTokenPair(stored.user.id, stored.user.email, stored.user.role);
  }

  private async handleRefreshTokenReuse(userId: string, reusedTokenId: string) {
    await this.prisma.$transaction([
      this.prisma.refreshToken.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
      this.prisma.auditLog.create({
        data: {
          actorUserId: userId,
          action: 'REFRESH_TOKEN_REUSE_DETECTED',
          entityType: 'RefreshToken',
          entityId: reusedTokenId,
        },
      }),
    ]);
    // Every device stops being trusted — the next login is treated as a new
    // device regardless of which one it comes from, forcing re-verification.
    await this.riskService.untrustAllDevices(userId);
  }

  async logout(userId: string, refreshToken: string) {
    const tokenHash = this.hashToken(refreshToken);
    await this.prisma.refreshToken.updateMany({
      where: { userId, tokenHash, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  private async issueTokenPair(
    userId: string,
    email: string,
    role: string,
  ): Promise<TokenPair> {
    const accessToken = await this.jwtService.signAsync(
      { sub: userId, email, role },
      {
        secret: this.configService.get<string>('jwt.accessSecret'),
        expiresIn: this.configService.get<string>('jwt.accessExpiresIn'),
      },
    );

    // Refresh tokens are opaque random strings, NOT JWTs — we store only a hash of
    // them server-side (like a password). This means even a database leak doesn't
    // hand an attacker usable refresh tokens, and we can revoke individual tokens
    // by deleting/marking their row, which isn't possible with stateless JWTs.
    const rawRefreshToken = crypto.randomBytes(64).toString('hex');
    const tokenHash = this.hashToken(rawRefreshToken);

    const refreshExpiresInMs = this.parseDurationToMs(
      this.configService.get<string>('jwt.refreshExpiresIn') || '7d',
    );

    await this.prisma.refreshToken.create({
      data: {
        userId,
        tokenHash,
        expiresAt: new Date(Date.now() + refreshExpiresInMs),
      },
    });

    return { accessToken, refreshToken: rawRefreshToken };
  }

  private hashToken(token: string): string {
    return crypto.createHash('sha256').update(token).digest('hex');
  }

  private parseDurationToMs(duration: string): number {
    const match = duration.match(/^(\d+)([smhd])$/);
    if (!match) return 7 * 24 * 60 * 60 * 1000; // default 7 days
    const value = parseInt(match[1], 10);
    const unit = match[2];
    const multipliers: Record<string, number> = {
      s: 1000,
      m: 60 * 1000,
      h: 60 * 60 * 1000,
      d: 24 * 60 * 60 * 1000,
    };
    return value * multipliers[unit];
  }

  private toPublicUser(user: {
    id: string;
    email: string;
    firstName: string;
    lastName: string;
    role: string;
  }) {
    // Never return passwordHash or any internal field to the client, ever.
    return {
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      role: user.role,
    };
  }
}
