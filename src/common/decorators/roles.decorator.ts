import { SetMetadata } from '@nestjs/common';

export const ROLES_KEY = 'roles';

// Usage: @Roles('COOPERATIVE_ADMIN', 'SUPER_ADMIN') above a controller method.
// This is deliberately explicit per-route rather than inferred, so a reviewer can see
// exactly who is allowed to call a sensitive endpoint just by reading the controller.
export const Roles = (...roles: string[]) => SetMetadata(ROLES_KEY, roles);
