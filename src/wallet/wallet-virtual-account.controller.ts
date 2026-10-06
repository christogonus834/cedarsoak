import { Body, Controller, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, AuthUser } from '../common/decorators/current-user.decorator';
import { WalletService } from './wallet.service';
import { VerifyBvnDto } from './dto/verify-bvn.dto';

@ApiTags('Wallet')
@ApiBearerAuth('access-token')
@Controller('wallet')
export class WalletVirtualAccountController {
  constructor(private walletService: WalletService) {}

  // Idempotent — safe to call repeatedly (e.g. if the user revisits the "fund
  // wallet" screen); returns the existing account if one was already
  // generated rather than creating a duplicate. The BVN is required here
  // because Monnify's account-generation API mandates it — see the detailed
  // comment on WalletService.verifyBvnAndProvisionAccount for how we avoid
  // persisting the raw value.
  @Post('virtual-account')
  @ApiOperation({
    summary: 'Verify BVN and generate a dedicated virtual account for wallet funding',
    description:
      'Idempotent — calling this again after an account already exists simply returns that existing account. The BVN itself is never stored; only a one-way hash is kept.',
  })
  async provision(@CurrentUser() user: AuthUser, @Body() dto: VerifyBvnDto) {
    return this.walletService.verifyBvnAndProvisionAccount(user.userId, dto.bvn);
  }
}
