import assert from "node:assert/strict";
import {
  CanonicalSalesUnit,
  createSourceSignature,
  DatabaseShape,
  normalizeMatchAlias,
  normalizeText,
  OrderItem,
  OrderSourceSignature,
} from "@patima/shared";
import { createEmptyDatabase } from "./helpers";
import {
  recalculateOrderMappingsForStore,
  recalculateOrderMappingsForTouchedItems,
} from "./sales-unit-auto-mapper";

const timestamp = "2026-11-11T00:00:00.000Z";
const storeId = "group-mapping-test-store";

const salesUnit = (
  id: string,
  displayName: string,
  extra: Partial<CanonicalSalesUnit> = {},
): CanonicalSalesUnit => {
  const aliases = extra.matchAliases ?? [];
  return {
    id,
    storeId,
    displayName,
    matchAliases: aliases,
    normalizedMatchAliases: aliases.map(normalizeMatchAlias),
    linkedProductIds: [],
    linkedOptionCodes: [],
    linkedManageCodes: [],
    memo: null,
    isActive: true,
    deactivatedAt: null,
    isStoreLevel: false,
    parentSalesUnitId: null,
    isGroup: false,
    createdAt: timestamp,
    updatedAt: timestamp,
    ...extra,
  };
};

const signature = (
  id: string,
  productName: string,
  optionInfo: string | null,
  extra: Partial<OrderSourceSignature> = {},
): OrderSourceSignature => ({
  id,
  storeId,
  sourceSignature: createSourceSignature(productName, optionInfo ?? ""),
  rawProductNameSnapshot: productName,
  rawOptionInfoSnapshot: optionInfo,
  normalizedProductName: normalizeText(productName),
  normalizedOptionInfo: normalizeText(optionInfo ?? ""),
  canonicalSalesUnitId: null,
  mappingStatus: "UNMAPPED",
  confirmedAt: null,
  usageCount: 1,
  firstSeenAt: timestamp,
  lastSeenAt: timestamp,
  sampleExternalProductId: null,
  sampleOptionCode: null,
  sampleOptionManageCode: null,
  lastAutoMappedAt: null,
  mappingRuleHash: null,
  createdAt: timestamp,
  updatedAt: timestamp,
  ...extra,
});

const orderItem = (
  id: string,
  source: OrderSourceSignature,
  extra: Partial<OrderItem> = {},
): OrderItem => ({
  id,
  orderId: `order-${id}`,
  storeId: source.storeId,
  productId: null,
  orderSourceSignatureId: source.id,
  canonicalSalesUnitId: null,
  externalProductOrderId: `synthetic-${id}`,
  externalProductId: null,
  optionCode: null,
  packageNumber: null,
  rawProductName: source.rawProductNameSnapshot,
  rawOptionInfo: source.rawOptionInfoSnapshot,
  normalizedProductName: source.normalizedProductName,
  normalizedOptionInfo: source.normalizedOptionInfo,
  sourceSignature: source.sourceSignature,
  quantity: 1,
  productPaymentAmount: 10000,
  totalProductAmount: 10000,
  deliveryFeeAmount: 0,
  paymentCommission: null,
  knowledgeShoppingSellingInterlockCommission: null,
  saleCommission: null,
  channelCommission: null,
  orderDate: "2026-11-11",
  paymentDate: "2026-11-11",
  saleStatus: "SALE",
  orderStatus: "PAYED",
  isCanceled: false,
  isReturned: false,
  rawPayload: null,
  createdAt: timestamp,
  updatedAt: timestamp,
  ...extra,
});

const addOrder = (
  database: DatabaseShape,
  id: string,
  productName: string,
  optionInfo: string | null,
  itemExtra: Partial<OrderItem> = {},
  signatureExtra: Partial<OrderSourceSignature> = {},
) => {
  const source = signature(`signature-${id}`, productName, optionInfo, signatureExtra);
  const item = orderItem(id, source, itemExtra);
  database.orderSourceSignatures.push(source);
  database.orderItems.push(item);
  return { source, item };
};

