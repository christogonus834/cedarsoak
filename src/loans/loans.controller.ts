import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { CurrentUser, AuthUser } from '../common/decorators/current-user.decorator';
import { LoansService } from './loans.service';
import { RequestLoanDto } from './dto/request-loan.dto';
import { RepayLoanDto } from './dto/repay-loan.dto';

@ApiTags('Loans')
@ApiBearerAuth('access-token')
@ApiParam({ name: 'membershipId', description: 'The membership id returned from POST /memberships/join' })
@Controller('memberships/:membershipId/loans')
export class LoansController {
  constructor(private loansService: LoansService) {}

  @Get('eligibility')
  @ApiOperation({ summary: 'Check maximum eligible loan amount, based on current available wallet balance × the cooperative loan multiplier' })
  async getEligibility(@CurrentUser() user: AuthUser, @Param('membershipId') membershipId: string) {
    return this.loansService.getEligibility(user.userId, membershipId);
  }

  @Post()
  @ApiOperation({
    summary: 'Request a loan',
    description:
      'The guarantor must be another active member of the same cooperative with sufficient available wallet balance to cover the amount. Nothing is locked yet — that only happens once an admin approves.',
  })
  async requestLoan(
    @CurrentUser() user: AuthUser,
    @Param('membershipId') membershipId: string,
    @Body() dto: RequestLoanDto,
  ) {
    return this.loansService.requestLoan(user.userId, membershipId, dto);
  }

  @Get()
  @ApiOperation({ summary: "List this membership's loan requests/loans" })
  async getMyLoans(@CurrentUser() user: AuthUser, @Param('membershipId') membershipId: string) {
    return this.loansService.getMyLoans(user.userId, membershipId);
  }

  @Get(':loanId')
  @ApiOperation({ summary: 'Get loan detail including current outstanding balance (principal + accrued interest - repayments)' })
  async getLoanDetail(
    @CurrentUser() user: AuthUser,
    @Param('membershipId') membershipId: string,
    @Param('loanId') loanId: string,
  ) {
    return this.loansService.getLoanDetail(user.userId, membershipId, loanId);
  }

  @Post(':loanId/repay')
  @ApiOperation({
    summary: 'Make a repayment toward an active loan',
    description:
      'Partial repayments are allowed (unlike contributions). The amount may not exceed the current outstanding balance. Fully repaying the loan automatically releases the guarantor\'s locked collateral.',
  })
  async repayLoan(
    @CurrentUser() user: AuthUser,
    @Param('membershipId') membershipId: string,
    @Param('loanId') loanId: string,
    @Body() dto: RepayLoanDto,
  ) {
    return this.loansService.repayLoan(user.userId, membershipId, loanId, dto);
  }
}
