import { forwardRef, Module } from '@nestjs/common';
import { WalletController } from './wallet.controller';
import { WalletVirtualAccountController } from './wallet-virtual-account.controller';
import { WithdrawalController } from './withdrawal.controller';
import { WalletService } from './wallet.service';
import { PaymentsModule } from '../payments/payments.module';

@Module({
  imports: [forwardRef(() => PaymentsModule)],
  controllers: [WalletController, WalletVirtualAccountController, WithdrawalController],
  providers: [WalletService],
  // Exported deliberately — Phase 3 (payments) and Phase 5 (loans) will inject
  // WalletService directly rather than duplicating ledger logic anywhere else.
  // This is the one place credit()/debit() are allowed to be called from.
  exports: [WalletService],
})
export class WalletModule {}
