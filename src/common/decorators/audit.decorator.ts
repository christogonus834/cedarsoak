import { SetMetadata } from '@nestjs/common';

export const AUDIT_ACTION_KEY = 'auditAction';

export interface AuditActionMeta {
  action: string; // e.g. "PAYMENT_ADJUSTMENT", "LOAN_APPROVED"
  entityType: string; // e.g. "LedgerEntry", "Loan"
}

// Usage: @Audit({ action: 'LOAN_APPROVED', entityType: 'Loan' }) above a controller method.
// The interceptor below picks this up and writes an AuditLog row automatically after
// the handler succeeds — so audit logging can't be forgotten on a sensitive endpoint,
// it's declared right next to the route definition where a reviewer will see it.
export const Audit = (meta: AuditActionMeta) => SetMetadata(AUDIT_ACTION_KEY, meta);
