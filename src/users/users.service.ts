import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class UsersService {
  constructor(private prisma: PrismaService) {}

  async getPublicProfile(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        phoneNumber: true,
        firstName: true,
        lastName: true,
        role: true,
        bvnVerified: true,
        createdAt: true,
        memberships: {
          select: {
            id: true,
            memberIdCode: true,
            status: true,
            cooperative: { select: { id: true, name: true } },
          },
        },
        // passwordHash is deliberately never selected here.
      },
    });

    if (!user) throw new NotFoundException('User not found.');
    return user;
  }
}
