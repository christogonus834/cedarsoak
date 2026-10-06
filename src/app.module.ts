import { Module } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import configuration from './config/configuration';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { CooperativesModule } from './cooperatives/cooperatives.module';
import { MembershipsModule } from './memberships/memberships.module';
import { WalletModule } from './wallet/wallet.module';
import { PaymentsModule } from './payments/payments.module';
import { ContributionsModule } from './contributions/contributions.module';
import { NotificationsModule } from './notifications/notifications.module';
import { OtpModule } from './otp/otp.module';
import { AdminModule } from './admin/admin.module';
import { LoansModule } from './loans/loans.module';
import { RiskModule } from './risk/risk.module';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard';
import { AuditInterceptor } from './common/interceptors/audit.interceptor';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, load: [configuration] }),

    // Global default rate limit — every route gets this baseline even without an
    // explicit @Throttle() override. Specific high-risk endpoints (auth, payments)
    // apply their own stricter limits on top of this in their controllers.
    ThrottlerModule.forRoot([
      { name: 'default', ttl: 60_000, limit: 100 },
    ]),

    PrismaModule,
    AuthModule,
    UsersModule,
    CooperativesModule,
    MembershipsModule,
    WalletModule,
    PaymentsModule,
    ContributionsModule,
    NotificationsModule,
    OtpModule,
    AdminModule,
    LoansModule,
    RiskModule,
  ],
  providers: [
    // Order matters: rate limiting first, then authentication. Applied globally so
    // every new route is protected/limited by default — a developer has to
    // deliberately opt out (via @Public()), not deliberately opt in.
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_INTERCEPTOR, useClass: AuditInterceptor },
  ],
})
export class AppModule {}
