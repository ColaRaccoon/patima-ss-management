import { BadRequestException } from "@nestjs/common";
import type { DatabaseShape, SalesUnitCostSetting } from "@patima/shared";
import { createId } from "./helpers";

type CostSettingValues = Pick<SalesUnitCostSetting,
  "storeId" | "canonicalSalesUnitId" | "unitCost" | "feeRate" | "otherCost" | "effectiveFrom"
>;

export function validateCostSettingValues(unitCost: number, otherCost: number, feeRate: number | null) {
  if (!Number.isFinite(unitCost) || !Number.isFinite(otherCost) || unitCost < 0 || otherCost < 0) {
    throw new BadRequestException({
      success: false,
      message: "원가와 기타비용은 0 이상이어야 합니다.",
      errors: [{ field: "unitCost", reason: "INVALID_VALUE" }],
    });
  }
  if (feeRate != null && (!Number.isFinite(feeRate) || feeRate < 0 || feeRate > 1)) {
    throw new BadRequestException({
      success: false,
      message: "수수료율은 0% 이상 100% 이하여야 합니다.",
      errors: [{ field: "feeRate", reason: "INVALID_VALUE" }],
    });
  }
}

export function buildCostSettingRecord(
  values: CostSettingValues,
  timestamp: string,
  effectiveTo: string | null = null,
): SalesUnitCostSetting {
  return {
    id: createId(),
    storeId: values.storeId,
    canonicalSalesUnitId: values.canonicalSalesUnitId,
    unitCost: values.unitCost,
    feeRate: values.feeRate,
    otherCost: values.otherCost,
    effectiveFrom: values.effectiveFrom,
    effectiveTo,
    isActive: true,
    deactivatedAt: null,
    costValuesUpdatedAt: timestamp,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

export function hasOrdersInCostPeriod(database: DatabaseShape, cost: SalesUnitCostSetting) {
  return database.orderItems.some((order) =>
    order.storeId === cost.storeId && order.canonicalSalesUnitId === cost.canonicalSalesUnitId &&
    order.paymentDate && order.paymentDate >= cost.effectiveFrom &&
    (!cost.effectiveTo || order.paymentDate <= cost.effectiveTo),
  );
}

function dayBefore(date: string) {
  const value = new Date(date + "T00:00:00Z");
  value.setUTCDate(value.getUTCDate() - 1);
  return value.toISOString().slice(0, 10);
}

export function saveProductCost(
  draft: DatabaseShape,
  scope: Pick<CostSettingValues, "storeId" | "canonicalSalesUnitId">,
  previous: SalesUnitCostSetting | undefined,
  values: Omit<CostSettingValues, "storeId" | "canonicalSalesUnitId"> | null,
  timestamp: string,
) {
  const applied = previous && hasOrdersInCostPeriod(draft, previous);
  if (!values) {
    if (!previous || applied) throw new BadRequestException("엑셀에서 적용되었거나 주문에 사용된 원가는 이 화면에서 비울 수 없습니다.");
    Object.assign(previous, { isActive: false, deactivatedAt: timestamp, updatedAt: timestamp });
    return previous.effectiveFrom;
  }

  const active = draft.salesUnitCostSettings.filter((cost) => cost.isActive &&
    cost.storeId === scope.storeId && cost.canonicalSalesUnitId === scope.canonicalSalesUnitId);
  if (previous && !applied) {
    if ((previous.effectiveTo && values.effectiveFrom > previous.effectiveTo) || active.some((row) =>
      row.id !== previous.id && row.effectiveFrom <= (previous.effectiveTo ?? "9999-12-31") &&
      (row.effectiveTo ?? "9999-12-31") >= values.effectiveFrom,
    )) {
      throw new BadRequestException("변경한 원가 적용일이 다른 개별 설정과 겹칩니다.");
    }
    const from = previous.effectiveFrom < values.effectiveFrom ? previous.effectiveFrom : values.effectiveFrom;
    Object.assign(previous, values, { updatedAt: timestamp, costValuesUpdatedAt: timestamp });
    return from;
  }
  if (previous && values.effectiveFrom <= previous.effectiveFrom) {
    throw new BadRequestException("주문에 사용된 원가입니다. 기존 적용일보다 늦은 날짜에 새 원가를 설정해 주세요.");
  }
  if (active.some((row) => row.effectiveFrom === values.effectiveFrom)) {
    throw new BadRequestException("이 적용일에 이미 개별 원가가 있습니다. 해당 기준일을 조회해 수정해 주세요.");
  }

  active.sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
  const preceding = active.filter((row) => row.effectiveFrom < values.effectiveFrom).at(-1);
  const following = active.find((row) => row.effectiveFrom > values.effectiveFrom);
  if (preceding && (!preceding.effectiveTo || preceding.effectiveTo >= values.effectiveFrom)) {
    preceding.costValuesUpdatedAt ??= preceding.updatedAt;
    preceding.effectiveTo = dayBefore(values.effectiveFrom);
    preceding.updatedAt = timestamp;
  }
  draft.salesUnitCostSettings.push(buildCostSettingRecord(
    { ...scope, ...values },
    timestamp,
    following ? dayBefore(following.effectiveFrom) : null,
  ));
  return values.effectiveFrom;
}
