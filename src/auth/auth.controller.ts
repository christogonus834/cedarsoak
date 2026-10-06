import { Body, Controller, HttpCode, HttpStatus, Post, Req } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { Public } from '../common/decorators/public.decorator';
import { CurrentUser, AuthUser } from '../common/decorators/current-user.decorator';
import { ClientContext } from '../common/decorators/client-context.decorator';
import { ClientContextData } from '../common/utils/client-context.util';
import { AuthService } from './auth.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { RefreshTokenDto } from './dto/refresh-token.dto';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { ConfirmLoginChallengeDto } from './dto/confirm-login-challenge.dto';

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(private authService: AuthService) {}

  @Public()
  @Post('register')
  @ApiOperation({
    summary: 'Create a new account',
    description: 'Returns an accessToken (15 min expiry) and a refreshToken (7 day expiry). No auth required.',
  })
  // Stricter than the global default — registration abuse (bulk fake accounts) is
  // a real risk, and this endpoint also does password hashing work, which is
  // deliberately slow (that's the point of argon2) and shouldn't be hammered.
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async register(@Body() dto: RegisterDto) {
    return this.authService.register(dto);
  }

  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiHeader({
    name: 'x-device-id',
    required: false,
    description: 'A stable, client-generated device identifier (e.g. a value persisted in secure storage). Used only as a risk signal for adaptive authentication — never trusted as identity on its own.',
  })
  @ApiOperation({
    summary: 'Log in with email and password',
    description:
      'No auth required. May return a token pair directly, OR { challengeRequired: true, challengeId } if the login looks unusual for this account — in the second case, no tokens exist yet and POST /auth/login/confirm must be called with the code sent to the account\'s email (and phone, for admin/staff) before any token is issued.',
  })
  // Tight limit here specifically — this is the classic brute-force target.
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async login(@Body() dto: LoginDto, @ClientContext() ctx: ClientContextData) {
    return this.authService.login(dto, ctx);
  }

  @Public()
  @Post('login/confirm')
  @HttpCode(HttpStatus.OK)
  @ApiHeader({ name: 'x-device-id', required: false, description: 'Send the SAME value used on the original login call.' })
  @ApiOperation({
    summary: 'Confirm a blocked login with the code sent to email/phone',
    description: 'Only needed when POST /auth/login returned challengeRequired: true. Issues a token pair on success and marks this device as trusted going forward.',
  })
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async confirmLogin(@Body() dto: ConfirmLoginChallengeDto, @ClientContext() ctx: ClientContextData) {
    return this.authService.confirmLoginChallenge({ challengeId: dto.challengeId, code: dto.code, ctx });
  }

  @Public()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Exchange a refresh token for a new token pair',
    description:
      'The refresh token used here is immediately revoked (rotation) — store the NEW refreshToken returned, the old one will no longer work. No auth header required.',
  })
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async refresh(@Body() dto: RefreshTokenDto) {
    return this.authService.refresh(dto.refreshToken);
  }

  @ApiBearerAuth('access-token')
  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Revoke the given refresh token, ending that session' })
  async logout(@CurrentUser() user: AuthUser, @Body() dto: RefreshTokenDto) {
    await this.authService.logout(user.userId, dto.refreshToken);
  }

  @Public()
  @Post('forgot-password')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Request a password reset code by email',
    description:
      'Always returns the same success message whether or not the email exists on the platform — this is intentional, to prevent an attacker from using this endpoint to discover which emails have accounts.',
  })
  // Tight limit: this endpoint sends an email/costs a Brevo API call per hit,
  // and is a natural target for enumeration or spam if left unthrottled.
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  async forgotPassword(@Body() dto: ForgotPasswordDto) {
    return this.authService.forgotPassword(dto.email);
  }

  @Public()
  @Post('reset-password')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Complete a password reset using the 6-digit code sent by email',
    description: 'On success, every existing session for this account is revoked — the user must log in again.',
  })
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async resetPassword(@Body() dto: ResetPasswordDto) {
    return this.authService.resetPassword(dto);
  }
}
