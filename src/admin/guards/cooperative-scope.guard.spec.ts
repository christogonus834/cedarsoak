import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { CooperativeScopeGuard } from './cooperative-scope.guard';

// This guard is the single thing standing between "a cooperative admin sees
// only their own cooperative" and "any admin can read any cooperative's data
// by changing a URL." These tests exist to lock that boundary in place.
describe('CooperativeScopeGuard', () => {
  const guard = new CooperativeScopeGuard();

  function makeContext(user: any, cooperativeId?: string): any {
    return {
      switchToHttp: () => ({
        getRequest: () => ({ user, params: { cooperativeId } }),
      }),
    };
  }

  it('rejects a MEMBER role outright', () => {
    const ctx = makeContext({ role: 'MEMBER' }, 'coop-1');
    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
  });

  it('rejects when there is no user on the request at all', () => {
    const ctx = makeContext(undefined, 'coop-1');
    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
  });

  it('allows a COOPERATIVE_ADMIN to access their own cooperative', () => {
    const ctx = makeContext({ role: 'COOPERATIVE_ADMIN', adminOfCooperativeId: 'coop-1' }, 'coop-1');
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('blocks a COOPERATIVE_ADMIN from accessing a DIFFERENT cooperative, with 404 not 403', () => {
    const ctx = makeContext({ role: 'COOPERATIVE_ADMIN', adminOfCooperativeId: 'coop-1' }, 'coop-2');
    expect(() => guard.canActivate(ctx)).toThrow(NotFoundException);
  });

  it('blocks a COOPERATIVE_ADMIN with no assigned cooperative at all', () => {
    const ctx = makeContext({ role: 'COOPERATIVE_ADMIN', adminOfCooperativeId: null }, 'coop-1');
    expect(() => guard.canActivate(ctx)).toThrow(NotFoundException);
  });

  it('allows a SUPER_ADMIN to access ANY cooperative, regardless of adminOfCooperativeId', () => {
    const ctx = makeContext({ role: 'SUPER_ADMIN', adminOfCooperativeId: null }, 'coop-999');
    expect(guard.canActivate(ctx)).toBe(true);
  });
});
