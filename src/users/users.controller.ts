import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, AuthUser } from '../common/decorators/current-user.decorator';
import { UsersService } from './users.service';

@ApiTags('Users')
@ApiBearerAuth('access-token')
@Controller('users')
export class UsersController {
  constructor(private usersService: UsersService) {}

  @Get('me')
  @ApiOperation({ summary: "Get the authenticated user's profile, including all their memberships" })
  async getMe(@CurrentUser() user: AuthUser) {
    // Always derive "which user" from the verified JWT (CurrentUser), never from
    // a client-supplied ID in the URL/body — otherwise user A could pass user B's
    // ID and read their profile.
    return this.usersService.getPublicProfile(user.userId);
  }
}
