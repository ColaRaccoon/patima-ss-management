import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import {
  type CanonicalSalesUnit,
  type DailySalesUnitProfit,
  type DatabaseShape,
  type OrderSourceSignature,
  type SalesUnitCostSetting,
  type SalesUnitCostSnapshotEntry,
  normalizeMatchAlias,
} from "@patima/shared";
import { getActiveCampaignMappings } from "./ad-mapping-engine";
import { AuditLogService } from "./audit-log.service";
import { DatabaseService } from "./database.service";
import {
  calculateDailyProfitRows,
  ensureDateString,
  ensureStoreExists,
  formatApiSuccess,
  formatDate,
  getActiveConfirmedUploadIds,
  getSignatureMappingStatus,
  nowIso,
  repairMojibakeText,
  resolveCostSettingForDate,
} from "./helpers";
import { createOrderGroupContext, matchOrderGroup, matchesOrderAlias } from "./order-group-matcher";
import { ProfitSummaryService } from "./profit-summary.service";
import { StoreService } from "./store.service";

const MAX_CONTEXT_SIGNATURES = 100;
const MAX_CANDIDATES = 50;

function resolveDate(value?: string) {
  if (value === undefined) return formatDate(new Date());
  ensureDateString(value, "date");
  const parsed = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new BadRequestException("실제 달력에 있는 날짜를 선택해 주세요.");
  }
  return value;
}

function getProduct(units: CanonicalSalesUnit[], salesUnitId: string) {
  const unit = units.find((item) => item.id === salesUnitId && !item.isStoreLevel);
  if (!unit) throw new NotFoundException("이 스토어에서 상품을 찾을 수 없습니다.");
  return units.find((item) => item.id === unit.parentSalesUnitId && item.isGroup) ?? unit;
}

function getOrderLabel(signature: OrderSourceSignature) {
  return {
    id: signature.id,
    productName: repairMojibakeText(signature.rawProductNameSnapshot || signature.normalizedProductName),
    optionInfo: repairMojibakeText(signature.rawOptionInfoSnapshot || signature.normalizedOptionInfo) || null,
    usageCount: signature.usageCount,
  };
}

export function buildCostReader(database: DatabaseShape, storeId: string, date: string, unitIds: Set<string>) {
  // The resolver uses the latest full cost table, including omitted products.
  const snapshots = database.salesUnitCostSnapshots
    .filter((snapshot) => snapshot.storeId === storeId && snapshot.effectiveFrom <= date)
    .sort((left, right) => left.effectiveFrom.localeCompare(right.effectiveFrom));
  const latestSnapshot = snapshots.at(-1);
  const entriesByUnit = new Map<string, SalesUnitCostSnapshotEntry>();
  const settingsByUnit = new Map<string, SalesUnitCostSetting[]>();

  if (latestSnapshot) {
    for (const entry of database.salesUnitCostSnapshotEntries) {
      if (entry.storeId === storeId && entry.snapshotId === latestSnapshot.id && unitIds.has(entry.canonicalSalesUnitId)) {
        entriesByUnit.set(entry.canonicalSalesUnitId, entry);
      }
    }
  }
  for (const setting of database.salesUnitCostSettings) {
    if (setting.storeId !== storeId || !unitIds.has(setting.canonicalSalesUnitId)) continue;
    const settings = settingsByUnit.get(setting.canonicalSalesUnitId) ?? [];
    settings.push(setting);
    settingsByUnit.set(setting.canonicalSalesUnitId, settings);
  }

  return (unitId: string) => {
    const cost = resolveCostSettingForDate(
      latestSnapshot ? [{ snapshot: latestSnapshot, entry: entriesByUnit.get(unitId) ?? null }] : [],
      date,
      settingsByUnit.get(unitId),
    );
    if (!cost?.values) return null;
    return {
      source: cost.source,
      settingId: cost.settingId,
      sourceFileName: repairMojibakeText(cost.sourceFileName) || null,
      effectiveFrom: cost.effectiveFrom,
      unitCost: cost.values.unitCost,
      feeRate: cost.values.feeRate,
      otherCost: cost.values.otherCost,
    };
  };
}

