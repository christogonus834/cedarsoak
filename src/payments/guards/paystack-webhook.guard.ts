import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { PaystackProvider } from '../providers/paystack.provider';

// Unlike Monnify, Paystack's own documentation and community references
// consistently show the `x-paystack-signature` header being present on every
// webhook delivery, including test-mode transactions — there is no
// documented sandbox exception here (verify this holds true in your own
// testing; if it turns out Paystack ever omits it in test mode too, apply
// the same environment-aware handling used in MonnifyWebhookGuard).
@Injectable()
export class PaystackWebhookGuard implements CanActivate {
  constructor(private paystackProvider: PaystackProvider) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const signature = request.headers['x-paystack-signature'] as string | undefined;
    const rawBody: Buffer | undefined = request.rawBody;

    if (!rawBody) {
      throw new UnauthorizedException('Unable to verify webhook signature.');
    }

    const isValid = this.paystackProvider.verifyWebhookSignature(rawBody, signature);
    if (!isValid) {
      throw new UnauthorizedException('Invalid webhook signature.');
    }

    return true;
  }
}
