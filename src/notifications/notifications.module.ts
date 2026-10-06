import { Global, Module } from '@nestjs/common';
import { BrevoProvider } from './providers/brevo.provider';
import { NotificationsService } from './notifications.service';

// @Global() because notifications are a cross-cutting concern — the loan
// module, admin alerts, and announcement fan-out will all need to send
// email/SMS without each one re-importing this module individually. Matches
// the same pattern used for PrismaModule.
@Global()
@Module({
  providers: [BrevoProvider, NotificationsService],
  exports: [NotificationsService],
})
export class NotificationsModule {}
