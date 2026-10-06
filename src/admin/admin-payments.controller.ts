import { Body, Controller, Param, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { CurrentUser, AuthUser } from '../common/decorators/current-user.decorator';
import { Audit } from '../common/decorators/audit.decorator';
import { CooperativeScopeGuard } from './guards/cooperative-scope.guard';
import { BurstLimitGuard } from './guards/burst-limit.guard';
import { AdminPaymentAdjustmentService } from './admin-payment-adjustment.service';
import { AdjustPaymentDto } from './dto/adjust-payment.dto';

@ApiTags('Admin')
@ApiBearerAuth('access-token')
@ApiParam({ name: 'cooperativeId', description: 'A COOPERATIVE_ADMIN may only access their own cooperative; SUPER_ADMIN may access any.' })
@UseGuards(CooperativeScopeGuard, BurstLimitGuard)
@Controller('admin/cooperatives/:cooperativeId/payments')
export class AdminPaymentsController {
  constructor(private adjustmentService: AdminPaymentAdjustmentService) {}

  @Post(':ledgerEntryId/reverse')
  @Audit({ action: 'PAYMENT_ADJUSTMENT', entityType: 'LedgerEntry' })
  @ApiOperation({
    summary: 'Reverse a contribution payment (admin-only, fully audited)',
    description:
      'Credits the wallet back the original amount and reopens the contribution obligation. Can only be done once per payment — a second attempt is rejected. This is a corrective action for genuine disputes/errors, not a routine operation; both reason and memberConsentNote are required and are permanently recorded in the audit log alongside a full before/after snapshot.',
  })
  async reverse(
    @CurrentUser() user: AuthUser,
    @Param('cooperativeId') cooperativeId: string,
    @Param('ledgerEntryId') ledgerEntryId: string,
    @Body() dto: AdjustPaymentDto,
  ) {
    return this.adjustmentService.reverseContributionPayment({
      cooperativeId,
      ledgerEntryId,
      adminUserId: user.userId,
      reason: dto.reason,
      memberConsentNote: dto.memberConsentNote,
    });
  }
}
