import { Injectable } from "@nestjs/common";
import { DatabaseService } from "./database.service";
import { AuditLog } from "@patima/shared";
import { createId, nowIso } from "./helpers";

@Injectable()
export class AuditLogService {
  constructor(private readonly databaseService: DatabaseService) {}

  record(params: Omit<AuditLog, "id" | "createdAt" | "actorType">): AuditLog {
    const auditLog: AuditLog = {
      id: createId(),
      actorType: "LOCALHOST_ADMIN",
      createdAt: nowIso(),
      ...params,
    };

    this.databaseService.write((draft) => {
      draft.auditLogs.push(auditLog);
    });

    return auditLog;
  }
}
