import {
  CanonicalSalesUnit,
  DatabaseShape,
  normalizeMatchAlias,
  normalizeText,
  OrderSourceSignature,
} from "@patima/shared";

interface Variant {
  unit: CanonicalSalesUnit;
  pack: string | null;
  gender: string;
  qualifier: string;
}

interface Group {
  unit: CanonicalSalesUnit;
  variants: Variant[];
}

export interface OrderGroupMatch {
  matchSource: "option" | "product";
  optionOverridesProduct: boolean;
  /** Includes inactive siblings so deactivation cannot turn an ambiguous choice into a default. */
  groupIds: Set<string>;
  familyUnitIds: Set<string>;
  /** Inactive matching siblings remain here as ambiguity evidence, but can never be assigned. */
  candidateIds: Set<string>;
}

const orderText = (value: string) => normalizeText(value.normalize("NFKC"));
const orderProductText = (value: string) =>
  /^NAVER_PRODUCT_/i.test(value.trim()) ? "" : orderText(value);
const compact = (value: string) =>
  orderText(value).replace(/[^\p{L}\p{N}+]/gu, "");
const oneValue = (values: string[]): string | null => {
  const unique = [...new Set(values)];
  return unique.length === 1
    ? unique[0]
    : unique.length > 1
      ? "CONFLICT"
      : null;
};

// Read package markers before alias normalization, which removes '+' punctuation.
const packFrom = (text: string): string | null => {
  text = orderText(text);
  const values: string[] = [];
  const remaining = text.replace(
    /(?<!\d)\d+(?:\s*개(?:입)?)?(?:\s*\+\s*\d+(?:\s*개(?:입)?)?)+(?!\d)/g,
    (match) => {
      values.push(String(match.split("+").reduce(
        (sum, part) => sum + Number(part.replace(/개(?:입)?/g, "").trim()),
        0,
      )));
      return " ";
    },
  );
  if (/단품|낱개/.test(text)) values.push("1");
  for (const match of remaining.matchAll(/(?<!\d)(\d+)\s*개(?:입)?/g))
    values.push(String(Number(match[1])));
  return oneValue(values);
};

const genderFrom = (text: string): string | null => {
  text = orderText(text);
  if (/남녀\s*공용|남여\s*공용|유니섹스/.test(text)) return "general";
  const values: string[] = [];
  if (/여성|여자/.test(text)) values.push("female");
  if (/남성|남자/.test(text)) values.push("male");
  return oneValue(values);
};

/** Preserve quantity/gender meaning that punctuation-insensitive keyword normalization loses. */
export const matchesOrderAlias = (
  unit: CanonicalSalesUnit,
  alias: string,
  productText: string,
  optionText: string,
): boolean => {
  if (!alias) return false;
  const product = orderProductText(productText);
  const option = orderText(optionText);
  const rawAliases = (unit.matchAliases ?? []).filter(
    (raw) => normalizeMatchAlias(raw) === alias,
  );
  const candidates = rawAliases.length ? rawAliases : [alias];
  return candidates.some((raw) => {
    const rawNormalized = orderText(raw);
    const normalized = normalizeMatchAlias(rawNormalized);
    if (!normalizeMatchAlias(`${product} ${option}`).includes(normalized))
      return false;
    // A legacy numeric-only normalized keyword may be a flattened 1+1, so it is not sufficient evidence.
    if (/^\d+$/.test(normalized)) {
      if (!rawAliases.length) return false;
      if (
        /^\d+$/.test(rawNormalized) &&
        !new RegExp(`(?<!\\d)${rawNormalized}(?!\\d)`).test(`${product} ${option}`)
      )
        return false;
    }
    const aliasPack = packFrom(rawNormalized);
    const aliasGender = genderFrom(rawNormalized);
    return (
      (!aliasPack ||
        (aliasPack !== "CONFLICT" &&
          aliasPack === (packFrom(option) ?? packFrom(product)))) &&
      (!aliasGender ||
        (aliasGender !== "CONFLICT" &&
          aliasGender === (genderFrom(option) ?? genderFrom(product))))
    );
  });
};

const profile = (
  unit: CanonicalSalesUnit,
  group: CanonicalSalesUnit,
): Variant => {
  const name = compact(unit.displayName);
  const base = compact(group.displayName);
  // Only a child's differentiating suffix is a fallback rule; display names are not global keywords.
  const suffix = name.startsWith(base) ? name.slice(base.length) : "";
  return {
    unit,
    pack: packFrom(suffix),
    gender: genderFrom(suffix) ?? "general",
    qualifier: suffix.replace(
      /\d+(?:개입?)?(?:\+\d+(?:개입?)?)+|\d+개입?|단품|낱개|여성용?|여자용?|남성용?|남자용?|남녀공용|남여공용|유니섹스/g,
      "",
    ),
  };
};

