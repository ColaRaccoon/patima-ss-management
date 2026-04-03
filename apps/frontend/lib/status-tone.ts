import type {
  OperationStatus,
  ProfitStatus,
  SaleStatus,
  WeekdayValidationStatus,
} from "@patima/shared";
import type { StatusTone } from "@/components/shared/status-badge";

export function toneForOperationStatus(status: OperationStatus): StatusTone {
  if (status === "SUCCEEDED") {
    return "success";
  }
  if (status === "FAILED") {
    return "danger";
  }
  if (status === "RUNNING") {
    return "accent";
  }
  return "warning";
}

export function toneForProfitStatus(status: ProfitStatus): StatusTone {
  return status === "COMPLETE" ? "success" : "warning";
}

export function toneForSaleStatus(status: SaleStatus): StatusTone {
  if (status === "SALE") {
    return "success";
  }
  if (status === "UNKNOWN") {
    return "warning";
  }
  return "muted";
}

export function toneForWeekdayValidation(
  status: WeekdayValidationStatus,
): StatusTone {
  if (status === "PASSED") {
    return "success";
  }
  if (status === "PENDING") {
    return "muted";
  }
  return "danger";
}

export function toneForActive(active: boolean): StatusTone {
  return active ? "success" : "muted";
}