function getProfitStatus(row?: DailySalesUnitProfit) {
  return {
    state: row?.profitStatus ?? "WAITING" as const,
    estimatedNetProfit: row?.estimatedNetProfit ?? null,
  };
}

function listOrderEvidence(
  database: DatabaseShape,
  product: CanonicalSalesUnit,
  configurations: CanonicalSalesUnit[],
  date: string,
) {
  const storeId = product.storeId;
  const configurationIds = new Set(configurations.map((unit) => unit.id));
  const activeConfigurations = configurations.filter((unit) => product.isActive && unit.isActive);
  const activeIds = new Set(activeConfigurations.map((unit) => unit.id));
  const groups = createOrderGroupContext(database, storeId);
  const name = normalizeMatchAlias(product.displayName);
  const mappedSignatures = new Map<string, number>();
  const orderItems = new Map<string, number>();
  const reviewIds = new Set<string>();
  const candidates = [];

  for (const item of database.orderItems) {
    const unitId = item.canonicalSalesUnitId;
    if (item.storeId === storeId && item.paymentDate === date && item.saleStatus === "SALE" && unitId && configurationIds.has(unitId)) {
      orderItems.set(unitId, (orderItems.get(unitId) ?? 0) + 1);
    }
  }

  for (const signature of database.orderSourceSignatures) {
    if (signature.storeId !== storeId || signature.usageCount < 1) continue;
    if (signature.canonicalSalesUnitId) {
      const unitId = signature.canonicalSalesUnitId;
      if (configurationIds.has(unitId)) {
        mappedSignatures.set(unitId, (mappedSignatures.get(unitId) ?? 0) + 1);
      }
      continue;
    }
    if (!activeConfigurations.length) continue;
    const group = matchOrderGroup(groups, signature);
    if (group && product.isGroup && !group.groupIds.has(product.id)) continue;

    const label = getOrderLabel(signature);
    const option = label.optionInfo ?? "";
    const isBundle = /\[함께배송/.test(option);
    const orderName = isBundle ? "" : label.productName;
    const hasFamilyEvidence =
      group?.groupIds.has(product.id) ||
      (name.length >= 2 && normalizeMatchAlias(`${orderName} ${option}`).includes(name));
    const signatureCodes = [
      ["linkedManageCodes", signature.sampleOptionManageCode],
      ["linkedOptionCodes", signature.sampleOptionCode],
      ["linkedProductIds", isBundle ? null : signature.sampleExternalProductId],
    ] as const;
    const explicitIds = signatureCodes
      .map(([field, value]) => activeConfigurations
        .filter((unit) => value && unit[field].includes(value))
        .map((unit) => unit.id))
      .find((matches) => matches.length > 0) ?? [];
    const suggestions = new Set(explicitIds);
    if (!suggestions.size) {
      for (const unit of activeConfigurations) {
        if (group?.candidateIds.has(unit.id) ||
          unit.normalizedMatchAliases.some((alias) => matchesOrderAlias(unit, alias, orderName, option))) {
          suggestions.add(unit.id);
        }
      }
    }
    if (!hasFamilyEvidence && !suggestions.size) continue;
    if (suggestions.size) {
      suggestions.forEach((id) => reviewIds.add(id));
    } else {
      activeIds.forEach((id) => reviewIds.add(id));
    }
    candidates.push({
      ...label,
      externalProductId: signature.sampleExternalProductId,
      optionCode: signature.sampleOptionCode,
      optionManageCode: signature.sampleOptionManageCode,
      mappingStatus: getSignatureMappingStatus(signature),
      suggestedConfigurationIds: [...suggestions],
      lastSeenAt: signature.lastSeenAt,
    });
  }

  candidates.sort((left, right) =>
    (right.lastSeenAt ?? "").localeCompare(left.lastSeenAt ?? "") || right.usageCount - left.usageCount);
  return {
    states: new Map(configurations.map((unit) => {
      const mappedSignatureCount = mappedSignatures.get(unit.id) ?? 0;
      const orderItemCount = orderItems.get(unit.id) ?? 0;
      return [unit.id, {
        state: reviewIds.has(unit.id) ? "REVIEW" as const :
          mappedSignatureCount || orderItemCount ? "CONNECTED" as const : "WAITING" as const,
        mappedSignatureCount,
        orderItemCount,
      }];
    })),
    candidateCount: candidates.length,
    candidates: candidates.slice(0, MAX_CANDIDATES),
  };
}

function listAdvertisingEvidence(
  database: DatabaseShape,
  product: CanonicalSalesUnit,
  configurations: CanonicalSalesUnit[],
  date: string,
) {
  const storeId = product.storeId;
  const familyUnitIds = new Set([product.id, ...configurations.map((unit) => unit.id)]);
  const uploadIds = getActiveConfirmedUploadIds(database, storeId);
  const rules = getActiveCampaignMappings(database, storeId)
    .filter((mapping) => familyUnitIds.has(mapping.canonicalSalesUnitId));
  const keywords = [product, ...configurations]
    .filter((unit) => unit.isActive)
    .flatMap((unit) => unit.normalizedMatchAliases);
  const productName = normalizeMatchAlias(product.displayName);
  if (product.isActive && productName.length >= 2) keywords.push(productName);
  const connectedCampaigns = new Set<string>();
  const candidateByCampaign = new Map<string, typeof database.adCampaignDailyCosts[number]>();
  let dateCost = 0;

  for (const campaign of database.adCampaignDailyCosts) {
    if (campaign.storeId !== storeId || !uploadIds.has(campaign.sourceUploadId)) continue;
    const key = campaign.adCampaignSignatureId || campaign.campaignId || campaign.normalizedCampaignName;
    if (campaign.canonicalSalesUnitId && familyUnitIds.has(campaign.canonicalSalesUnitId)) {
      connectedCampaigns.add(key);
      if (campaign.reportDate === date) dateCost += campaign.totalCost;
      continue;
    }
    if (campaign.canonicalSalesUnitId || campaign.mappingReason === "INTENTIONALLY_UNMAPPED") continue;
    const compactName = normalizeMatchAlias(campaign.normalizedCampaignName);
    if (!keywords.some((keyword) => keyword && compactName.includes(keyword)) &&
      !rules.some((rule) => campaign.normalizedCampaignName.includes(rule.normalizedCampaignPattern))) continue;
    const previous = candidateByCampaign.get(key);
    if (!previous || campaign.reportDate > previous.reportDate) candidateByCampaign.set(key, campaign);
  }

  const candidates = [...candidateByCampaign.values()]
    .sort((left, right) => right.reportDate.localeCompare(left.reportDate));
  const declaredNotAdvertised = product.advertisingNotPlanned === true;
  return {
    state: candidates.length ? "REVIEW" as const : connectedCampaigns.size ? "CONNECTED" as const :
      declaredNotAdvertised ? "NOT_ADVERTISED" as const : "WAITING" as const,
    declaredNotAdvertised,
    activeRuleCount: rules.length,
    campaignCount: connectedCampaigns.size,
    dateCost,
    candidateCount: candidates.length,
    candidates: candidates.slice(0, MAX_CANDIDATES).map((campaign) => ({
      id: campaign.id,
      campaignName: repairMojibakeText(campaign.campaignName),
      reportDate: campaign.reportDate,
      totalCost: campaign.totalCost,
      mappingReason: campaign.mappingReason,
    })),
  };
}

@Injectable()
export class ProductStatusService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly profitSummaryService: ProfitSummaryService,
    private readonly storeService: StoreService,
    private readonly auditLogService: AuditLogService,
  ) {}

  getOrderContext(storeId: string, signatures: string | string[] = []) {
    const database = this.databaseService.getSnapshot();
    ensureStoreExists(database, storeId);
    const ids = [...new Set(Array.isArray(signatures) ? signatures : [signatures])];
    if (ids.length > MAX_CONTEXT_SIGNATURES || ids.some((id) => typeof id !== "string" || !id.trim())) {
      throw new BadRequestException("주문 조합을 최대 100개까지 선택할 수 있습니다.");
    }
    const requestedIds = new Set(ids);
    const byId = new Map(database.orderSourceSignatures
      .filter((signature) => signature.storeId === storeId && requestedIds.has(signature.id))
      .map((signature) => [signature.id, getOrderLabel(signature)]));
    if (byId.size !== ids.length) {
      throw new NotFoundException("선택한 주문 조합 중 이 스토어에서 찾을 수 없는 항목이 있습니다.");
    }
    return formatApiSuccess({ items: ids.map((id) => byId.get(id)!) });
  }

  getCostCoverage(storeId: string, requestedDate?: string) {
    const database = this.databaseService.getSnapshot();
    ensureStoreExists(database, storeId);
    const date = resolveDate(requestedDate);
    const units = database.canonicalSalesUnits.filter((unit) =>
      unit.storeId === storeId && unit.isActive && !unit.isGroup && !unit.isStoreLevel);
    const readCost = buildCostReader(database, storeId, date, new Set(units.map((unit) => unit.id)));
    return formatApiSuccess({ date, items: units.map((unit) => ({ id: unit.id, unitCost: readCost(unit.id)?.unitCost ?? null })) });
  }

  getProductStatus(storeId: string, salesUnitId: string, requestedDate?: string) {
    const database = this.databaseService.getSnapshot();
    ensureStoreExists(database, storeId);
    const date = resolveDate(requestedDate);
    const units = database.canonicalSalesUnits.filter((unit) => unit.storeId === storeId);
    const product = getProduct(units, salesUnitId);
    const configurations = product.isGroup
      ? units.filter((unit) => unit.parentSalesUnitId === product.id && !unit.isGroup && !unit.isStoreLevel)
      : [product];
    // ISO timestamps tie when multiple configurations were created together. Preserve stored row order.
    configurations.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    const ids = new Set(configurations.map((unit) => unit.id));
    const readCost = buildCostReader(database, storeId, date, ids);
    const order = listOrderEvidence(database, product, configurations, date);
    const advertising = listAdvertisingEvidence(database, product, configurations, date);
    const profitRows = this.profitSummaryService.listDailySalesUnitRows({
      storeId,
      dateFrom: date,
      dateTo: date,
      canonicalSalesUnitId: product.id,
      includeGroupChildren: true,
    }) ?? calculateDailyProfitRows(database, storeId, date, date, product.id, true);
    const profitById = new Map(profitRows.flatMap((row) => [row, ...(row.childRows ?? [])])
      .map((row) => [row.canonicalSalesUnitId, row]));

    return formatApiSuccess({
      storeId,
      date,
      product: {
        id: product.id,
        displayName: product.displayName,
        isGroup: product.isGroup,
        isActive: product.isActive,
      },
      configurations: configurations.map((unit) => ({
        id: unit.id,
        displayName: unit.displayName,
        isActive: unit.isActive,
        cost: readCost(unit.id),
        order: order.states.get(unit.id)!,
        profit: getProfitStatus(profitById.get(unit.id)),
      })),
      orderCandidateCount: order.candidateCount,
      orderCandidates: order.candidates,
      advertising,
      profit: getProfitStatus(profitById.get(product.id)),
    });
  }

  async setAdvertisingStatus(salesUnitId: string, payload: { storeId?: string; notAdvertised?: boolean }) {
    if (!payload?.storeId || typeof payload.notAdvertised !== "boolean") {
      throw new BadRequestException("스토어와 광고 집행 여부를 확인해 주세요.");
    }
    const { storeId, notAdvertised } = payload;
    this.storeService.ensureWritable(storeId);
    await this.databaseService.writeCommitted((draft) => {
      const product = getProduct(draft.canonicalSalesUnits.filter((unit) => unit.storeId === storeId), salesUnitId);
      const previous = product.advertisingNotPlanned === true;
      if (previous === notAdvertised) return;
      if (notAdvertised) product.advertisingNotPlanned = true;
      else delete product.advertisingNotPlanned;
      product.updatedAt = nowIso();
      this.auditLogService.appendToDraft(draft, {
        storeId,
        domain: "SALES_UNIT",
        action: "UPDATE_ADVERTISING_STATUS",
        targetId: product.id,
        actorIdentifier: "LOCALHOST_ADMIN",
        beforeJson: { notAdvertised: previous },
        afterJson: { notAdvertised },
      });
    }, ["canonicalSalesUnits", "auditLogs"]);
    return formatApiSuccess({ notAdvertised });
  }
}
