import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

// This is the single guard every admin route in this module depends on. It
// enforces two things together:
//   1. The caller's role is COOPERATIVE_ADMIN or SUPER_ADMIN at all.
//   2. If they're a COOPERATIVE_ADMIN, the :cooperativeId in the URL matches
//      the ONE cooperative they administer — SUPER_ADMIN bypasses this,
//      since their access is platform-wide by design.
//
// A mismatch returns 404, not 403 — per our IDOR-prevention principle, this
// means an admin at Cooperative A gets the exact same response whether
// Cooperative B's ID doesn't exist at all, or exists but isn't theirs. They
// can't use the error itself to enumerate valid cooperative IDs.
@Injectable()
export class CooperativeScopeGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const user = request.user;
    const cooperativeId = request.params?.cooperativeId;

    if (!user || (user.role !== 'COOPERATIVE_ADMIN' && user.role !== 'SUPER_ADMIN')) {
      throw new ForbiddenException('You do not have permission to access admin resources.');
    }

    if (user.role === 'SUPER_ADMIN') {
      return true; // platform-wide access, no scope restriction
    }

    // role === 'COOPERATIVE_ADMIN' from here on.
    if (!cooperativeId || user.adminOfCooperativeId !== cooperativeId) {
      throw new NotFoundException('Cooperative not found.');
    }

    return true;
  }
}
