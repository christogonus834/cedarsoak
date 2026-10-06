import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiQuery, ApiTags } from '@nestjs/swagger';
import { CurrentUser, AuthUser } from '../common/decorators/current-user.decorator';
import { Audit } from '../common/decorators/audit.decorator';
import { ContributionsService } from './contributions.service';
import { PayContributionDto } from './dto/pay-contribution.dto';

@ApiTags('Contributions')
@ApiBearerAuth('access-token')
@ApiParam({ name: 'membershipId', description: 'The membership id returned from POST /memberships/join' })
@Controller('memberships/:membershipId/contributions')
export class ContributionsController {
  constructor(private contributionsService: ContributionsService) {}

  @Get('summary')
  @ApiOperation({ summary: 'Get the exact amount owed for a period (defaults to the current month) — base amount, late penalty, and total due' })
  @ApiQuery({ name: 'period', required: false, description: 'YYYY-MM. Defaults to the current month.' })
  async getSummary(
    @CurrentUser() user: AuthUser,
    @Param('membershipId') membershipId: string,
    @Query('period') period?: string,
  ) {
    return this.contributionsService.getContributionSummary(user.userId, membershipId, period);
  }

  @Post('pay')
  @Audit({ action: 'CONTRIBUTION_PAID', entityType: 'LedgerEntry' })
  @ApiOperation({
    summary: 'Pay a contribution — amount must exactly match the summary\'s totalDue',
    description:
      'idempotencyKey must be a client-generated UUID, resent unchanged on any retry (e.g. after a dropped connection) so the same payment is never applied twice. The amount is validated server-side against the actual amount owed — any mismatch is rejected outright, no partial or excess payments are accepted.',
  })
  async pay(
    @CurrentUser() user: AuthUser,
    @Param('membershipId') membershipId: string,
    @Body() dto: PayContributionDto,
  ) {
    return this.contributionsService.payContribution(user.userId, membershipId, dto);
  }

  @Get('history')
  @ApiOperation({ summary: 'List past contribution payments for this membership' })
  async getHistory(@CurrentUser() user: AuthUser, @Param('membershipId') membershipId: string) {
    return this.contributionsService.getPaymentHistory(user.userId, membershipId);
  }
}
