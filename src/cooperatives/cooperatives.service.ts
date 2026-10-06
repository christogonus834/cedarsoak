import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateCooperativeDto } from './dto/create-cooperative.dto';

@Injectable()
export class CooperativesService {
  constructor(private prisma: PrismaService) {}

  async create(dto: CreateCooperativeDto) {
    const existing = await this.prisma.cooperative.findUnique({ where: { code: dto.code } });
    if (existing) {
      throw new ConflictException('A cooperative with this code already exists.');
    }

    return this.prisma.cooperative.create({
      data: {
        name: dto.name,
        code: dto.code,
        description: dto.description,
        location: dto.location,
        membershipFee: dto.membershipFee,
        contributionAmount: dto.contributionAmount,
      },
    });
  }

  // Used by the "Connect to Your Cooperative" flow — looking up a cooperative by
  // its public join code before a user confirms membership.
  async findByCode(code: string) {
    const cooperative = await this.prisma.cooperative.findUnique({ where: { code } });
    if (!cooperative) {
      throw new NotFoundException('This code links you directly to your existing Co-operative. This code was not found.');
    }
    return cooperative;
  }

  async findById(id: string) {
    const cooperative = await this.prisma.cooperative.findUnique({ where: { id } });
    if (!cooperative) throw new NotFoundException('Cooperative not found.');
    return cooperative;
  }
}
