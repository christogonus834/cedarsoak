import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { CurrentUser, AuthUser } from '../common/decorators/current-user.decorator';
import { Audit } from '../common/decorators/audit.decorator';
import { CooperativeScopeGuard } from './guards/cooperative-scope.guard';
import { AdminAnnouncementsService } from './admin-announcements.service';
import { CreateAnnouncementDto } from './dto/create-announcement.dto';

@ApiTags('Admin')
@ApiBearerAuth('access-token')
@ApiParam({ name: 'cooperativeId', description: 'A COOPERATIVE_ADMIN may only access their own cooperative; SUPER_ADMIN may access any.' })
@UseGuards(CooperativeScopeGuard)
@Controller('admin/cooperatives/:cooperativeId/announcements')
export class AdminAnnouncementsController {
  constructor(private announcementsService: AdminAnnouncementsService) {}

  @Post()
  @Audit({ action: 'ANNOUNCEMENT_SENT', entityType: 'Announcement' })
  @ApiOperation({
    summary: 'Create and send an announcement',
    description:
      "audience ALL sends to every active member; OVERDUE sends only to members overdue for the current period; SPECIAL requires specialMembershipIds, each re-verified server-side to belong to this cooperative. sendImmediately defaults to true — 'Schedule for later' is not yet wired to a real job runner, so setting it false just saves an unsent draft.",
  })
  async create(
    @CurrentUser() user: AuthUser,
    @Param('cooperativeId') cooperativeId: string,
    @Body() dto: CreateAnnouncementDto,
  ) {
    return this.announcementsService.create(cooperativeId, user.userId, dto);
  }

  @Get()
  @ApiOperation({ summary: 'List all announcements for this cooperative' })
  async list(@Param('cooperativeId') cooperativeId: string) {
    return this.announcementsService.list(cooperativeId);
  }
}
