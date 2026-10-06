import { createParamDecorator, ExecutionContext } from '@nestjs/common';

// Usage in a controller: async someRoute(@CurrentUser() user: AuthUser) { ... }
// The user object here comes from the JWT strategy's validate() method — never trust
// any user identity sent in a request body; it always comes from the verified token.
export interface AuthUser {
  userId: string;
  email: string;
  role: 'MEMBER' | 'COOPERATIVE_ADMIN' | 'SUPER_ADMIN';
  // Only set when role === 'COOPERATIVE_ADMIN' — which single cooperative
  // this admin manages. Fetched fresh from the DB on every request (see
  // JwtStrategy.validate()) rather than trusted from an old JWT claim, so a
  // role/scope change takes effect immediately rather than only after the
  // access token expires.
  adminOfCooperativeId: string | null;
}

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthUser => {
    const request = ctx.switchToHttp().getRequest();
    return request.user;
  },
);
