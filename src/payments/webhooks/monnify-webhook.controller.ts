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
import { MonnifyProvider } from '../providers/monnify.provider';
import { MonnifyWebhookGuard } from '../guards/monnify-webhook.guard';

@ApiExcludeController() // called by Monnify's servers, not by mobile/frontend clients
@Controller('webhooks/monnify')
export class MonnifyWebhookController {
  private readonly logger = new Logger(MonnifyWebhookController.name);

  constructor(
    private walletService: WalletService,
    private monnifyProvider: MonnifyProvider,
  ) {}

  @Public() // no JWT — MonnifyWebhookGuard is this route's actual security boundary
  @Post()
  @HttpCode(HttpStatus.OK)
  @UseGuards(MonnifyWebhookGuard)
  async handleWebhook(@Req() req: Request) {
    const payload = req.body as any;

    // We only act on successful-payment events. Other event types (e.g.
    // failed/reversed) are acknowledged with 200 but not processed further in
    // this phase — extend here if Monnify sends events we need to react to.
    const eventType = payload?.eventType;
    if (eventType !== 'SUCCESSFUL_TRANSACTION') {
      this.logger.log(`Ignoring Monnify webhook event type: ${eventType}`);
      return { received: true };
    }

    const providerReference: string | undefined =
      payload?.eventData?.transactionReference;
    const accountReference: string | undefined =
      payload?.eventData?.product?.reference;

    if (!providerReference || !accountReference) {
      // Malformed payload — reject rather than guessing at missing fields.
      throw new BadRequestException('Webhook payload missing required fields.');
    }

    // ── The critical step: never trust the webhook body alone. ──────────────
    // We re-query Monnify's own transaction endpoint using the reference from
    // the webhook, and only credit the wallet based on THAT independently
    // verified response — not the numbers the webhook happened to contain.
    // This defeats a forged webhook POST that guesses/reuses a reference,
    // since the forged request's claimed amount is never actually used.
    const verified = await this.monnifyProvider.verifyTransaction(providerReference);

    if (!verified.isSuccessful) {
      this.logger.warn(
        `Webhook claimed success but independent verification disagreed: ${providerReference}`,
      );
      // This exact mismatch is the "alert on any mismatch" control from our
      // security standard — wire this log line to your alerting pipeline.
      return { received: true, credited: false };
    }

    await this.walletService.creditFromVerifiedProviderTransaction({
      accountReference: verified.accountReference,
      amount: verified.amount,
      providerReference: verified.providerReference,
      provider: 'MONNIFY',
      raw: verified.raw,
    });

    return { received: true, credited: true };
  }
}
