import { Body, Controller, Get, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, AuthUser } from '../common/decorators/current-user.decorator';
import { MembershipsService } from './memberships.service';
import { JoinCooperativeDto } from './dto/join-cooperative.dto';

@ApiTags('Memberships')
@ApiBearerAuth('access-token')
@Controller('memberships')
export class MembershipsController {
  constructor(private membershipsService: MembershipsService) {}

  @Post('join')
  @ApiOperation({ summary: 'Join a cooperative using its join code. Returns the new membership, including its id — save this, it is required for wallet/contribution endpoints below.' })
  async join(@CurrentUser() user: AuthUser, @Body() dto: JoinCooperativeDto) {
    return this.membershipsService.joinCooperative(user.userId, dto.cooperativeCode);
  }

  @Get('mine')
  @ApiOperation({ summary: "List all of the authenticated user's memberships across every cooperative they belong to" })
  async getMine(@CurrentUser() user: AuthUser) {
    return this.membershipsService.getMyMemberships(user.userId);
  }
}
