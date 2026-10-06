import {
  BadRequestException,
  Controller,
  HttpCode,
  HttpStatus,
  Logger,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { Request } from 'express';
import { Public } from '../../common/decorators/public.decorator';
import { WalletService } from '../../wallet/wallet.service';
import { PaystackWebhookGuard } from '../guards/paystack-webhook.guard';

@ApiExcludeController() // called by Paystack's servers, not by mobile/frontend clients
@Controller('webhooks/paystack')
export class PaystackWebhookController {
  private readonly logger = new Logger(PaystackWebhookController.name);

  constructor(private walletService: WalletService) {}

  @Public()
  @Post()
  @HttpCode(HttpStatus.OK)
  @UseGuards(PaystackWebhookGuard)
  async handleWebhook(@Req() req: Request) {
    const payload = req.body as any;
    const event: string | undefined = payload?.event;

    // We only act on transfer lifecycle events here. Other Paystack events
    // (charge.success, etc.) aren't relevant to this endpoint in this build.
    if (!event?.startsWith('transfer.')) {
      return { received: true };
    }

    const reference: string | undefined = payload?.data?.reference;
    if (!reference) {
      throw new BadRequestException('Webhook payload missing transfer reference.');
    }

    // resolveWithdrawalFromWebhook does its own independent re-verification
    // against Paystack's API before touching the ledger — the event name in
    // this payload is a hint to go check, never itself sufficient grounds to
    // credit or finalize anything.
    await this.walletService.resolveWithdrawalFromWebhook(reference);

    return { received: true };
  }
}
