const currencyFormatter = new Intl.NumberFormat("ko-KR", {
  style: "currency",
  currency: "KRW",
  maximumFractionDigits: 0,
});

const numberFormatter = new Intl.NumberFormat("ko-KR");
const decimalFormatter = new Intl.NumberFormat("ko-KR", {
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
});

const dateFormatter = new Intl.DateTimeFormat("ko-KR", {
  year: "numeric",
  month: "long",
  day: "numeric",
  timeZone: "Asia/Seoul",
});

const dateTimeFormatter = new Intl.DateTimeFormat("ko-KR", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "Asia/Seoul",
  hour12: false,
});

export function formatCurrency(value: number | null | undefined) {
  if (value == null) {
    return "미산정";
  }

  return currencyFormatter.format(value);
}

export function formatNumber(value: number | null | undefined) {
  if (value == null) {
    return "-";
  }

  return numberFormatter.format(value);
}

export function formatDecimal(value: number | null | undefined) {
  if (value == null) {
    return "-";
  }

  return decimalFormatter.format(value);
}

export function formatPercent(value: number | null | undefined) {
  if (value == null) {
    return "-";
  }

  return `${decimalFormatter.format(value * 100)}%`;
}

export function formatDate(value: string | null | undefined) {
  if (!value) {
    return "-";
  }

  return dateFormatter.format(new Date(value));
}

export function formatDateTime(value: string | null | undefined) {
  if (!value) {
    return "-";
  }

  return dateTimeFormatter.format(new Date(value));
}

export function formatDateRange(from: string, to: string) {
  return `${formatDate(from)} - ${formatDate(to)}`;
}

export function formatNullableText(value: string | null | undefined) {
  return value && value.trim().length > 0 ? value : "-";
}
