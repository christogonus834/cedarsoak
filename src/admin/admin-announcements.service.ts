import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { getCurrentPeriod } from '../common/utils/period.util';
import { AnnouncementAudience, CreateAnnouncementDto } from './dto/create-announcement.dto';

@Injectable()
export class AdminAnnouncementsService {
  private readonly logger = new Logger(AdminAnnouncementsService.name);

  constructor(
    private prisma: PrismaService,
    private notifications: NotificationsService,
  ) {}

  async create(cooperativeId: string, adminUserId: string, dto: CreateAnnouncementDto) {
    const announcement = await this.prisma.announcement.create({
      data: {
        cooperativeId,
        type: dto.type,
        subject: dto.subject,
        message: dto.message,
        createdByUserId: adminUserId,
      },
    });

    // NOTE ON SCHEDULING: "Schedule for later" from the design is not wired
    // to an actual job runner in this phase — sendImmediately=false saves the
    // announcement as an unsent draft (sentAt stays null) rather than
    // actually scheduling delivery. A cron/queue-based scheduler is flagged
    // as an open item for when this needs to be real.
    if (dto.sendImmediately !== false) {
      await this.dispatch(announcement.id, cooperativeId, dto);
    }

    return announcement;
  }

  private async dispatch(announcementId: string, cooperativeId: string, dto: CreateAnnouncementDto) {
    const recipients = await this.resolveRecipients(cooperativeId, dto);

    // Fire sequentially rather than Promise.all — bulk-emailing many
    // recipients concurrently risks tripping Brevo's own rate limits. This
    // is fine at cooperative scale (tens to low hundreds of members); if
    // this ever needs to scale to thousands, this is exactly the kind of
    // work that should move to the message queue from the system design
    // (background fan-out job), not stay inline in a request handler.
    for (const recipient of recipients) {
      await this.notifications.sendAlertEmail(recipient.email, dto.subject, dto.message);
    }

    await this.prisma.announcement.update({
      where: { id: announcementId },
      data: { sentAt: new Date() },
    });

    this.logger.log(`Announcement ${announcementId} sent to ${recipients.length} recipient(s).`);
  }

  private async resolveRecipients(
    cooperativeId: string,
    dto: CreateAnnouncementDto,
  ): Promise<{ email: string }[]> {
    if (dto.audience === AnnouncementAudience.ALL) {
      const memberships = await this.prisma.membership.findMany({
        where: { cooperativeId, status: 'ACTIVE' },
        include: { user: { select: { email: true } } },
      });
      return memberships.map((m) => ({ email: m.user.email }));
    }

    if (dto.audience === AnnouncementAudience.OVERDUE) {
      const period = getCurrentPeriod();
      const obligations = await this.prisma.contributionObligation.findMany({
        where: { period, status: 'OVERDUE', membership: { cooperativeId } },
        include: { membership: { include: { user: { select: { email: true } } } } },
      });
      return obligations.map((o) => ({ email: o.membership.user.email }));
    }

    // SPECIAL — a specific list of membership IDs, all re-verified to belong
    // to THIS cooperative before use, never trusted blindly from the request.
    const memberships = await this.prisma.membership.findMany({
      where: { cooperativeId, id: { in: dto.specialMembershipIds || [] } },
      include: { user: { select: { email: true } } },
    });
    return memberships.map((m) => ({ email: m.user.email }));
  }

  async list(cooperativeId: string) {
    return this.prisma.announcement.findMany({
      where: { cooperativeId },
      orderBy: { createdAt: 'desc' },
    });
  }
}
