import { Body, Controller, Param, Patch, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RolesGuard } from '../common/guards/roles.guard';
import { BurstLimitGuard } from './guards/burst-limit.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { Audit } from '../common/decorators/audit.decorator';
import { AdminUsersService } from './admin-users.service';
import { AssignRoleDto } from './dto/assign-role.dto';

@ApiTags('Admin')
@ApiBearerAuth('access-token')
@UseGuards(RolesGuard, BurstLimitGuard)
@Roles('SUPER_ADMIN')
@Controller('admin/users')
export class AdminUsersController {
  constructor(private usersService: AdminUsersService) {}

  @Patch(':userId/role')
  @Audit({ action: 'ROLE_ASSIGNED', entityType: 'User' })
  @ApiOperation({
    summary: 'Assign a role to a user (SUPER_ADMIN only)',
    description:
      'This is the only way a COOPERATIVE_ADMIN or SUPER_ADMIN account gets created — there is no self-service path anywhere in the API for a user to grant themselves elevated privileges.',
  })
  async assignRole(@Param('userId') userId: string, @Body() dto: AssignRoleDto) {
    return this.usersService.assignRole(userId, dto);
  }
}
