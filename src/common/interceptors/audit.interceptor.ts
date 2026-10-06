import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import { PrismaService } from '../../prisma/prisma.service';
import { AUDIT_ACTION_KEY, AuditActionMeta } from '../decorators/audit.decorator';

// This interceptor writes AFTER the handler completes successfully — it does not
// capture "before state" automatically, since that depends on the entity being
// mutated. For endpoints that need full before/after diffing (e.g. Payment
// Adjustment), the service method itself writes a richer AuditLog entry directly
// rather than relying solely on this generic interceptor. This interceptor exists
// as a safety net so that even a route where a developer forgot the manual audit
// call still gets *something* logged.
@Injectable()
export class AuditInterceptor implements NestInterceptor {
  constructor(
    private reflector: Reflector,
    private prisma: PrismaService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const meta = this.reflector.getAllAndOverride<AuditActionMeta>(AUDIT_ACTION_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!meta) {
      return next.handle();
    }

    const request = context.switchToHttp().getRequest();
    const user = request.user;
    const ipAddress = request.ip;
    const deviceInfo = request.headers['user-agent'];

    return next.handle().pipe(
      tap((result) => {
        // Fire-and-forget, but errors here are caught and logged rather than
        // thrown — a logging failure must never take down the actual response
        // that already succeeded for the user.
        this.prisma.auditLog
          .create({
            data: {
              actorUserId: user?.userId ?? null,
              action: meta.action,
              entityType: meta.entityType,
              entityId: result?.id ?? null,
              afterState: safeJson(result),
              ipAddress,
              deviceInfo,
            },
          })
          .catch((err) => {
            // eslint-disable-next-line no-console
            console.error('AUDIT LOG WRITE FAILED — investigate immediately:', err);
          });
      }),
    );
  }
}

function safeJson(value: unknown) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return null;
  }
}
