import { Injectable } from "@nestjs/common";
import { DatabaseService } from "./database.service";
import { AuditLog, DatabaseShape } from "@patima/shared";
import { createId, nowIso } from "./helpers";

type AuditLogParams = Omit<AuditLog, "id" | "createdAt" | "actorType">;

@Injectable()
export class AuditLogService {
  constructor(private readonly databaseService: DatabaseService) {}

  createAuditLog(params: AuditLogParams): AuditLog {
    return {
      id: createId(),
      actorType: "LOCALHOST_ADMIN",
      createdAt: nowIso(),
      ...params,
    };
  }

  appendToDraft(draft: DatabaseShape, params: AuditLogParams): AuditLog {
    const auditLog = this.createAuditLog(params);
    draft.auditLogs.push(auditLog);
    return auditLog;
  }

  async recordCommitted(params: AuditLogParams): Promise<AuditLog> {
    return this.databaseService.writeCommitted((draft) => this.appendToDraft(draft, params));
  }

  record(params: AuditLogParams): AuditLog {
    const auditLog = this.createAuditLog(params);
    this.databaseService.write((draft) => {
      draft.auditLogs.push(auditLog);
    });

    return auditLog;
  }
}
