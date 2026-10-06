import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MonnifyProvider } from '../providers/monnify.provider';

// This guard is the webhook route's ENTIRE authentication mechanism — there is
// no JWT here, since Monnify itself is calling this endpoint, not a logged-in
// user. Trust is established purely by verifying the HMAC signature against
// the raw request body. If this guard is ever bypassed or misconfigured, the
// webhook effectively becomes "anyone can credit any wallet by guessing an
// account reference" — treat changes to this file with proportional caution.
//
// IMPORTANT, CONFIRMED FROM MONNIFY'S OWN DOCS (developers.monnify.com/docs/webhooks):
// "the monnify-signature header is only included on webhook notifications
// sent in production, it is not present on sandbox notifications." This means
// a strict "always require a valid signature" guard would make sandbox
// testing completely impossible — every sandbox webhook would be rejected.
// We handle this explicitly rather than discovering it through a confusing
// stream of 401s during testing.
@Injectable()
export class MonnifyWebhookGuard implements CanActivate {
  private readonly logger = new Logger(MonnifyWebhookGuard.name);

  constructor(
    private monnifyProvider: MonnifyProvider,
    private configService: ConfigService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const signature = request.headers['monnify-signature'] as string | undefined;
    const rawBody: Buffer | undefined = request.rawBody;
    const isProduction = this.configService.get<string>('nodeEnv') === 'production';

    if (!rawBody) {
      // If this ever fires, raw body capturing isn't wired up correctly in
      // main.ts — fail closed, never fall back to verifying the parsed body.
      throw new UnauthorizedException('Unable to verify webhook signature.');
    }

    if (!signature) {
      if (isProduction) {
        // In production, Monnify ALWAYS sends this header — its absence here
        // means either a misconfiguration or a forged request. Reject.
        throw new UnauthorizedException('Missing webhook signature.');
      }
      // Sandbox: Monnify does not send this header at all, by design. We
      // cannot cryptographically verify the request, so we rely on the
      // webhook handler's OWN independent re-verification (a second, separate
      // call back to Monnify's transaction API) as the real safety net in
      // this environment — the signature check is simply not available here.
      // This is logged loudly so it's never mistaken for production behavior.
      this.logger.warn(
        'No monnify-signature header present — proceeding as SANDBOX. ' +
          'This must NEVER happen in production; verify nodeEnv/config if this appears unexpectedly.',
      );
      return true;
    }

    const isValid = this.monnifyProvider.verifyWebhookSignature(rawBody, signature);
    if (!isValid) {
      throw new UnauthorizedException('Invalid webhook signature.');
    }

    return true;
  }
}
