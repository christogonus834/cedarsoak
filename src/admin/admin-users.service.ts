import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AssignRoleDto, AssignableRole } from './dto/assign-role.dto';

@Injectable()
export class AdminUsersService {
  constructor(private prisma: PrismaService) {}

  // No self-service path exists anywhere in this codebase for a user to
  // grant themselves elevated privileges — this is the only way a
  // COOPERATIVE_ADMIN or SUPER_ADMIN account gets created, and it's
  // deliberately restricted to existing SUPER_ADMINs (enforced by the
  // controller's guard, not repeated here — but this method assumes it).
  async assignRole(targetUserId: string, dto: AssignRoleDto) {
    const user = await this.prisma.user.findUnique({ where: { id: targetUserId } });
    if (!user) {
      throw new NotFoundException('User not found.');
    }

    if (dto.role === AssignableRole.COOPERATIVE_ADMIN) {
      const cooperative = await this.prisma.cooperative.findUnique({ where: { id: dto.cooperativeId } });
      if (!cooperative) {
        throw new NotFoundException('Cooperative not found.');
      }
    }

    return this.prisma.user.update({
      where: { id: targetUserId },
      data: {
        role: dto.role,
        // Cleared unless the new role is COOPERATIVE_ADMIN — a MEMBER or
        // SUPER_ADMIN should never retain a leftover cooperative scope from
        // a previous role.
        adminOfCooperativeId: dto.role === AssignableRole.COOPERATIVE_ADMIN ? dto.cooperativeId : null,
      },
      select: { id: true, email: true, role: true, adminOfCooperativeId: true },
    });
  }
}