const addPackGroup = (database: DatabaseShape, id = "socks", name = "테스트 양말") => {
  const group = salesUnit(`${id}-group`, name, { isGroup: true, matchAliases: [name] });
  const single = salesUnit(`${id}-single`, `${name} 단품`, { parentSalesUnitId: group.id });
  const double = salesUnit(`${id}-double`, `${name} 1+1`, { parentSalesUnitId: group.id });
  database.canonicalSalesUnits.push(group, single, double);
  return { group, single, double };
};

const assertMapped = (
  order: ReturnType<typeof addOrder>,
  unit: CanonicalSalesUnit,
): void => {
  assert.equal(order.item.canonicalSalesUnitId, unit.id, "the order must receive the selected leaf");
  assert.equal(order.source.canonicalSalesUnitId, unit.id, "the signature and order must agree");
  assert.equal(order.source.mappingStatus, "MAPPED");
  assert.equal(order.source.confirmedAt, null, "automatic mapping must not become a manual decision");
};

const assertUnresolved = (order: ReturnType<typeof addOrder>): void => {
  assert.equal(order.item.canonicalSalesUnitId, null, "insufficient or ambiguous evidence must not pick a child");
  assert.equal(order.source.canonicalSalesUnitId, null);
  assert.notEqual(order.source.mappingStatus, "MAPPED");
};

const run = (name: string, test: () => void): void => {
  test();
  console.log(`PASS order group mapping: ${name}`);
};

