import { SetMetadata } from '@nestjs/common';

export const AUDIT_ACTION_KEY = 'auditAction';

export interface AuditActionMeta {
  action: string;
  targetType?: string;
}

// Marks a mutating admin-facing endpoint for the AuditLogInterceptor to record after
// it completes successfully. `targetType` defaults to the route's first param name
// (e.g. "id") stripped of its suffix if omitted.
export const AuditAction = (action: string, targetType?: string) =>
  SetMetadata(AUDIT_ACTION_KEY, { action, targetType } as AuditActionMeta);
