import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class MembershipsService {
  constructor(private prisma: PrismaService) {}

  async joinCooperative(userId: string, cooperativeCode: string) {
    const cooperative = await this.prisma.cooperative.findUnique({
      where: { code: cooperativeCode },
    });
    if (!cooperative) {
      throw new NotFoundException('Cooperative code not recognized.');
    }

    // The @@unique([userId, cooperativeId]) constraint in the schema is the real
    // guarantee here — this check just produces a clean error message before
    // hitting that constraint on a duplicate join attempt.
    const existing = await this.prisma.membership.findUnique({
      where: { userId_cooperativeId: { userId, cooperativeId: cooperative.id } },
    });
    if (existing) {
      throw new ConflictException('You are already a member of this cooperative.');
    }

    const memberIdCode = await this.generateMemberIdCode(cooperative.id, cooperative.code);

    return this.prisma.membership.create({
      data: {
        userId,
        cooperativeId: cooperative.id,
        memberIdCode,
        status: 'ACTIVE',
      },
      include: { cooperative: true },
    });
  }

  // Returns only the requesting user's own memberships — this is intentional and
  // is the primary defense against one member seeing another member's cooperative
  // list. Every query in this service that touches Membership rows is scoped by
  // the authenticated userId, never by an ID coming from the request body/params.
  async getMyMemberships(userId: string) {
    return this.prisma.membership.findMany({
      where: { userId },
      include: { cooperative: true },
    });
  }

  // Verifies a given membership actually belongs to the given user before any
  // sensitive action (payment, loan request) is allowed to proceed against it.
  // This is the tenant-isolation check referenced throughout the security design —
  // called from the payments/loans modules, not just here.
  async assertMembershipOwnership(userId: string, membershipId: string) {
    const membership = await this.prisma.membership.findUnique({
      where: { id: membershipId },
    });
    if (!membership || membership.userId !== userId) {
      // Same error whether the membership doesn't exist or belongs to someone
      // else — never reveal which, to avoid leaking the existence of other
      // members' membership IDs via a distinguishable error message.
      throw new NotFoundException('Membership not found.');
    }
    return membership;
  }

  private async generateMemberIdCode(cooperativeId: string, cooperativeCode: string): Promise<string> {
    const count = await this.prisma.membership.count({ where: { cooperativeId } });
    const sequence = (count + 1).toString().padStart(4, '0');
    return `${cooperativeCode}-${sequence}`;
  }
}
