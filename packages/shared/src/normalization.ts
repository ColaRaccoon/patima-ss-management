export const normalizeText = (value: string | null | undefined): string => {
  if (value == null) {
    return "";
  }

  return value
    .normalize("NFC")
    .replace(/[\t\r\n]+/g, " ")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
};

const MATCH_ALIAS_PATTERN = /[^\p{L}\p{N}]+/gu;

export const normalizeMatchAlias = (value: string | null | undefined): string =>
  normalizeText(value).replace(MATCH_ALIAS_PATTERN, "");

export const createSourceSignature = (
  productName: string | null | undefined,
  optionInfo: string | null | undefined,
): string => {
  return `${normalizeText(productName)} || ${normalizeText(optionInfo)}`;
};

export const toDisplaySourceSignature = (
  productName: string | null | undefined,
  optionInfo: string | null | undefined,
): string => {
  return `${productName ?? ""} || ${optionInfo ?? ""}`;
};
