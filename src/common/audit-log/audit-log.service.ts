import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AuditLog } from '../../entities/audit-log.entity';

export interface AuditLogEntry {
  actorId?: string;
  actorEmail?: string;
  action: string;
  targetType?: string;
  targetId?: string;
  metadata?: Record<string, unknown>;
}

@Injectable()
export class AuditLogService {
  private readonly logger = new Logger(AuditLogService.name);

  constructor(
    @InjectRepository(AuditLog)
    private readonly auditLogRepository: Repository<AuditLog>,
  ) {}

  // Audit logging must never break the calling flow (e.g. an event approval should not
  // fail because the audit write failed) — errors are logged, not rethrown.
  async log(entry: AuditLogEntry): Promise<void> {
    try {
      await this.auditLogRepository.save(this.auditLogRepository.create(entry));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`Failed to write audit log for action "${entry.action}": ${message}`);
    }
  }
}
