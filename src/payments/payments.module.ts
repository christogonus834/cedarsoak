import { forwardRef, Module } from '@nestjs/common';
import { MonnifyProvider } from './providers/monnify.provider';
import { PaystackProvider } from './providers/paystack.provider';
import { VanProviderRegistry } from './van-provider-registry.service';
import { MonnifyWebhookController } from './webhooks/monnify-webhook.controller';
import { PaystackWebhookController } from './webhooks/paystack-webhook.controller';
import { MonnifyWebhookGuard } from './guards/monnify-webhook.guard';
import { PaystackWebhookGuard } from './guards/paystack-webhook.guard';
import { WalletModule } from '../wallet/wallet.module';

@Module({
  // forwardRef here because WalletService needs VanProviderRegistry (to
  // provision virtual accounts) and PaystackProvider (for withdrawals), while
  // the webhook controllers here need WalletService (to credit/resolve) — a
  // genuine two-way dependency between these two modules, resolved cleanly by
  // NestJS's forwardRef.
  imports: [forwardRef(() => WalletModule)],
  controllers: [MonnifyWebhookController, PaystackWebhookController],
  providers: [
    MonnifyProvider,
    PaystackProvider,
    VanProviderRegistry,
    MonnifyWebhookGuard,
    PaystackWebhookGuard,
  ],
  exports: [VanProviderRegistry, MonnifyProvider, PaystackProvider],
})
export class PaymentsModule {}
