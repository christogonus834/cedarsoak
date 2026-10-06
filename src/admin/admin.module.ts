import { Module } from '@nestjs/common';
import { WalletModule } from '../wallet/wallet.module';
import { PaymentsModule } from '../payments/payments.module';
import { AdminDashboardController } from './admin-dashboard.controller';
import { AdminDashboardService } from './admin-dashboard.service';
import { AdminAnnouncementsController } from './admin-announcements.controller';
import { AdminAnnouncementsService } from './admin-announcements.service';
import { AdminPaymentsController } from './admin-payments.controller';
import { AdminPaymentAdjustmentService } from './admin-payment-adjustment.service';
import { AdminUsersController } from './admin-users.controller';
import { AdminUsersService } from './admin-users.service';
import { AdminVanProvidersController } from './admin-van-providers.controller';
import { AdminLoansController } from './admin-loans.controller';
import { AdminLoansService } from './admin-loans.service';
import { CooperativeScopeGuard } from './guards/cooperative-scope.guard';
import { BurstLimitGuard } from './guards/burst-limit.guard';

@Module({
  // WalletModule: AdminPaymentAdjustmentService and AdminLoansService both
  // need WalletService (credit-back-on-reversal, and collateral lock/credit
  // on loan disbursement). PaymentsModule: AdminVanProvidersController needs
  // VanProviderRegistry. NotificationsService (used by the announcements
  // service) is @Global(), so no explicit import is needed for it.
  imports: [WalletModule, PaymentsModule],
  controllers: [
    AdminDashboardController,
    AdminAnnouncementsController,
    AdminPaymentsController,
    AdminUsersController,
    AdminVanProvidersController,
    AdminLoansController,
  ],
  providers: [
    AdminDashboardService,
    AdminAnnouncementsService,
    AdminPaymentAdjustmentService,
    AdminUsersService,
    AdminLoansService,
    CooperativeScopeGuard,
    BurstLimitGuard,
  ],
})
export class AdminModule {}
