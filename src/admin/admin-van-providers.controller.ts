import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RolesGuard } from '../common/guards/roles.guard';
import { BurstLimitGuard } from './guards/burst-limit.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { Audit } from '../common/decorators/audit.decorator';
import { CurrentUser, AuthUser } from '../common/decorators/current-user.decorator';
import { VanProviderRegistry } from '../payments/van-provider-registry.service';
import { SetActiveVanProviderDto } from './dto/set-active-van-provider.dto';

@ApiTags('Admin')
@ApiBearerAuth('access-token')
@UseGuards(RolesGuard, BurstLimitGuard)
@Roles('SUPER_ADMIN')
@Controller('admin/van-providers')
export class AdminVanProvidersController {
  constructor(private vanProviderRegistry: VanProviderRegistry) {}

  @Get('health')
  @ApiOperation({ summary: 'Health status of every registered VAN provider (SUPER_ADMIN only)' })
  async getHealth() {
    const [health, active] = await Promise.all([
      this.vanProviderRegistry.getAllProviderHealth(),
      this.vanProviderRegistry.getActiveProviderName(),
    ]);
    return { activeProvider: active, health };
  }

  @Post('active')
  @Audit({ action: 'VAN_PROVIDER_SWITCHED', entityType: 'PlatformSetting' })
  @ApiOperation({
    summary: 'Manually switch the active VAN provider (SUPER_ADMIN only)',
    description:
      'Affects new virtual account generation only — existing members\' already-issued accounts keep working under whichever provider issued them.',
  })
  async setActive(@CurrentUser() user: AuthUser, @Body() dto: SetActiveVanProviderDto) {
    return this.vanProviderRegistry.setActiveProvider(dto.providerName, user.userId);
  }
}
