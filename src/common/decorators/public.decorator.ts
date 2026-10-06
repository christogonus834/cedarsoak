import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';

// Only ever put this on: register, login, refresh, and provider webhook endpoints
// (webhooks are protected by signature verification instead of JWT — see the
// webhook guard we'll build in the payments module).
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
