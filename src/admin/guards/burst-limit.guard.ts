import {
  CanActivate,
  ExecutionContext,
  Injectable,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';

// Applied to the highest-risk admin actions (payment reversal, loan
// approve/reject/disburse, role assignment, VAN provider switch). Counts how
// many AuditLog rows this admin has generated in the configured window —
// a sudden burst of sensitive actions is exactly the pattern a compromised
// admin account, or a script gone wrong, would produce, and it's a pattern
// the login-time risk checks can't see once a session is already active.
@Injectable()
export class BurstLimitGuard implements CanActivate {
  constructor(
    private prisma: PrismaService,
    private configService: ConfigService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const user = request.user;
    if (!user) return true; // JwtAuthGuard already handles unauthenticated requests

    const cfg = this.configService.get<{ burstLimit: number; burstWindowMinutes: number }>('risk');
    if (!cfg) return true;

    const windowStart = new Date(Date.now() - cfg.burstWindowMinutes * 60_000);
    const recentCount = await this.prisma.auditLog.count({
      where: { actorUserId: user.userId, createdAt: { gte: windowStart } },
    });

    if (recentCount >= cfg.burstLimit) {
      throw new HttpException(
        'Too many sensitive actions performed in a short time. This account is temporarily restricted — please wait a few minutes, or contact a super admin if this is unexpected.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    return true;
  }
}
