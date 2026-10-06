import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { CooperativeScopeGuard } from './guards/cooperative-scope.guard';
import { AdminDashboardService } from './admin-dashboard.service';

@ApiTags('Admin')
@ApiBearerAuth('access-token')
@ApiParam({ name: 'cooperativeId', description: 'A COOPERATIVE_ADMIN may only access their own cooperative; SUPER_ADMIN may access any.' })
@UseGuards(CooperativeScopeGuard)
@Controller('admin/cooperatives/:cooperativeId')
export class AdminDashboardController {
  constructor(private dashboardService: AdminDashboardService) {}

  @Get('dashboard')
  @ApiOperation({ summary: 'Dashboard summary: total members, contributed count, pending loans, overdue count' })
  async getDashboard(@Param('cooperativeId') cooperativeId: string) {
    return this.dashboardService.getDashboardSummary(cooperativeId);
  }

  @Get('members')
  @ApiOperation({ summary: "List all active members with each one's current-period contribution status" })
  async getMembers(@Param('cooperativeId') cooperativeId: string, @Query('period') period?: string) {
    return this.dashboardService.getMembers(cooperativeId, period);
  }

  @Get('members/overdue')
  @ApiOperation({ summary: 'List members with an overdue contribution for the given (or current) period' })
  async getOverdueMembers(@Param('cooperativeId') cooperativeId: string, @Query('period') period?: string) {
    return this.dashboardService.getOverdueMembers(cooperativeId, period);
  }

  @Get('payments/recent')
  @ApiOperation({ summary: 'Recent confirmed contribution payments, for admin oversight (payments are auto-confirmed; this is a read-only audit view, not an approval queue)' })
  async getRecentPayments(@Param('cooperativeId') cooperativeId: string) {
    return this.dashboardService.getRecentPayments(cooperativeId);
  }

  @Get('activity')
  @ApiOperation({ summary: 'Recent activity feed: payments, new members, and payment adjustments merged and sorted by time' })
  async getRecentActivity(@Param('cooperativeId') cooperativeId: string) {
    return this.dashboardService.getRecentActivity(cooperativeId);
  }
}