export function runOrderGroupMappingTests(): void {
  run("a group keyword selects alias-free single and 1+1 children", () => {
    const database = createEmptyDatabase();
    const { single, double } = addPackGroup(database);
    const one = addOrder(database, "single", "오늘의 테스트 양말", "구성: 단품 / 색상: 검정");
    const two = addOrder(database, "double", "오늘의 테스트 양말", "구성: 1+1 / 색상: 검정");

    recalculateOrderMappingsForStore(database, storeId);

    assertMapped(one, single);
    assertMapped(two, double);
  });

  run("new daily signatures use saved group keywords without repeated confirmation", () => {
    const database = createEmptyDatabase();
    const { double } = addPackGroup(database);
    const first = addOrder(database, "day-one", "테스트 양말 주말행사", "구성: 1+1 / 색상: 흰색");
    recalculateOrderMappingsForStore(database, storeId);
    assertMapped(first, double);
    const firstBefore = structuredClone(first);
    const next = addOrder(database, "day-two", "테스트 양말 다음날행사".normalize("NFD"), "구성: 1 + 1 / 색상: 검정");
    assert.notEqual(first.source.sourceSignature, next.source.sourceSignature);

    recalculateOrderMappingsForTouchedItems(database, {
      storeId,
      signatureIds: [next.source.id],
      orderItemIds: [next.item.id],
    });

    assertMapped(next, double);
    assert.deepEqual(first, firstBefore, "a new sync must not rewrite a different daily signature or order");
  });

  run("chained package counts cannot silently become 1+1", () => {
    const database = createEmptyDatabase();
    const { group } = addPackGroup(database);
    const missingTriple = addOrder(database, "missing-triple", "테스트 양말", "구성: 1+1+1 / 색상: 검정");
    recalculateOrderMappingsForStore(database, storeId);
    assertUnresolved(missingTriple);

    const triple = salesUnit("socks-triple", "테스트 양말 1+1+1", { parentSalesUnitId: group.id });
    database.canonicalSalesUnits.push(triple);
    const spacedTriple = addOrder(database, "spaced-triple", "테스트 양말", "구성: 1 + 1 + 1 / 색상: 흰색");
    const countTriple = addOrder(database, "count-triple", "테스트 양말", "구성: 3개 / 색상: 검정");
    const suffixedTriple = addOrder(database, "suffix-triple", "테스트 양말", "구성: 1+1+1개 / 색상: 검정");
    const separatedTriple = addOrder(database, "separated-triple", "테스트 양말", "구성: 1개+1개+1개 / 색상: 검정");
    recalculateOrderMappingsForStore(database, storeId);
    assertMapped(missingTriple, triple);
    assertMapped(spacedTriple, triple);
    assertMapped(countTriple, triple);
    assertMapped(suffixedTriple, triple);
    assertMapped(separatedTriple, triple);
  });

  run("fullwidth package punctuation and digits retain the selected quantity", () => {
    const database = createEmptyDatabase();
    const { double } = addPackGroup(database);
    const plus = addOrder(database, "fullwidth-plus", "테스트 양말", "구성: 1＋1 / 색상: 검정");
    const digits = addOrder(database, "fullwidth-digits", "테스트 양말", "구성：１＋１ / 색상：검정");
    recalculateOrderMappingsForStore(database, storeId);
    assertMapped(plus, double);
    assertMapped(digits, double);
  });

  run("quantity keywords cannot match unrelated numeric sizes in groups or standalone products", () => {
    const database = createEmptyDatabase();
    const { double } = addPackGroup(database);
    double.matchAliases = ["1+1"];
    double.normalizedMatchAliases = double.matchAliases.map(normalizeMatchAlias);
    const size = addOrder(database, "numeric-child-size", "테스트 양말", "사이즈: 110");
    const selected = addOrder(database, "explicit-double-alias", "테스트 양말", "구성: 1+1");
    recalculateOrderMappingsForStore(database, storeId);
    assertUnresolved(size);
    assertMapped(selected, double);

    for (const legacy of [false, true]) {
      const standaloneDatabase = createEmptyDatabase();
      standaloneDatabase.canonicalSalesUnits.push(salesUnit("numeric-standalone", "숫자 키워드 테스트품", {
        matchAliases: legacy ? [] : ["1+1"],
        normalizedMatchAliases: ["11"],
      }));
      const unrelated = addOrder(standaloneDatabase, `numeric-standalone-${legacy}`, "별도 상품", "사이즈: 110");
      recalculateOrderMappingsForStore(standaloneDatabase, storeId);
      assertUnresolved(unrelated);
    }

    const numericFamilyDatabase = createEmptyDatabase();
    const numericFamily = addPackGroup(numericFamilyDatabase);
    numericFamily.group.matchAliases = ["1+1"];
    numericFamily.group.normalizedMatchAliases = ["11"];
    const numericFamilyOrder = addOrder(numericFamilyDatabase, "numeric-family", "별도 상품", "사이즈: 110");
    recalculateOrderMappingsForStore(numericFamilyDatabase, storeId);
    assertUnresolved(numericFamilyOrder);
  });

  run("explicit child keywords cannot override contradictory selected package or gender", () => {
    const database = createEmptyDatabase();
    const { group, double } = addPackGroup(database);
    double.matchAliases = ["더블 구성"];
    double.normalizedMatchAliases = double.matchAliases.map(normalizeMatchAlias);
    const female = salesUnit("female-special", "테스트 양말 여성용 단품", {
      parentSalesUnitId: group.id,
      matchAliases: ["여성 특별형", "슬림 특별형"],
    });
    database.canonicalSalesUnits.push(female);
    const conflictingPack = addOrder(database, "keyword-pack-conflict", "테스트 양말", "선택: 더블 구성 / 구성: 단품");
    const conflictingGender = addOrder(database, "keyword-gender-conflict", "테스트 양말 여성 특별형", "대상: 남성용 / 구성: 단품");
    const neutralGenderAlias = addOrder(database, "neutral-keyword-gender-conflict", "테스트 양말", "선택: 슬림 특별형 / 대상: 남성용 / 구성: 단품");
    const explicitKeyword = addOrder(database, "keyword-only-double", "테스트 양말", "선택: 더블 구성");
    recalculateOrderMappingsForStore(database, storeId);
    assertUnresolved(conflictingPack);
    assert.notEqual(conflictingGender.item.canonicalSalesUnitId, female.id);
    assertUnresolved(neutralGenderAlias);
    assertMapped(explicitKeyword, double);

    const standaloneDatabase = createEmptyDatabase();
    standaloneDatabase.canonicalSalesUnits.push(salesUnit("female-standalone", "여성 테스트품", { matchAliases: ["여성용"] }));
    const selectedMale = addOrder(standaloneDatabase, "standalone-gender-conflict", "여성용 테스트품", "대상: 남성용");
    recalculateOrderMappingsForStore(standaloneDatabase, storeId);
    assertUnresolved(selectedMale);
  });

  run("generated missing-name placeholders cannot supply product keywords", () => {
    const database = createEmptyDatabase();
    database.canonicalSalesUnits.push(salesUnit("placeholder-collision", "숫자 키워드 상품", { matchAliases: ["12345"] }));
    const placeholder = addOrder(database, "placeholder-numeric", "NAVER_PRODUCT_12345", null);
    const { double } = addPackGroup(database);
    const selectedOption = addOrder(database, "placeholder-with-real-option", "NAVER_PRODUCT_12345", "선택: 테스트 양말 / 구성: 1+1");
    recalculateOrderMappingsForStore(database, storeId);
    assertUnresolved(placeholder);
    assertMapped(selectedOption, double);
  });

  run("explicit options permit the default single while empty or numeric-only options do not", () => {
    const database = createEmptyDatabase();
    const { single } = addPackGroup(database);
    const ordinary = addOrder(database, "ordinary", "테스트 양말", "색상: 검정 / 사이즈: M");
    const empty = addOrder(database, "empty", "테스트 양말", null);
    const numeric = addOrder(database, "numeric", "테스트 양말", "110");
    const flattenedPack = addOrder(database, "numeric-pack-collision", "테스트 양말", "11");

    recalculateOrderMappingsForStore(database, storeId);

    assertMapped(ordinary, single);
    assertUnresolved(empty);
    assertUnresolved(numeric);
    assertUnresolved(flattenedPack);
  });

  run("compound child variants require both pack and gender evidence", () => {
    const database = createEmptyDatabase();
    const group = salesUnit("support-group", "테스트 보호대", { isGroup: true, matchAliases: ["테스트 보호대"] });
    const children = [
      salesUnit("support-regular-single", "테스트 보호대 단품", { parentSalesUnitId: group.id }),
      salesUnit("support-regular-double", "테스트 보호대 1+1", { parentSalesUnitId: group.id }),
      salesUnit("support-female-single", "테스트 보호대 여성용 단품", { parentSalesUnitId: group.id }),
      salesUnit("support-female-double", "테스트 보호대 여성용 1+1", { parentSalesUnitId: group.id }),
    ];
    database.canonicalSalesUnits.push(group, ...children);
    const femaleSingle = addOrder(database, "female-single", "테스트 보호대", "대상: 여성용 / 구성: 단품");
    const femaleDouble = addOrder(database, "female-double", "테스트 보호대", "대상: 여성용 / 구성: 1+1");
    const ordinary = addOrder(database, "regular-single", "테스트 보호대", "색상: 검정 / 사이즈: L");
    const insufficient = addOrder(database, "female-unspecified", "테스트 보호대", "여성용");

    recalculateOrderMappingsForStore(database, storeId);

    assertMapped(femaleSingle, children[2]);
    assertMapped(femaleDouble, children[3]);
    assertMapped(ordinary, children[0]);
    assertUnresolved(insufficient);

    const femaleOnly = createEmptyDatabase();
    femaleOnly.canonicalSalesUnits.push(structuredClone(group), ...structuredClone(children.slice(2)));
    const contradictory = addOrder(femaleOnly, "male-with-female-only-leaves", "테스트 보호대", "대상: 남성용 / 구성: 단품");
    recalculateOrderMappingsForStore(femaleOnly, storeId);
    assertUnresolved(contradictory);
  });

  run("a child alias disambiguates its group and a standalone leaf alias still works", () => {
    const database = createEmptyDatabase();
    const group = salesUnit("bottle-group", "테스트 물병", { isGroup: true, matchAliases: ["테스트 물병"] });
    const basic = salesUnit("bottle-basic", "테스트 물병 기본형", { parentSalesUnitId: group.id, matchAliases: ["베이직 구성"] });
    const special = salesUnit("bottle-special", "테스트 물병 특별형", { parentSalesUnitId: group.id, matchAliases: ["스페셜 구성"] });
    const standalone = salesUnit("standalone", "독립 테스트품", { matchAliases: ["독립 테스트품"] });
    database.canonicalSalesUnits.push(group, basic, special, standalone);
    const child = addOrder(database, "child-alias", "테스트 물병", "선택: 스페셜 구성");
    const direct = addOrder(database, "direct-alias", "독립 테스트품", null);

    recalculateOrderMappingsForStore(database, storeId);

    assertMapped(child, special);
    assertMapped(direct, standalone);
  });

  run("an explicit leaf alias survives generic family words unless an option explicitly names another family", () => {
    const database = createEmptyDatabase();
    const generic = addPackGroup(database, "heat-change", "히트체인지 넥워머");
    generic.group.matchAliases = ["비니", "방한마스크"];
    generic.group.normalizedMatchAliases = generic.group.matchAliases.map(normalizeMatchAlias);
    const explicitGroup = salesUnit("balaclava-group", "바라클라바 베이직", { isGroup: true });
    const explicitLeaf = salesUnit("balaclava-single", "바라클라바 베이직 단품", {
      parentSalesUnitId: explicitGroup.id,
      matchAliases: ["바라클라바"],
    });
    database.canonicalSalesUnits.push(explicitGroup, explicitLeaf);
    const existing = addOrder(database, "specific-leaf-vs-generic-group", "바라클라바 방한마스크 비니", "색상: black", {
      canonicalSalesUnitId: explicitLeaf.id,
    }, {
      canonicalSalesUnitId: explicitLeaf.id,
      mappingStatus: "MAPPED",
    });
    const existingBefore = structuredClone(existing);
    const genericOption = addOrder(database, "generic-option-vs-title-alias", "바라클라바 방한마스크 비니", "선택: 비니 / 구성: 1+1", {
      canonicalSalesUnitId: explicitLeaf.id,
    }, {
      canonicalSalesUnitId: explicitLeaf.id,
      mappingStatus: "MAPPED",
    });
    const genericOptionBefore = structuredClone(genericOption);
    const selectedOption = addOrder(database, "selected-option-vs-title-alias", "바라클라바 방한마스크 비니", "선택: 히트체인지 넥워머 / 구성: 1+1");

    recalculateOrderMappingsForStore(database, storeId);

    assertMapped(existing, explicitLeaf);
    assert.deepEqual(existing, existingBefore, "a generic family keyword must not rewrite an existing explicit leaf mapping");
    assertMapped(genericOption, explicitLeaf);
    assert.deepEqual(genericOption, genericOptionBefore, "a generic option word must not override an explicit leaf alias either");
    assertMapped(selectedOption, generic.double);
  });

  run("option product keywords take precedence over a different main product group", () => {
    const database = createEmptyDatabase();
    addPackGroup(database);
    const { double } = addPackGroup(database, "support", "테스트 보호대");
    const bundled = addOrder(database, "option-product", "테스트 양말", "[함께배송] 테스트 보호대 / 구성: 1+1");

    recalculateOrderMappingsForStore(database, storeId);

    assertMapped(bundled, double);
  });

  run("generic child markers cannot identify a product family on their own", () => {
    const database = createEmptyDatabase();
    addPackGroup(database);
    addPackGroup(database, "support", "테스트 보호대");
    const unknown = addOrder(database, "unknown-family", "등록되지 않은 테스트 상품", "구성: 단품 / 색상: 검정");

    recalculateOrderMappingsForStore(database, storeId);

    assertUnresolved(unknown);
  });

  run("ambiguous group or child aliases never choose an arbitrary leaf", () => {
    const database = createEmptyDatabase();
    addPackGroup(database);
    addPackGroup(database, "other-socks", "테스트 양말 고급");
    const groupAmbiguity = addOrder(database, "group-ambiguity", "테스트 양말 고급", "구성: 단품");
    const group = salesUnit("alias-group", "테스트 장갑", { isGroup: true, matchAliases: ["테스트 장갑"] });
    database.canonicalSalesUnits.push(
      group,
      salesUnit("glove-first", "테스트 장갑 기본", { parentSalesUnitId: group.id, matchAliases: ["공통 구성"] }),
      salesUnit("glove-second", "테스트 장갑 보온", { parentSalesUnitId: group.id, matchAliases: ["공통 구성 고급"] }),
    );
    const childAmbiguity = addOrder(database, "child-ambiguity", "테스트 장갑", "공통 구성 고급");

    recalculateOrderMappingsForStore(database, storeId);

    assertUnresolved(groupAmbiguity);
    assertUnresolved(childAmbiguity);
  });

  run("group parents are never order targets even when legacy IDs are present", () => {
    const database = createEmptyDatabase();
    const { group } = addPackGroup(database);
    group.linkedProductIds = ["legacy-parent-product"];
    const parentOnly = addOrder(database, "parent-only", "테스트 양말", null, { externalProductId: "legacy-parent-product" });

    recalculateOrderMappingsForStore(database, storeId);

    assertUnresolved(parentOnly);
  });

  run("inactive children and other stores cannot become automatic group candidates", () => {
    const database = createEmptyDatabase();
    const { double } = addPackGroup(database);
    double.isActive = false;
    double.deactivatedAt = "2026-11-10T00:00:00.000Z";
    database.canonicalSalesUnits.push(salesUnit("foreign-double", "테스트 양말 1+1", {
      storeId: "another-store",
      parentSalesUnitId: "socks-group",
      matchAliases: ["테스트 양말"],
      linkedProductIds: ["foreign-product"],
    }));
    const unavailable = addOrder(database, "unavailable", "테스트 양말", "구성: 1+1", { externalProductId: "foreign-product" });

    recalculateOrderMappingsForStore(database, storeId);

    assertUnresolved(unavailable);
  });

  run("inactive groups do not supply family keywords to alias-free children", () => {
    const database = createEmptyDatabase();
    const { group } = addPackGroup(database);
    group.isActive = false;
    group.deactivatedAt = "2026-11-10T00:00:00.000Z";
    const unavailable = addOrder(database, "inactive-family", "테스트 양말", "구성: 1+1");

    recalculateOrderMappingsForStore(database, storeId);

    assertUnresolved(unavailable);
  });

  run("duplicate IDs do not select the first or last child; a unique option ID is decisive", () => {
    const database = createEmptyDatabase();
    const { single, double } = addPackGroup(database);
    single.linkedProductIds = ["shared-product"];
    double.linkedProductIds = ["shared-product"];
    single.linkedOptionCodes = ["shared-option"];
    double.linkedOptionCodes = ["shared-option", "double-only-option"];
    single.linkedManageCodes = ["shared-manage"];
    double.linkedManageCodes = ["shared-manage"];
    const duplicateProduct = addOrder(database, "duplicate-product", "이름 없는 테스트품", null, { externalProductId: "shared-product" });
    const duplicateOption = addOrder(database, "duplicate-option", "이름 없는 테스트품", null, { optionCode: "shared-option" });
    const duplicateManage = addOrder(database, "duplicate-manage", "이름 없는 테스트품", "[함께배송] 추가 테스트품", {
      optionManageCode: "shared-manage",
    });
    const uniqueOption = addOrder(database, "unique-option", "이름 없는 테스트품", null, {
      externalProductId: "shared-product",
      optionCode: "double-only-option",
    });

    recalculateOrderMappingsForStore(database, storeId);

    assertUnresolved(duplicateProduct);
    assertUnresolved(duplicateOption);
    assertUnresolved(duplicateManage);
    assertMapped(uniqueOption, double);
  });

  run("bundled manage codes stay more specific than the main product ID", () => {
    const database = createEmptyDatabase();
    const main = addPackGroup(database);
    const additional = addPackGroup(database, "support", "테스트 보호대");
    main.single.linkedProductIds = ["main-product"];
    additional.double.linkedManageCodes = ["additional-manage"];
    const bundled = addOrder(database, "manage-code", "테스트 양말", "[함께배송] 추가 상품", {
      externalProductId: "main-product",
      optionManageCode: "additional-manage",
    });

    recalculateOrderMappingsForStore(database, storeId);

    assertMapped(bundled, additional.double);
  });

  run("a unique listing product ID cannot override a different selected pack", () => {
    const database = createEmptyDatabase();
    const { single } = addPackGroup(database);
    single.linkedProductIds = ["single-listing-product"];
    const selectedDouble = addOrder(database, "listing-id-vs-pack", "테스트 양말", "구성: 1+1", {
      externalProductId: "single-listing-product",
    });

    recalculateOrderMappingsForStore(database, storeId);

    assertUnresolved(selectedDouble);
  });

  run("a unique child option ID resolves ambiguous group variants for both item and signature", () => {
    const database = createEmptyDatabase();
    const { double } = addPackGroup(database);
    double.linkedOptionCodes = ["double-child-option"];
    const selected = addOrder(database, "ambiguous-group-with-option-id", "테스트 양말", null, {
      optionCode: "double-child-option",
    });

    recalculateOrderMappingsForStore(database, storeId);

    assertMapped(selected, double);
  });

  run("a bundled option cannot inherit its listing's standalone leaf alias or product ID", () => {
    const database = createEmptyDatabase();
    const main = salesUnit("standalone-listing", "독립 테스트 양말", {
      matchAliases: ["독립 테스트 양말"],
      linkedProductIds: ["standalone-listing-product"],
    });
    database.canonicalSalesUnits.push(main);
    const additional = addOrder(database, "unidentified-add-on", "독립 테스트 양말", "[함께배송] 추가 선택 상품", {
      externalProductId: "standalone-listing-product",
    });

    recalculateOrderMappingsForStore(database, storeId);

    assertUnresolved(additional);
  });

  run("an active child of an inactive parent cannot supply direct aliases or option IDs", () => {
    const database = createEmptyDatabase();
    const { group, single } = addPackGroup(database);
    group.isActive = false;
    group.deactivatedAt = "2026-11-10T00:00:00.000Z";
    single.matchAliases = ["자식 전용 별칭"];
    single.normalizedMatchAliases = single.matchAliases.map(normalizeMatchAlias);
    single.linkedOptionCodes = ["inactive-parent-child-option"];
    const byAlias = addOrder(database, "inactive-parent-alias", "자식 전용 별칭", null);
    const byId = addOrder(database, "inactive-parent-option-id", "별칭 없는 테스트품", null, {
      optionCode: "inactive-parent-child-option",
    });

    recalculateOrderMappingsForStore(database, storeId);

    assertUnresolved(byAlias);
    assertUnresolved(byId);
  });

  run("confirmed manual mappings survive conflicting group words and linked IDs", () => {
    const database = createEmptyDatabase();
    const { single, double } = addPackGroup(database);
    double.linkedOptionCodes = ["double-option"];
    const manual = addOrder(database, "manual", "테스트 양말", "구성: 1+1", {
      canonicalSalesUnitId: single.id,
      optionCode: "double-option",
    }, {
      canonicalSalesUnitId: single.id,
      mappingStatus: "MAPPED",
      confirmedAt: "2026-11-10T12:00:00.000Z",
    });
    const before = structuredClone(manual);

    recalculateOrderMappingsForStore(database, storeId);

    assert.deepEqual(manual, before, "manual choices and their timestamps must remain untouched");
  });

  run("final signature inference reaches newly touched orders without rewriting history", () => {
    const database = createEmptyDatabase();
    const leaf = salesUnit("inferred-leaf", "ID 전용 테스트품", { linkedProductIds: ["known-product"] });
    database.canonicalSalesUnits.push(leaf);
    const source = signature("inferred-signature", "별칭 없는 테스트품", null, {
      canonicalSalesUnitId: leaf.id,
      mappingStatus: "MAPPED",
    });
    const historical = orderItem("historical", source, { canonicalSalesUnitId: leaf.id, externalProductId: "known-product" });
    const untouched = orderItem("untouched-unmapped", source);
    const incoming = orderItem("incoming-without-ids", source);
    database.orderSourceSignatures.push(source);
    database.orderItems.push(historical, untouched, incoming);
    const untouchedBefore = structuredClone([historical, untouched]);

    recalculateOrderMappingsForTouchedItems(database, {
      storeId,
      signatureIds: [source.id],
      orderItemIds: [incoming.id],
    });

    assert.equal(source.canonicalSalesUnitId, leaf.id);
    assert.equal(source.mappingStatus, "MAPPED");
    assert.equal(incoming.canonicalSalesUnitId, leaf.id, "phase-three inference must be propagated to the new order");
    assert.deepEqual([historical, untouched], untouchedBefore, "only requested items may receive the final inferred result");
  });

  run("historical single mappings cannot revive conflicting or inactive selected variants", () => {
    for (const scenario of ["contradictory-pack", "inactive-double"] as const) {
      const database = createEmptyDatabase();
      const { single, double } = addPackGroup(database);
      if (scenario === "inactive-double") {
        double.isActive = false;
        double.deactivatedAt = "2026-11-10T00:00:00.000Z";
      }
      const source = signature(`source-${scenario}`, "테스트 양말", scenario === "contradictory-pack" ? "구성: 단품 / 구성: 1+1" : "구성: 1+1", {
        canonicalSalesUnitId: single.id,
        mappingStatus: "MAPPED",
      });
      const historical = orderItem(`history-${scenario}`, source, { canonicalSalesUnitId: single.id });
      const incoming = orderItem(`incoming-${scenario}`, source);
      database.orderSourceSignatures.push(source);
      database.orderItems.push(historical, incoming);
      const historicalBefore = structuredClone(historical);

      recalculateOrderMappingsForTouchedItems(database, {
        storeId,
        signatureIds: [source.id],
        orderItemIds: [incoming.id],
      });

      assertUnresolved({ source, item: incoming });
      assert.deepEqual(historical, historicalBefore, `${scenario}: untouched history must remain unchanged`);
    }
  });

  run("conflicting historical targets never propagate an arbitrary mapping to a new order", () => {
    const database = createEmptyDatabase();
    const first = salesUnit("inference-first", "첫 번째 테스트품");
    const second = salesUnit("inference-second", "두 번째 테스트품");
    database.canonicalSalesUnits.push(first, second);
    const source = signature("conflicted-signature", "공유 테스트품", null);
    const prior = [
      orderItem("history-first", source, { canonicalSalesUnitId: first.id }),
      orderItem("history-second", source, { canonicalSalesUnitId: second.id }),
    ];
    const incoming = orderItem("conflicted-incoming", source);
    database.orderSourceSignatures.push(source);
    database.orderItems.push(...prior, incoming);
    const priorBefore = structuredClone(prior);

    recalculateOrderMappingsForTouchedItems(database, {
      storeId,
      signatureIds: [source.id],
      orderItemIds: [incoming.id],
    });

    assert.equal(source.mappingStatus, "CONFLICT");
    assert.equal(source.canonicalSalesUnitId, null);
    assert.equal(incoming.canonicalSalesUnitId, null);
    assert.deepEqual(prior, priorBefore);
  });

  run("historical inference cannot assign a deactivated unit to a newer paid order", () => {
    const database = createEmptyDatabase();
    const leaf = salesUnit("retired-leaf", "판매 종료 테스트품", {
      isActive: false,
      deactivatedAt: "2026-11-10T00:00:00.000Z",
    });
    database.canonicalSalesUnits.push(leaf);
    const source = signature("retired-signature", "과거 테스트품", null);
    const historical = orderItem("retired-history", source, {
      canonicalSalesUnitId: leaf.id,
      paymentDate: "2026-11-09",
    });
    const incoming = orderItem("retired-incoming", source, { paymentDate: "2026-11-11" });
    database.orderSourceSignatures.push(source);
    database.orderItems.push(historical, incoming);
    const historicalBefore = structuredClone(historical);

    recalculateOrderMappingsForTouchedItems(database, {
      storeId,
      signatureIds: [source.id],
      orderItemIds: [incoming.id],
    });

    assert.equal(incoming.canonicalSalesUnitId, null);
    assert.deepEqual(historical, historicalBefore);
  });
}
