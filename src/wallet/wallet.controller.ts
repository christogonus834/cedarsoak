import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, AuthUser } from '../common/decorators/current-user.decorator';
import { WalletService } from './wallet.service';

@ApiTags('Wallet')
@ApiBearerAuth('access-token')
@Controller('wallet')
export class WalletController {
  constructor(private walletService: WalletService) {}

  // Always resolves the wallet from the authenticated user's own ID — a wallet
  // ID is never accepted from the client for this route, which would otherwise
  // let user A query user B's balance by guessing/passing their wallet ID.
  @Get('me')
  @ApiOperation({ summary: 'Get the current wallet balance, available balance, and virtual account details' })
  async getMyWallet(@CurrentUser() user: AuthUser) {
    return this.walletService.getWalletSummary(user.userId);
  }
}
