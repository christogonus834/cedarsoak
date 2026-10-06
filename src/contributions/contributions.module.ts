import { Module } from '@nestjs/common';
import { ContributionsController } from './contributions.controller';
import { ContributionsService } from './contributions.service';
import { WalletModule } from '../wallet/wallet.module';
import { MembershipsModule } from '../memberships/memberships.module';

@Module({
  imports: [WalletModule, MembershipsModule],
  controllers: [ContributionsController],
  providers: [ContributionsService],
  exports: [ContributionsService],
})
export class ContributionsModule {}
