import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { Audit } from '../common/decorators/audit.decorator';
import { CooperativesService } from './cooperatives.service';
import { CreateCooperativeDto } from './dto/create-cooperative.dto';

@ApiTags('Cooperatives')
@ApiBearerAuth('access-token')
@Controller('cooperatives')
export class CooperativesController {
  constructor(private cooperativesService: CooperativesService) {}

  @Post()
  @UseGuards(RolesGuard)
  @Roles('SUPER_ADMIN')
  @Audit({ action: 'COOPERATIVE_CREATED', entityType: 'Cooperative' })
  @ApiOperation({ summary: 'Create a cooperative (SUPER_ADMIN only)' })
  async create(@Body() dto: CreateCooperativeDto) {
    return this.cooperativesService.create(dto);
  }

  @Get('by-code/:code')
  @ApiOperation({ summary: "Look up a cooperative by its public join code (e.g. 'CEDAROAKS123')" })
  async findByCode(@Param('code') code: string) {
    return this.cooperativesService.findByCode(code);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a cooperative by its internal ID' })
  async findById(@Param('id') id: string) {
    return this.cooperativesService.findById(id);
  }
}
