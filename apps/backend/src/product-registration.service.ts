import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import type { CanonicalSalesUnit, DatabaseShape } from "@patima/shared";
import { recalculateAdMappingsForStore } from "./ad-mapping-engine";
import { AuditLogService } from "./audit-log.service";
import { buildCostSettingRecord, hasOrdersInCostPeriod, saveProductCost, validateCostSettingValues } from "./cost-setting-record";
import { DatabaseService, hashPayload } from "./database.service";
import { createId, ensureDateString, ensureStoreExists, formatApiSuccess, formatDate, nowIso } from "./helpers";
import { buildCostReader } from "./product-status.service";
import { ProfitSummaryService } from "./profit-summary.service";
import { recalculateOrderMappingsForStore } from "./sales-unit-auto-mapper";
import { buildSalesUnitRecord, ensureUniqueSalesUnit } from "./sales-unit-record";
import { StoreService } from "./store.service";

const AUDIT_DOMAIN = "PRODUCT_REGISTRATION";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface RegistrationReceipt {
  requestHash: string;
  salesUnitId: string;
  configurations: Array<{ salesUnitId: string; displayName: string; costSettingId: string | null }>;
  affectedDates: string[];
}

function badInput(field: string, message: string, reason = "INVALID_VALUE"): never {
  throw new BadRequestException({ success: false, message, errors: [{ field, reason }] });
}

function objectValue(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    badInput(field, "입력 형식이 올바르지 않습니다.");
  }
  return value as Record<string, unknown>;
}

function textValue(value: unknown, field: string, required = false, limit = 200): string {
  if (value == null && !required) return "";
  if (typeof value !== "string") badInput(field, "텍스트를 입력해 주세요.");
  const trimmed = value.trim();
  if (required && !trimmed) badInput(field, "필수 항목을 입력해 주세요.");
  if (trimmed.length > limit) badInput(field, `${limit}자 이내로 입력해 주세요.`);
  return trimmed;
}

function textList(value: unknown, field: string): string[] {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > 100) {
    badInput(field, "한 항목에 최대 100개까지 입력할 수 있습니다.");
  }
  return [...new Set(value.map((item) => textValue(item, field)).filter(Boolean))];
}

