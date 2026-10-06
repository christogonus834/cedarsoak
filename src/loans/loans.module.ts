import { Module } from '@nestjs/common';
import { WalletModule } from '../wallet/wallet.module';
import { MembershipsModule } from '../memberships/memberships.module';
import { LoansController } from './loans.controller';
import { LoansService } from './loans.service';

@Module({
  imports: [WalletModule, MembershipsModule],
  controllers: [LoansController],
  providers: [LoansService],
  exports: [LoansService], // AdminLoansService reuses computeOutstanding()
})
export class LoansModule {}
