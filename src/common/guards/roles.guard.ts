import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY } from '../decorators/roles.decorator';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.getAllAndOverride<string[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    // No @Roles() on the route means any authenticated user can access it.
    if (!requiredRoles || requiredRoles.length === 0) {
      return true;
    }

    const { user } = context.switchToHttp().getRequest();

    // Fail closed: if there's somehow no user on the request at this point
    // (should be impossible if JwtAuthGuard ran first), deny rather than allow.
    if (!user || !requiredRoles.includes(user.role)) {
      throw new ForbiddenException('You do not have permission to perform this action.');
    }

    return true;
  }
}