function dateValue(value: unknown, field: string): string {
  const text = ensureDateString(textValue(value, field, true), field);
  const date = new Date(`${text}T00:00:00Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== text || text.startsWith("0000")) {
    badInput(field, "올바른 원가 적용 시작일을 입력해 주세요.");
  }
  return text;
}

function readRegistration(body: unknown) {
  const input = objectValue(body, "registration");
  const requestId = textValue(input.requestId, "requestId", true).toLowerCase();
  if (!UUID_PATTERN.test(requestId)) badInput("requestId", "등록 요청 식별자가 올바르지 않습니다.");
  const storeId = textValue(input.storeId, "storeId", true);
  const displayName = textValue(input.displayName, "displayName", true);
  const effectiveFrom = dateValue(input.effectiveFrom, "effectiveFrom");
  const matchAliases = textList(input.matchAliases, "matchAliases");
  const memo = textValue(input.memo, "memo", false, 1000) || null;
  if (!Array.isArray(input.configurations) || !input.configurations.length || input.configurations.length > 50) {
    badInput("configurations", "판매 구성은 1개 이상 50개까지 입력할 수 있습니다.");
  }

  const isGroup = input.configurations.length > 1;
  const assignedSignatures = new Set<string>();
  const configurations = input.configurations.map((value, index) => {
    const path = `configurations.${index}`;
    const row = objectValue(value, path);
    const name = textValue(row.name, `${path}.name`, isGroup);
    const unitCost = row.unitCost ?? null;
    const feeRate = row.feeRate ?? null;
    const otherCost = row.otherCost ?? 0;
    if (unitCost !== null && typeof unitCost !== "number") badInput(`${path}.unitCost`, "원가를 숫자로 입력해 주세요.");
    if (feeRate !== null && typeof feeRate !== "number") badInput(`${path}.feeRate`, "수수료율을 숫자로 입력해 주세요.");
    if (typeof otherCost !== "number") badInput(`${path}.otherCost`, "기타비용을 숫자로 입력해 주세요.");
    validateCostSettingValues(unitCost ?? 0, otherCost, feeRate);
    if (unitCost === null && (feeRate !== null || otherCost !== 0)) {
      badInput(`${path}.unitCost`, "수수료율 또는 기타비용을 저장하려면 원가를 입력해 주세요.");
    }
    const orderSignatureIds = textList(row.orderSignatureIds, `${path}.orderSignatureIds`);
    for (const signatureId of orderSignatureIds) {
      if (assignedSignatures.has(signatureId)) {
        badInput(`${path}.orderSignatureIds`, "같은 주문 조합을 여러 판매 구성에 연결할 수 없습니다.");
      }
      assignedSignatures.add(signatureId);
    }
    return {
      name,
      matchAliases: textList(row.matchAliases, `${path}.matchAliases`),
      linkedProductIds: textList(row.linkedProductIds, `${path}.linkedProductIds`),
      linkedOptionCodes: textList(row.linkedOptionCodes, `${path}.linkedOptionCodes`),
      linkedManageCodes: textList(row.linkedManageCodes, `${path}.linkedManageCodes`),
      orderSignatureIds,
      unitCost,
      feeRate,
      otherCost,
      effectiveFrom: row.effectiveFrom == null ? effectiveFrom : dateValue(row.effectiveFrom, `${path}.effectiveFrom`),
    };
  });
  return { requestId, storeId, displayName, effectiveFrom, matchAliases, memo, isGroup, configurations };
}

function joinedName(productName: string, configurationName: string) {
  return [productName, configurationName].filter(Boolean).join(" ");
}

function editSnapshot(database: DatabaseShape, storeId: string, salesUnitId: string, date: string) {
  ensureStoreExists(database, storeId);
  const units = database.canonicalSalesUnits.filter((unit) => unit.storeId === storeId && !unit.isStoreLevel);
  const selected = units.find((unit) => unit.id === salesUnitId);
  if (!selected) throw new NotFoundException("이 스토어에서 판매단위를 찾을 수 없습니다.");
  const root = units.find((unit) => unit.id === selected.parentSalesUnitId && unit.isGroup) ?? selected;
  const children = root.isGroup ? units.filter((unit) => unit.parentSalesUnitId === root.id && !unit.isGroup) : [root];
  const ids = new Set(children.map((unit) => unit.id));
  const settings = database.salesUnitCostSettings.filter((item) => item.storeId === storeId && ids.has(item.canonicalSalesUnitId));
  const readCost = buildCostReader(database, storeId, date, ids);
  const rootForm = root.productForm;
  const validStandaloneName = !root.isGroup && rootForm &&
    joinedName(rootForm.productName, rootForm.configurationName) === root.displayName;
  const productName = validStandaloneName ? rootForm.productName : root.displayName;
  const commonAliases = !root.isGroup && rootForm
    ? rootForm.commonAliases.filter((alias) => root.matchAliases.includes(alias))
    : root.matchAliases;
  const configurations = children.map((unit) => {
    const usesProductName = !root.isGroup || unit.displayName.startsWith(root.displayName + " ");
    const name = root.isGroup
      ? usesProductName ? unit.displayName.slice(root.displayName.length + 1) : unit.displayName
      : validStandaloneName ? rootForm.configurationName : "";
    let cost = readCost(unit.id);
    if (!cost) {
      const future = settings.filter((row) => row.canonicalSalesUnitId === unit.id && row.isActive && row.effectiveFrom > date)
        .sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom))[0];
      if (future) cost = buildCostReader(database, storeId, future.effectiveFrom, new Set([unit.id]))(unit.id);
    }
    const manual = settings.find((row) => row.id === cost?.settingId);
    const canChangeExistingCost = Boolean(manual && !hasOrdersInCostPeriod(database, manual));
    return {
      id: unit.id,
      name,
      usesProductName,
      isActive: unit.isActive,
      matchAliases: root.isGroup ? unit.matchAliases : unit.matchAliases.filter((alias) => !commonAliases.includes(alias)),
      linkedProductIds: unit.linkedProductIds,
      linkedOptionCodes: unit.linkedOptionCodes,
      linkedManageCodes: unit.linkedManageCodes,
      memo: root.isGroup ? unit.memo : null,
      cost,
      canChangeExistingCost,
    };
  });
  const fields = {
    date,
    effectiveFrom: rootForm?.effectiveFrom ?? configurations.find((row) => row.cost)?.cost?.effectiveFrom ?? date,
    product: { id: root.id, displayName: productName, matchAliases: commonAliases, memo: root.memo, isGroup: root.isGroup },
    configurations,
  };
  return { root, children, settings, fields, version: hashPayload({ fields, settings }) };
}

function readEditCost(value: unknown, path: string) {
  if (value === null) return null;
  const cost = objectValue(value, path);
  const { unitCost, feeRate, otherCost } = cost;
  if (typeof unitCost !== "number" || typeof otherCost !== "number" || (feeRate !== null && typeof feeRate !== "number")) {
    badInput(path, "원가, 기타비용, 수수료율을 확인해 주세요.");
  }
  validateCostSettingValues(unitCost, otherCost, feeRate);
  return { unitCost, otherCost, feeRate, effectiveFrom: dateValue(cost.effectiveFrom, path + ".effectiveFrom") };
}

function editMetadata(unit: CanonicalSalesUnit, values: {
  displayName: string;
  matchAliases: string[];
  linkedProductIds?: string[];
  linkedOptionCodes?: string[];
  linkedManageCodes?: string[];
  memo: string | null;
}) {
  const checked = buildSalesUnitRecord({
    ...unit,
    ...values,
    timestamp: unit.updatedAt,
  });
  return {
    ...unit,
    displayName: checked.displayName,
    matchAliases: checked.matchAliases,
    normalizedMatchAliases: checked.normalizedMatchAliases,
    linkedProductIds: checked.linkedProductIds,
    linkedOptionCodes: checked.linkedOptionCodes,
    linkedManageCodes: checked.linkedManageCodes,
    memo: checked.memo,
  };
}

function formMetadata(productName: string, configurationName: string, commonAliases: string[], effectiveFrom: string) {
  return { productName, configurationName, commonAliases, effectiveFrom };
}

@Injectable()
export class ProductRegistrationService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly storeService: StoreService,
    private readonly auditLogService: AuditLogService,
    private readonly profitSummaryService: ProfitSummaryService,
  ) {}

  async register(body: unknown) {
    const input = readRegistration(body);
    const { requestId, storeId } = input;
    const { effectiveFrom: _commonEffectiveFrom, ...existingHashFields } = input;
    const requestHash = hashPayload(existingHashFields);
    const replay = (database: DatabaseShape) => {
      const audit = database.auditLogs.find((row) =>
        row.domain === AUDIT_DOMAIN && row.action === "CREATE" && row.storeId === storeId && row.targetId === requestId,
      );
      const receipt = audit?.afterJson as RegistrationReceipt | undefined;
      if (receipt?.requestHash === requestHash) return receipt;
      if (audit || database.canonicalSalesUnits.some((row) => row.id === requestId)) {
        throw new ConflictException("이미 사용된 상품 등록 요청입니다. 등록된 상품을 확인해 주세요.");
      }
      return null;
    };
    const receipt = replay(this.databaseService.getSnapshot()) ?? await this.databaseService.commitProductRegistration(storeId, (draft) => {
      const existing = replay(draft);
      if (existing) return existing;
      this.storeService.ensureWritable(storeId);

      const timestamp = nowIso();
      if (input.isGroup) {
        const group = buildSalesUnitRecord({
          id: requestId,
          storeId,
          displayName: input.displayName,
          matchAliases: input.matchAliases,
          memo: input.memo,
          isGroup: true,
          timestamp,
        });
        ensureUniqueSalesUnit(draft.canonicalSalesUnits, group);
        group.productForm = formMetadata(input.displayName, "", input.matchAliases, input.effectiveFrom);
        draft.canonicalSalesUnits.push(group);
      }

      const signatureTargets = new Map<string, string>();
      const configurations = input.configurations.map((row) => {
        const salesUnit = buildSalesUnitRecord({
          id: input.isGroup ? createId() : requestId,
          storeId,
          displayName: [input.displayName, row.name].filter(Boolean).join(" "),
          matchAliases: input.isGroup ? row.matchAliases : [...input.matchAliases, ...row.matchAliases],
          linkedProductIds: row.linkedProductIds,
          linkedOptionCodes: row.linkedOptionCodes,
          linkedManageCodes: row.linkedManageCodes,
          memo: input.isGroup ? null : input.memo,
          parentSalesUnitId: input.isGroup ? requestId : null,
          timestamp,
        });
        ensureUniqueSalesUnit(draft.canonicalSalesUnits, salesUnit);
        if (!input.isGroup) salesUnit.productForm = formMetadata(input.displayName, row.name, input.matchAliases, input.effectiveFrom);
        draft.canonicalSalesUnits.push(salesUnit);

        const cost = row.unitCost === null ? null : buildCostSettingRecord({
          storeId,
          canonicalSalesUnitId: salesUnit.id,
          unitCost: row.unitCost,
          feeRate: row.feeRate,
          otherCost: row.otherCost,
          effectiveFrom: row.effectiveFrom,
        }, timestamp);
        if (cost) draft.salesUnitCostSettings.push(cost);
        for (const signatureId of row.orderSignatureIds) signatureTargets.set(signatureId, salesUnit.id);
        return { salesUnitId: salesUnit.id, displayName: salesUnit.displayName, costSettingId: cost?.id ?? null };
      });

      const signatures = new Map(draft.orderSourceSignatures
        .filter((signature) => signatureTargets.has(signature.id))
        .map((signature) => [signature.id, signature]));
      for (const [signatureId, salesUnitId] of signatureTargets) {
        const signature = signatures.get(signatureId);
        if (!signature || signature.storeId !== storeId) {
          badInput("orderSignatureIds", "같은 스토어의 주문 조합만 선택할 수 있습니다.", "INVALID_ORDER_SIGNATURE");
        }
        if (signature.confirmedAt && signature.canonicalSalesUnitId) {
          throw new ConflictException("이미 수동으로 연결된 주문이 있습니다. 주문 목록에서 연결 상태를 확인해 주세요.");
        }
        signature.canonicalSalesUnitId = salesUnitId;
        signature.mappingStatus = "MAPPED";
        signature.confirmedAt = timestamp;
        signature.updatedAt = timestamp;
      }

      const orderItems = draft.orderItems.filter((row) => row.storeId === storeId)
        .map((row) => ({ row, target: row.canonicalSalesUnitId }));
      const adCosts = draft.adCampaignDailyCosts.filter((row) => row.storeId === storeId)
        .map((row) => ({ row, target: row.canonicalSalesUnitId, reason: row.mappingReason }));
      recalculateOrderMappingsForStore(draft, storeId);
      recalculateAdMappingsForStore(draft, storeId);
      const affectedDates = new Set<string>();
      for (const { row, target } of orderItems) {
        if (row.paymentDate && row.canonicalSalesUnitId !== target) affectedDates.add(row.paymentDate);
      }
      for (const { row, target, reason } of adCosts) {
        if (row.canonicalSalesUnitId !== target || row.mappingReason !== reason) affectedDates.add(row.reportDate);
      }
      const saved: RegistrationReceipt = { requestHash, salesUnitId: requestId, configurations, affectedDates: [...affectedDates] };
      this.auditLogService.appendToDraft(draft, {
        storeId,
        domain: AUDIT_DOMAIN,
        action: "CREATE",
        targetId: requestId,
        actorIdentifier: "LOCALHOST_ADMIN",
        beforeJson: null,
        afterJson: saved,
      });
      return saved;
    });

    const { salesUnitId, configurations, affectedDates } = receipt;
    const recalculationPending = affectedDates.length > 0 && !(await this.profitSummaryService.refreshStoreDateListBestEffort({
      storeId,
      dates: affectedDates,
      reason: "MAPPING_CHANGE",
    }));
    return formatApiSuccess({ salesUnitId, configurations, recalculationPending });
  }

  readEdit(storeId: string, salesUnitId: string, requestedDate?: string) {
    const date = requestedDate === undefined ? formatDate(new Date()) : dateValue(requestedDate, "date");
    const { fields, version } = editSnapshot(this.databaseService.getSnapshot(), storeId, salesUnitId, date);
    return formatApiSuccess({ ...fields, version });
  }

  async saveEdit(salesUnitId: string, body: unknown) {
    const input = objectValue(body, "edit");
    const storeId = textValue(input.storeId, "storeId", true);
    const version = textValue(input.version, "version", true);
    const date = dateValue(input.date, "date");
    const effectiveFrom = dateValue(input.effectiveFrom, "effectiveFrom");
    const name = textValue(input.displayName, "displayName", true);
    const aliases = textList(input.matchAliases, "matchAliases");
    const memo = textValue(input.memo, "memo", false, 1000) || null;
    const rows = input.configurations;
    if (!Array.isArray(rows)) badInput("configurations", "판매 구성 입력을 확인해 주세요.");

    const result = await this.databaseService.commitProductRegistration(storeId, (draft) => {
      this.storeService.ensureWritable(storeId);
      const { root, children, fields, settings, version: latest } = editSnapshot(draft, storeId, salesUnitId, date);
      if (version !== latest || rows.length !== children.length) {
        throw new ConflictException("저장된 값이 바뀌었습니다. 판매단위 편집을 다시 열어 주세요.");
      }
      const updates = new Map<string, CanonicalSalesUnit>();
      const costDates = new Map<string, string>();
      const timestamp = nowIso();
      if (root.isGroup) {
        const updated = editMetadata(root, { displayName: name, matchAliases: aliases, memo });
        updated.productForm = formMetadata(name, "", aliases, effectiveFrom);
        updates.set(root.id, updated);
      }
      for (const value of rows) {
        const row = objectValue(value, "configuration");
        const unit = children.find((child) => child.id === row.id);
        const base = fields.configurations.find((child) => child.id === row.id);
        if (!unit || !base || updates.has(unit.id)) badInput("configurations", "이 상품에 속한 판매 구성만 수정할 수 있습니다.");
        const configurationName = textValue(row.name, "configuration.name", root.isGroup);
        const rowAliases = textList(row.matchAliases, "configuration.matchAliases");
        const updated = editMetadata(unit, {
          displayName: base.usesProductName ? joinedName(name, configurationName) : configurationName,
          matchAliases: root.isGroup ? rowAliases : [...aliases, ...rowAliases],
          linkedProductIds: textList(row.linkedProductIds, "configuration.linkedProductIds"),
          linkedOptionCodes: textList(row.linkedOptionCodes, "configuration.linkedOptionCodes"),
          linkedManageCodes: textList(row.linkedManageCodes, "configuration.linkedManageCodes"),
          memo: root.isGroup ? textValue(row.memo, "configuration.memo", false, 1000) || null : memo,
        });
        if (!root.isGroup) updated.productForm = formMetadata(name, configurationName, aliases, effectiveFrom);
        updates.set(unit.id, updated);

        // Omitted cost means the selected cost record was displayed but never edited.
        if (row.cost !== undefined) {
          const cost = readEditCost(row.cost, "configuration.cost");
          if (!cost && !base.cost) continue;
          const prior = settings.find((item) => item.id === base.cost?.settingId);
          try {
            costDates.set(unit.id, saveProductCost(draft, { storeId, canonicalSalesUnitId: unit.id }, prior, cost, timestamp));
          } catch (error) {
            if (error instanceof BadRequestException) throw new BadRequestException(unit.displayName + " · " + error.message);
            throw error;
          }
        }
      }
      const allUnits = draft.canonicalSalesUnits.map((unit) => updates.get(unit.id) ?? unit);
      const renamed = new Set<string>();
      let mappingChanged = false;
      const updatedIds: string[] = [];
      for (const unit of [root, ...children.filter((child) => child.id !== root.id)]) {
        const updated = updates.get(unit.id)!;
        const changedName = unit.displayName !== updated.displayName;
        const changedAliases = hashPayload(unit.matchAliases) !== hashPayload(updated.matchAliases);
        if (changedName || changedAliases) ensureUniqueSalesUnit(allUnits, updated, unit.id);
        if (changedName) {
          renamed.add(unit.id);
          if (unit.isGroup) for (const child of children) renamed.add(child.id);
        }
        mappingChanged ||= changedName || changedAliases || hashPayload([unit.linkedProductIds, unit.linkedOptionCodes, unit.linkedManageCodes]) !==
          hashPayload([updated.linkedProductIds, updated.linkedOptionCodes, updated.linkedManageCodes]);
        if (hashPayload(unit) !== hashPayload(updated)) {
          Object.assign(unit, updated, { updatedAt: timestamp });
          updatedIds.push(unit.id);
        }
      }

      const dates = new Set<string>();
      const affects = (id: string | null, dateValue: string) =>
        id && (renamed.has(id) || (costDates.has(id) && dateValue >= costDates.get(id)!));
      const orders = draft.orderItems.filter((row) => row.storeId === storeId).map((row) => ({ row, target: row.canonicalSalesUnitId }));
      const ads = draft.adCampaignDailyCosts.filter((row) => row.storeId === storeId).map((row) => ({ row, target: row.canonicalSalesUnitId, reason: row.mappingReason }));
      if (mappingChanged) {
        recalculateOrderMappingsForStore(draft, storeId);
        recalculateAdMappingsForStore(draft, storeId);
      }
      for (const { row, target } of orders) {
        if (row.paymentDate && (row.canonicalSalesUnitId !== target || affects(row.canonicalSalesUnitId, row.paymentDate))) dates.add(row.paymentDate);
      }
      for (const { row, target, reason } of ads) {
        if (row.canonicalSalesUnitId !== target || row.mappingReason !== reason || affects(row.canonicalSalesUnitId, row.reportDate)) dates.add(row.reportDate);
      }
      if (updatedIds.length || costDates.size) {
        this.auditLogService.appendToDraft(draft, {
          storeId,
          domain: AUDIT_DOMAIN,
          action: "UPDATE",
          targetId: root.id,
          actorIdentifier: "LOCALHOST_ADMIN",
          beforeJson: { version },
          afterJson: { updatedIds, changedCostIds: [...costDates.keys()] },
        });
      }
      return { salesUnitId: root.id, dates: [...dates] };
    });
    const recalculationPending = result.dates.length > 0 && !(await this.profitSummaryService.refreshStoreDateListBestEffort({
      storeId,
      dates: result.dates,
      reason: "MAPPING_CHANGE",
    }));
    return formatApiSuccess({ salesUnitId: result.salesUnitId, recalculationPending });
  }
}