export const createOrderGroupContext = (
  database: Pick<DatabaseShape, "canonicalSalesUnits">,
  storeId: string,
): Group[] => {
  const units = database.canonicalSalesUnits.filter(
    (unit) => unit.storeId === storeId,
  );
  return units
    .filter(
      (unit) =>
        unit.isActive && unit.isGroup && unit.normalizedMatchAliases?.length,
    )
    .map((unit) => ({
      unit,
      variants: units
        .filter(
          (child) => !child.isGroup && child.parentSalesUnitId === unit.id,
        )
        .map((child) => profile(child, unit)),
    }));
};

/** Identify the family first, then intersect explicit child keywords and variant conditions. */
export const matchOrderGroup = (
  groups: Group[],
  signature: OrderSourceSignature,
): OrderGroupMatch | null => {
  const product = orderProductText(
    signature.rawProductNameSnapshot || signature.normalizedProductName,
  );
  const option = orderText(
    signature.rawOptionInfoSnapshot || signature.normalizedOptionInfo,
  );
  const bundled = /\[함께배송/.test(option);
  const matches = (group: Group, text: string) =>
    group.unit.normalizedMatchAliases.some(
      (alias) => matchesOrderAlias(group.unit, alias, text, ""),
    );
  const optionGroups = groups.filter(
    (group) =>
      matches(group, option) ||
      // A full group name can disambiguate an option only after a configured keyword identified its family.
      (matches(group, product) &&
        normalizeMatchAlias(option).includes(
          normalizeMatchAlias(group.unit.displayName),
        )),
  );
  // A selected option (especially an add-on) can name a different family from the listing title.
  const matched = optionGroups.length
    ? optionGroups
    : bundled
      ? []
      : groups.filter((group) => matches(group, product));
  if (!matched.length) return null;
  const result: OrderGroupMatch = {
    matchSource: optionGroups.length ? "option" : "product",
    optionOverridesProduct:
      bundled ||
      optionGroups.some((group) =>
        normalizeMatchAlias(option).includes(
          normalizeMatchAlias(group.unit.displayName),
        ),
      ),
    groupIds: new Set(matched.map((group) => group.unit.id)),
    familyUnitIds: new Set(
      matched.flatMap((group) =>
        group.variants.map((variant) => variant.unit.id),
      ),
    ),
    candidateIds: new Set(),
  };
  const scopedProduct =
    bundled ||
    (optionGroups.length &&
      !optionGroups.some((group) => matches(group, product)))
      ? ""
      : product;
  const pack = packFrom(option) ?? packFrom(scopedProduct);
  const gender = genderFrom(option) ?? genderFrom(scopedProduct);
  if (pack === "CONFLICT" || gender === "CONFLICT") return result;
  // Missing/opaque numeric options carry no evidence for the unmarked single/general variant.
  const hasSelectedDetails = /[:：]\s*[^/:：]*\p{L}/u.test(option);
  for (const group of matched) {
    let variants = group.variants;
    const childAliasMatches = variants.filter(({ unit }) =>
      unit.normalizedMatchAliases?.some(
        (alias) => matchesOrderAlias(unit, alias, scopedProduct, option),
      ),
    );
    const explicitChild = childAliasMatches.length === 1;
    if (childAliasMatches.length) variants = childAliasMatches;
    const packs = new Set(group.variants.map((variant) => variant.pack));
    if (pack)
      variants = variants.filter(
        (variant) => variant.pack === pack || variant.pack === null,
      );
    else if (!explicitChild && packs.size > 1 && hasSelectedDetails)
      variants = variants.filter((variant) => variant.pack === "1");
    const genders = new Set(group.variants.map((variant) => variant.gender));
    if (gender) {
      const expected =
        gender === "male" && !genders.has("male") ? "general" : gender;
      // A gender marker is relevant only when this family actually has gender-specific variants.
      if (genders.size > 1 || !genders.has("general"))
        variants = variants.filter((variant) => variant.gender === expected);
    } else if (!explicitChild && genders.size > 1 && hasSelectedDetails)
      variants = variants.filter((variant) => variant.gender === "general");
    const qualified = group.variants.filter(
      (variant) =>
        variant.qualifier &&
        compact(`${scopedProduct} ${option}`).includes(variant.qualifier),
    );
    if (!explicitChild)
      variants = variants.filter((variant) =>
        variant.qualifier ? qualified.includes(variant) : qualified.length === 0,
      );
    for (const variant of variants) result.candidateIds.add(variant.unit.id);
  }
  return result;
};
