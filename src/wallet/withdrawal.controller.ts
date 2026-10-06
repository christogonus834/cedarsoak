import { Body, Controller, Get, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, AuthUser } from '../common/decorators/current-user.decorator';
import { Audit } from '../common/decorators/audit.decorator';
import { WalletService } from './wallet.service';
import { WithdrawDto } from './dto/withdraw.dto';
import { PaystackProvider } from '../payments/providers/paystack.provider';

@ApiTags('Wallet')
@ApiBearerAuth('access-token')
@Controller('wallet')
export class WithdrawalController {
  constructor(
    private walletService: WalletService,
    private paystackProvider: PaystackProvider,
  ) {}

  // Powers the "Choose your bank" dropdown seen in the Bank.jpg design.
  @Get('banks')
  @ApiOperation({ summary: 'List Nigerian banks with their Paystack bank codes, for the withdrawal bank dropdown' })
  async listBanks() {
    return this.paystackProvider.listBanks();
  }

  @Post('withdraw')
  @Audit({ action: 'WALLET_WITHDRAWAL_INITIATED', entityType: 'WithdrawalRequest' })
  @ApiOperation({
    summary: 'Withdraw funds from the wallet to a bank account',
    description:
      'The destination account is resolved and confirmed before any transfer is attempted. The response status may be PENDING, SUCCESSFUL, or OTP_REQUIRED — poll GET /wallet/me or await the outcome via your own backend if you are a server-side integrator; a mobile client should simply show the returned status.',
  })
  async withdraw(@CurrentUser() user: AuthUser, @Body() dto: WithdrawDto) {
    return this.walletService.initiateWithdrawal(user.userId, dto);
  }
}
