import { BadRequestException, Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiQuery, ApiTags } from '@nestjs/swagger';
import { LoanStatus } from '@prisma/client';
import { CurrentUser, AuthUser } from '../common/decorators/current-user.decorator';
import { Audit } from '../common/decorators/audit.decorator';
import { CooperativeScopeGuard } from './guards/cooperative-scope.guard';
import { BurstLimitGuard } from './guards/burst-limit.guard';
import { AdminLoansService } from './admin-loans.service';
import { RejectLoanDto } from './dto/reject-loan.dto';

@ApiTags('Admin')
@ApiBearerAuth('access-token')
@ApiParam({ name: 'cooperativeId', description: 'A COOPERATIVE_ADMIN may only access their own cooperative; SUPER_ADMIN may access any.' })
@UseGuards(CooperativeScopeGuard, BurstLimitGuard)
@Controller('admin/cooperatives/:cooperativeId/loans')
export class AdminLoansController {
  constructor(private adminLoansService: AdminLoansService) {}

  @Get()
  @ApiOperation({ summary: 'List loans for this cooperative, optionally filtered by status' })
  @ApiQuery({ name: 'status', required: false, description: 'REQUESTED | APPROVED | REJECTED | ACTIVE | REPAID | DEFAULTED' })
  async list(@Param('cooperativeId') cooperativeId: string, @Query('status') status?: string) {
    let parsedStatus: LoanStatus | undefined;
    if (status !== undefined) {
      if (!Object.values(LoanStatus).includes(status as LoanStatus)) {
        throw new BadRequestException(
          `Invalid status filter. Must be one of: ${Object.values(LoanStatus).join(', ')}.`,
        );
      }
      parsedStatus = status as LoanStatus;
    }
    return this.adminLoansService.list(cooperativeId, parsedStatus);
  }

  @Post(':loanId/approve')
  @Audit({ action: 'LOAN_APPROVED', entityType: 'Loan' })
  @ApiOperation({
    summary: 'Approve a requested loan',
    description: 'Does NOT disburse funds or lock collateral — that is a separate action (POST .../disburse), which must be performed by a DIFFERENT admin (separation of duties).',
  })
  async approve(
    @CurrentUser() user: AuthUser,
    @Param('cooperativeId') cooperativeId: string,
    @Param('loanId') loanId: string,
  ) {
    return this.adminLoansService.approve(cooperativeId, loanId, user.userId);
  }

  @Post(':loanId/reject')
  @Audit({ action: 'LOAN_REJECTED', entityType: 'Loan' })
  @ApiOperation({ summary: 'Reject a requested loan' })
  async reject(
    @CurrentUser() user: AuthUser,
    @Param('cooperativeId') cooperativeId: string,
    @Param('loanId') loanId: string,
    @Body() dto: RejectLoanDto,
  ) {
    return this.adminLoansService.reject(cooperativeId, loanId, user.userId, dto.reason);
  }

  @Post(':loanId/disburse')
  @Audit({ action: 'LOAN_DISBURSED', entityType: 'Loan' })
  @ApiOperation({
    summary: 'Disburse an approved loan (SEPARATION OF DUTIES: must be a different admin than whoever approved it)',
    description:
      'Locks the guarantor\'s collateral and credits the borrower\'s wallet. Re-validates the guarantor\'s available balance fresh at this moment — if they no longer have enough, this fails and nothing is disbursed. Rejected outright if the calling admin is the same person who approved the loan.',
  })
  async disburse(
    @CurrentUser() user: AuthUser,
    @Param('cooperativeId') cooperativeId: string,
    @Param('loanId') loanId: string,
  ) {
    return this.adminLoansService.disburse(cooperativeId, loanId, user.userId);
  }
}
