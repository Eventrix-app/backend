import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import { Request } from 'express';
import { AUDIT_ACTION_KEY, AuditActionMeta } from '../decorators/audit-action.decorator';
import { AuditLogService } from '../audit-log/audit-log.service';
import { JwtPayload } from '../../auth/jwt.util';

@Injectable()
export class AuditLogInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly auditLogService: AuditLogService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const meta = this.reflector.getAllAndOverride<AuditActionMeta | undefined>(
      AUDIT_ACTION_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (!meta) {
      return next.handle();
    }

    const request = context.switchToHttp().getRequest<Request & { user?: JwtPayload }>();
    const targetId = Object.values(request.params ?? {})[0] as string | undefined;

    // Only successful mutations are recorded — a failed approve/reject/ban never happened.
    return next.handle().pipe(
      tap((data) => {
        void this.auditLogService.log({
          actorId: request.user?.id,
          actorEmail: request.user?.email,
          action: meta.action,
          targetType: meta.targetType,
          targetId: targetId ?? data?.id,
          metadata: { method: request.method, path: request.originalUrl ?? request.url },
        });
      }),
    );
  }
}
