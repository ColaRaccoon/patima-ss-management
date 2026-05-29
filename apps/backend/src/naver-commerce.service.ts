import { BadGatewayException, BadRequestException, Injectable } from "@nestjs/common";
import { SaleStatus, Store, normalizeText } from "@patima/shared";
import bcrypt from "bcryptjs";
import { CryptoService } from "./crypto.service";
import { DatabaseService } from "./database.service";
import { ensureStoreExists } from "./helpers";
import { NaverCommerceConfigService } from "./naver-commerce-config.service";

const NAVER_API_BASE_URL = "https://api.commerce.naver.com/external";
const TOKEN_RENEWAL_BUFFER_MS = 60_000;
const MAX_CHANGED_ORDER_PAGES = 50;
const MAX_CONDITIONAL_ORDER_PAGES = 100;
const CONDITIONAL_ORDER_PAGE_SIZE = 100;
const DETAIL_BATCH_SIZE = 300;

export interface ResolvedCommerceCredential {
  credentialId: string | null;
  clientId: string;
  clientSecret: string;
  accessType: "SELLER";
  source: "DATABASE" | "ENV";
}

export interface SyncedOrderItemInput {
  externalOrderId: string;
  externalProductOrderId: string;
  externalProductId: string | null;
  rawProductName: string;
  rawOptionInfo: string | null;
  optionCode: string | null;
  optionManageCode?: string;
  quantity: number;
  productPaymentAmount: number;
  totalProductAmount: number | null;
  deliveryFeeAmount: number | null;
  paymentCommission: number | null;
  knowledgeShoppingSellingInterlockCommission: number | null;
  saleCommission: number | null;
  channelCommission: number | null;
  orderDate: string | null;
  paymentDate: string | null;
  orderDateTime: string | null;
  paymentDateTime: string | null;
  productOrderStatus: string | null;
  claimStatus: string | null;
  rawStatus: string;
  saleStatus: SaleStatus;
  packageNumber: string | null;
  rawPayload: Record<string, unknown>;
}

interface CachedSellerToken {
  accessToken: string;
  expiresAt: number;
}

interface SellerTokenResponse {
  access_token: string;
  expires_in: number;
}

interface ChangedOrderCursor {
  moreFrom: string;
  moreSequence: string | number;
}

type JsonRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const pickString = (...values: unknown[]): string | null => {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value;
    }
    if (typeof value === "number") {
      return String(value);
    }
  }
  return null;
};

const pickNumber = (...values: unknown[]): number | null => {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === "string" && value.trim().length > 0 && !Number.isNaN(Number(value))) {
      return Number(value);
    }
  }
  return null;
};

const toDateString = (value: string | null): string | null => {
  if (!value) {
    return null;
  }
  const matched = value.match(/\d{4}-\d{2}-\d{2}/);
  return matched ? matched[0] : null;
};

const buildOrderRangeStart = (dateFrom: string) => `${dateFrom}T00:00:00.000+09:00`;
const buildOrderRangeEnd = (dateTo: string) => `${dateTo}T23:59:59.999+09:00`;

const kstDateFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Seoul",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

const enumerateDateRange = (dateFrom: string, dateTo: string) => {
  const dates: string[] = [];
  const cursor = new Date(`${dateFrom}T00:00:00+09:00`);
  const end = new Date(`${dateTo}T00:00:00+09:00`);

  while (cursor.getTime() <= end.getTime()) {
    dates.push(kstDateFormatter.format(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }

  return dates;
};

const uniqueStrings = (values: Array<string | null | undefined>) =>
  Array.from(new Set(values.filter((value): value is string => !!value)));

const chunk = <T>(items: T[], size: number): T[][] => {
  const batches: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    batches.push(items.slice(index, index + size));
  }
  return batches;
};

const optionPartsToText = (parts: unknown[]) =>
  parts
    .map((part) => pickString(part))
    .filter((part): part is string => !!part)
    .join(" / ") || null;

export const createNaverClientSecretSign = (
  clientId: string,
  clientSecret: string,
  timestamp: string,
) =>
  Buffer.from(
    bcrypt.hashSync(`${clientId}_${timestamp}`, clientSecret),
    "utf8",
  ).toString("base64");

const saleStatusFromNaverState = (
  productOrderStatus: string | null,
  claimStatus: string | null,
): SaleStatus => {
  const raw = (claimStatus ?? productOrderStatus ?? "UNKNOWN").toUpperCase();

  if (
    raw === "CANCEL_REJECT" ||
    raw === "RETURN_REJECT" ||
    raw === "EXCHANGE_REJECT" ||
    raw === "CLAIM_REJECTED" ||
    raw === "ADMIN_CANCEL_REJECT" ||
    raw === "PURCHASE_DECISION_HOLDBACK" ||
    raw === "PURCHASE_DECISION_REQUEST" ||
    raw === "PURCHASE_DECISION_HOLDBACK_RELEASE"
  ) {
    return "SALE";
  }
  if (raw.includes("CANCEL_REQUEST") || raw === "CANCELING") {
    return "CANCEL_REQUESTED";
  }
  if (raw === "ADMIN_CANCELING") {
    return "CANCEL_REQUESTED";
  }
  if (
    raw.includes("CANCEL_DONE") ||
    raw === "CANCELED" ||
    raw === "CANCELED_BY_NOPAYMENT" ||
    raw === "ADMIN_CANCEL" ||
    raw === "ADMIN_CANCEL_DONE"
  ) {
    return "CANCELED";
  }
  if (raw.includes("RETURN") || raw === "COLLECTING" || raw === "COLLECT_DONE") {
    return "RETURNED";
  }
  if (raw.includes("EXCHANGE")) {
    return "EXCHANGED";
  }
  if (
    raw === "PAYED" ||
    raw === "DELIVERING" ||
    raw === "DELIVERED" ||
    raw === "PURCHASE_DECIDED"
  ) {
    return "SALE";
  }

  return "UNKNOWN";
};

@Injectable()
export class NaverCommerceService {
  private readonly tokenCache = new Map<string, CachedSellerToken>();

  constructor(
    private readonly databaseService: DatabaseService,
    private readonly cryptoService: CryptoService,
    private readonly naverCommerceConfigService: NaverCommerceConfigService,
  ) {}

  getResolvedConfiguration(storeId: string) {
    const snapshot = this.databaseService.getSnapshot();
    const store = ensureStoreExists(snapshot, storeId);
    const credential = this.resolveCredential(store);
    if (!credential) {
      return null;
    }

    return { store, credential };
  }

  getCredentialSummary(storeId: string) {
    const snapshot = this.databaseService.getSnapshot();
    const store = ensureStoreExists(snapshot, storeId);
    const resolved = this.getResolvedConfiguration(storeId);
    if (!resolved) {
      return {
        credentialId: null,
        storeId,
        maskedClientId: null,
        accessType: "SELLER" as const,
        secretStored: false,
        credentialConnectionStatus: store.credentialConnectionStatus,
        lastCredentialTestAt: store.lastCredentialTestAt,
        credentialSource: null,
      };
    }

    return {
      credentialId: resolved.credential.credentialId,
      storeId,
      maskedClientId: this.naverCommerceConfigService.maskClientId(resolved.credential.clientId),
      accessType: resolved.credential.accessType,
      secretStored: true,
      credentialConnectionStatus: store.credentialConnectionStatus,
      lastCredentialTestAt: store.lastCredentialTestAt,
      credentialSource: resolved.credential.source,
    };
  }

  async testConnection(storeId: string) {
    const resolved = this.getResolvedConfiguration(storeId);
    if (!resolved) {
      throw new BadRequestException("NAVER_CREDENTIALS_NOT_CONFIGURED");
    }

    const channelInfo = await this.lookupSellerChannels(resolved.store, resolved.credential);
    const matched = channelInfo.find((entry) => entry.channelNo === resolved.store.channelNo) ?? null;
    if (channelInfo.length > 0 && !matched) {
      throw new BadGatewayException(
        `NAVER_CHANNEL_MISMATCH: configured channelNo ${resolved.store.channelNo} was not returned by seller channel lookup.`,
      );
    }

    return {
      credentialSource: resolved.credential.source,
      channelNo: matched?.channelNo ?? channelInfo[0]?.channelNo ?? null,
      channelName: matched?.channelName ?? channelInfo[0]?.channelName ?? null,
    };
  }

  async fetchOrderItems(storeId: string, dateFrom: string, dateTo: string): Promise<SyncedOrderItemInput[]> {
    const resolved = this.getResolvedConfiguration(storeId);
    if (!resolved) {
      throw new BadRequestException("NAVER_CREDENTIALS_NOT_CONFIGURED");
    }

    const targetDates = enumerateDateRange(dateFrom, dateTo);

    // 결제일 기준 조회 (GET /v1/pay-order/seller/product-orders, rangeType=PAYED_DATETIME)
    const productOrderIds: string[] = [];
    for (const targetDate of targetDates) {
      const ids = await this.fetchProductOrderIdsByPaymentDate(
        resolved.store,
        resolved.credential,
        targetDate,
      );
      productOrderIds.push(...ids);
    }

    const uniqueIds = uniqueStrings(productOrderIds);
    if (uniqueIds.length === 0) {
      return [];
    }

    const details = await this.fetchOrderDetails(resolved.store, resolved.credential, uniqueIds);

    return details
      .map((detail) => this.normalizeOrderDetail(detail, undefined))
      .filter((item): item is SyncedOrderItemInput => !!item);
  }

  private resolveCredential(store: Store): ResolvedCommerceCredential | null {
    const envCredential = this.naverCommerceConfigService.getEnvCredentialForStore(store);
    if (envCredential) {
      return {
        credentialId: null,
        clientId: envCredential.clientId,
        clientSecret: envCredential.clientSecret,
        accessType: "SELLER",
        source: "ENV",
      };
    }

    const snapshot = this.databaseService.getSnapshot();
    const persisted = snapshot.commerceCredentials.find(
      (item) => item.storeId === store.id && item.isEnabled,
    );
    if (!persisted) {
      return null;
    }

    return {
      credentialId: persisted.id,
      clientId: persisted.clientId,
      clientSecret: this.cryptoService.decrypt(persisted.clientSecretEncrypted),
      accessType: persisted.accessType,
      source: "DATABASE",
    };
  }

  private async lookupSellerChannels(store: Store, credential: ResolvedCommerceCredential) {
    const response = await this.requestSellerJson("/v1/seller/channels", store, credential);
    return this.extractChannelEntries(response);
  }

  private async fetchChangedOrders(
    store: Store,
    credential: ResolvedCommerceCredential,
    dateFrom: string,
    dateTo: string,
  ) {
    const entries: JsonRecord[] = [];
    const start = buildOrderRangeStart(dateFrom);
    const end = buildOrderRangeEnd(dateTo);
    let lastChangedFrom = start;
    let moreSequence: string | number | null = null;

    for (let page = 0; page < MAX_CHANGED_ORDER_PAGES; page += 1) {
      const response = await this.requestSellerJson(
        "/v1/pay-order/seller/product-orders/last-changed-statuses",
        store,
        credential,
        {
          query: {
            lastChangedFrom,
            lastChangedTo: end,
            limitCount: "300",
            ...(moreSequence != null ? { moreSequence: String(moreSequence) } : {}),
          },
        },
      );

      entries.push(...this.extractChangedOrderEntries(response));
      const more = this.extractChangedOrderCursor(response);
      if (!more) {
        break;
      }

      lastChangedFrom = more.moreFrom;
      moreSequence = more.moreSequence;
    }

    return { entries };
  }

  private async fetchProductOrderIdsByPaymentDate(
    store: Store,
    credential: ResolvedCommerceCredential,
    targetDate: string,
  ): Promise<string[]> {
    const from = buildOrderRangeStart(targetDate);
    const to = buildOrderRangeEnd(targetDate);
    const ids: string[] = [];

    for (let page = 1; page <= MAX_CONDITIONAL_ORDER_PAGES; page += 1) {
      const response = await this.requestSellerJson(
        "/v1/pay-order/seller/product-orders",
        store,
        credential,
        {
          query: {
            from,
            to,
            rangeType: "PAYED_DATETIME",
            pageSize: String(CONDITIONAL_ORDER_PAGE_SIZE),
            page: String(page),
          },
        },
      );

      const entries = this.extractConditionalOrderEntries(response);
      entries.forEach((entry) => {
        const id = pickString(entry.productOrderId);
        if (id) {
          ids.push(id);
        }
      });

      // 반환된 항목 수가 pageSize보다 적으면 마지막 페이지
      if (entries.length < CONDITIONAL_ORDER_PAGE_SIZE) {
        break;
      }
    }

    return ids;
  }

  private extractConditionalOrderEntries(payload: unknown): JsonRecord[] {
    return this.extractMatchingArrayEntries(payload, (entry) =>
      pickString(entry.productOrderId) !== null,
    );
  }

  private async fetchOrderDetails(
    store: Store,
    credential: ResolvedCommerceCredential,
    productOrderIds: string[],
  ) {
    const envelopes: JsonRecord[] = [];

    for (const batch of chunk(productOrderIds, DETAIL_BATCH_SIZE)) {
      const response = await this.requestOrderDetailBatch(store, credential, batch);
      envelopes.push(...this.extractOrderDetailEnvelopes(response));
    }

    const deduped = new Map<string, JsonRecord>();
    envelopes.forEach((entry) => {
      const productOrderId = this.extractProductOrderId(entry);
      if (productOrderId) {
        deduped.set(productOrderId, entry);
      }
    });

    return Array.from(deduped.values());
  }

  private async requestOrderDetailBatch(
    store: Store,
    credential: ResolvedCommerceCredential,
    productOrderIds: string[],
  ) {
    const candidateBodies = [{ productOrderIds }, { productOrderIdList: productOrderIds }];
    let lastError: Error | null = null;

    for (const body of candidateBodies) {
      try {
        return await this.requestSellerJson("/v1/pay-order/seller/product-orders/query", store, credential, {
          method: "POST",
          body,
        });
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
      }
    }

    throw lastError ?? new BadGatewayException("NAVER_ORDER_DETAIL_QUERY_FAILED");
  }

  private normalizeOrderDetail(
    detailEnvelope: JsonRecord,
    changedOrder: JsonRecord | undefined,
  ): SyncedOrderItemInput | null {
    const productOrder = isRecord(detailEnvelope.productOrder) ? detailEnvelope.productOrder : detailEnvelope;
    const order = isRecord(detailEnvelope.order)
      ? detailEnvelope.order
      : isRecord(productOrder.order)
        ? productOrder.order
        : null;
    const product = isRecord(detailEnvelope.product)
      ? detailEnvelope.product
      : isRecord(productOrder.product)
        ? productOrder.product
        : null;
    const delivery = isRecord(detailEnvelope.delivery)
      ? detailEnvelope.delivery
      : isRecord(productOrder.delivery)
        ? productOrder.delivery
        : null;

    const externalProductOrderId = pickString(
      productOrder.productOrderId,
      detailEnvelope.productOrderId,
      changedOrder?.productOrderId,
    );
    const externalOrderId = pickString(
      order?.orderId,
      productOrder.orderId,
      detailEnvelope.orderId,
      changedOrder?.orderId,
    );

    if (!externalProductOrderId || !externalOrderId) {
      return null;
    }

    const rawProductName =
      pickString(productOrder.productName, product?.productName, detailEnvelope.productName) ??
      `NAVER_PRODUCT_${externalProductOrderId}`;
    const rawOptionInfo = this.buildOptionInfo(productOrder, product, detailEnvelope);
    const productOrderStatus = pickString(
      productOrder.productOrderStatus,
      detailEnvelope.productOrderStatus,
      changedOrder?.productOrderStatus,
    );
    const claimStatus = this.extractClaimStatus(productOrder, detailEnvelope, changedOrder);
    const rawStatus = claimStatus ?? productOrderStatus ?? "UNKNOWN";
    const orderDateTime = pickString(order?.orderDate, productOrder.orderDate, detailEnvelope.orderDate);
    const paymentDateTime = pickString(
      order?.paymentDate,
      productOrder.paymentDate,
      detailEnvelope.paymentDate,
      productOrder.decisionDate,
    );

    const optionManageCode = pickString(productOrder.optionManageCode);

    const result: SyncedOrderItemInput = {
      externalOrderId,
      externalProductOrderId,
      externalProductId: pickString(
        productOrder.productId,
        product?.productId,
        detailEnvelope.productId,
        productOrder.originProductNo,
      ),
      rawProductName,
      rawOptionInfo,
      optionCode: pickString(productOrder.optionCode),
      quantity: pickNumber(productOrder.quantity, productOrder.productCount, detailEnvelope.quantity) ?? 1,
      productPaymentAmount:
        pickNumber(
          productOrder.totalPaymentAmount,
          productOrder.paymentAmount,
          productOrder.productAmount,
          productOrder.salePrice,
          detailEnvelope.totalPaymentAmount,
        ) ?? 0,
      totalProductAmount: pickNumber(
        productOrder.totalProductAmount,
        productOrder.productPrice,
        detailEnvelope.totalProductAmount,
      ),
      deliveryFeeAmount: pickNumber(
        productOrder.deliveryFeeAmount,
        productOrder.shippingFeeAmount,
        delivery?.deliveryFeeAmount,
      ),
      paymentCommission: pickNumber(productOrder.paymentCommission, detailEnvelope.paymentCommission),
      knowledgeShoppingSellingInterlockCommission: pickNumber(
        productOrder.knowledgeShoppingSellingInterlockCommission,
        detailEnvelope.knowledgeShoppingSellingInterlockCommission,
      ),
      saleCommission: pickNumber(productOrder.saleCommission, detailEnvelope.saleCommission),
      channelCommission: pickNumber(productOrder.channelCommission, detailEnvelope.channelCommission),
      orderDate: toDateString(orderDateTime),
      paymentDate: toDateString(paymentDateTime),
      orderDateTime,
      paymentDateTime,
      productOrderStatus,
      claimStatus,
      rawStatus,
      saleStatus: saleStatusFromNaverState(productOrderStatus, claimStatus),
      packageNumber: pickString(productOrder.packageNumber, delivery?.packageNumber, detailEnvelope.packageNumber),
      rawPayload: {
        changedOrder: changedOrder ?? null,
        detail: detailEnvelope,
      },
    };

    // optionManageCode가 있으면 추가 (빈 문자열은 제외)
    if (optionManageCode) {
      result.optionManageCode = optionManageCode;
    }

    return result;
  }

  private buildOptionInfo(productOrder: JsonRecord, product: JsonRecord | null, detailEnvelope: JsonRecord) {
    const selectedOptions = [
      this.stringifyOptionCollection(productOrder.standardPurchaseOptions),
      this.stringifyOptionCollection(productOrder.selectedOptions),
      this.stringifyOptionCollection(productOrder.optionSelections),
      this.stringifyOptionCollection(product?.standardPurchaseOptions),
    ];

    const readableOptionInfo =
      optionPartsToText([
        productOrder.optionName,
        productOrder.optionValue,
        detailEnvelope.optionName,
        ...selectedOptions,
      ]) ?? null;

    return pickString(productOrder.productOption, readableOptionInfo, productOrder.optionCode);
  }

  private stringifyOptionCollection(value: unknown): string | null {
    if (!Array.isArray(value)) {
      return pickString(value);
    }

    const tokens = value
      .map((entry) => {
        if (!isRecord(entry)) {
          return pickString(entry);
        }
        return optionPartsToText([entry.optionName, entry.valueName, entry.optionValue]);
      })
      .filter((entry): entry is string => !!entry);

    return tokens.length > 0 ? tokens.join(" / ") : null;
  }

  private extractClaimStatus(...nodes: Array<JsonRecord | undefined | null>) {
    for (const node of nodes) {
      if (!node) {
        continue;
      }

      const direct = pickString(node.claimStatus);
      if (direct) {
        return direct;
      }

      const currentClaim = isRecord(node.currentClaim) ? node.currentClaim : null;
      if (!currentClaim) {
        continue;
      }

      const nestedStatuses = [
        pickString(currentClaim.claimStatus),
        isRecord(currentClaim.cancel) ? pickString(currentClaim.cancel.claimStatus) : null,
        isRecord(currentClaim.return) ? pickString(currentClaim.return.claimStatus) : null,
        isRecord(currentClaim.exchange) ? pickString(currentClaim.exchange.claimStatus) : null,
      ];
      const matched = nestedStatuses.find((value): value is string => !!value);
      if (matched) {
        return matched;
      }
    }

    return null;
  }

  private extractProductOrderId(node: JsonRecord) {
    const productOrder = isRecord(node.productOrder) ? node.productOrder : node;
    return pickString(productOrder.productOrderId, node.productOrderId);
  }

  private extractChangedOrderEntries(payload: unknown) {
    return this.extractMatchingArrayEntries(payload, (entry) =>
      pickString(entry.productOrderId, entry.orderId, entry.lastChangedDate) !== null,
    );
  }

  private extractOrderDetailEnvelopes(payload: unknown) {
    return this.extractMatchingArrayEntries(payload, (entry) => this.extractProductOrderId(entry) !== null);
  }

  private extractMatchingArrayEntries(payload: unknown, predicate: (entry: JsonRecord) => boolean): JsonRecord[] {
    const results: JsonRecord[] = [];

    const visit = (node: unknown) => {
      if (Array.isArray(node)) {
        const matching = node.filter((entry): entry is JsonRecord => isRecord(entry) && predicate(entry));
        if (matching.length > 0) {
          results.push(...matching);
          return;
        }

        node.forEach((entry) => visit(entry));
        return;
      }

      if (isRecord(node)) {
        Object.values(node).forEach((entry) => visit(entry));
      }
    };

    visit(payload);
    return results;
  }

  private extractChangedOrderCursor(payload: unknown): ChangedOrderCursor | null {
    let found: ChangedOrderCursor | null = null;

    const visit = (node: unknown) => {
      if (found) {
        return;
      }
      if (Array.isArray(node)) {
        node.forEach((entry) => visit(entry));
        return;
      }
      if (!isRecord(node)) {
        return;
      }

      const moreFrom = pickString(node.moreFrom);
      const moreSequence = pickString(node.moreSequence) ?? pickNumber(node.moreSequence);
      if (moreFrom && moreSequence != null) {
        found = { moreFrom, moreSequence };
        return;
      }

      Object.values(node).forEach((entry) => visit(entry));
    };

    visit(payload);
    return found;
  }

  private extractChannelEntries(payload: unknown): Array<{ channelNo: string; channelName: string | null }> {
    const entries: Array<{ channelNo: string; channelName: string | null }> = [];

    const visit = (node: unknown) => {
      if (Array.isArray(node)) {
        node.forEach((entry) => visit(entry));
        return;
      }
      if (!isRecord(node)) {
        return;
      }

      const channelNo = pickString(node.channelNo, node.defaultChannelNo, node.representChannelNo);
      if (channelNo) {
        entries.push({
          channelNo,
          channelName: pickString(node.channelName, node.name),
        });
      }

      Object.values(node).forEach((entry) => visit(entry));
    };

    visit(payload);
    return entries;
  }

  private async requestSellerJson(
    path: string,
    store: Store,
    credential: ResolvedCommerceCredential,
    options?: {
      method?: "GET" | "POST";
      query?: Record<string, string>;
      body?: unknown;
      retryOnAuthFailure?: boolean;
    },
  ): Promise<unknown> {
    const retryOnAuthFailure = options?.retryOnAuthFailure ?? true;
    const token = await this.getSellerToken(store, credential);
    const url = new URL(`${NAVER_API_BASE_URL}${path}`);
    Object.entries(options?.query ?? {}).forEach(([key, value]) => {
      url.searchParams.set(key, value);
    });

    const response = await fetch(url, {
      method: options?.method ?? "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        ...(options?.body ? { "Content-Type": "application/json" } : {}),
      },
      body: options?.body ? JSON.stringify(options.body) : undefined,
    });

    const parsed = await this.parseJsonResponse(response);
    if (response.status === 401 && parsed.code === "GW.AUTHN" && retryOnAuthFailure) {
      this.tokenCache.delete(this.buildCacheKey(store, credential));
      return this.requestSellerJson(path, store, credential, {
        ...options,
        retryOnAuthFailure: false,
      });
    }

    if (!response.ok) {
      throw new BadGatewayException(
        `NAVER_API_ERROR [${parsed.code ?? response.status}] ${parsed.message ?? "Request failed."}`,
      );
    }

    return parsed.body;
  }

  private async getSellerToken(store: Store, credential: ResolvedCommerceCredential) {
    const cacheKey = this.buildCacheKey(store, credential);
    const cached = this.tokenCache.get(cacheKey);
    if (cached && cached.expiresAt - TOKEN_RENEWAL_BUFFER_MS > Date.now()) {
      return cached.accessToken;
    }

    const timestamp = Date.now().toString();
    const signature = createNaverClientSecretSign(
      credential.clientId,
      credential.clientSecret,
      timestamp,
    );

    const body = new URLSearchParams({
      client_id: credential.clientId,
      timestamp,
      client_secret_sign: signature,
      grant_type: "client_credentials",
      type: "SELLER",
      account_id: store.sellerAccountId,
    });

    const response = await fetch(`${NAVER_API_BASE_URL}/v1/oauth2/token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
    });

    const parsed = await this.parseJsonResponse<SellerTokenResponse>(response);
    if (!response.ok || !parsed.body?.access_token) {
      throw new BadGatewayException(
        `NAVER_TOKEN_ISSUE_FAILED [${parsed.code ?? response.status}] ${parsed.message ?? "Token was not issued."}`,
      );
    }

    const expiresAt = Date.now() + parsed.body.expires_in * 1000;
    this.tokenCache.set(cacheKey, {
      accessToken: parsed.body.access_token,
      expiresAt,
    });
    await this.recordTokenIssuedAt(credential.credentialId, expiresAt);
    return parsed.body.access_token;
  }

  private async recordTokenIssuedAt(credentialId: string | null, expiresAt: number) {
    if (!credentialId) {
      return;
    }

    const issuedAtIso = new Date().toISOString();
    const expiresAtIso = new Date(expiresAt).toISOString();
    await this.databaseService.writeCommitted((draft) => {
      const credential = draft.commerceCredentials.find((item) => item.id === credentialId);
      if (!credential) {
        return;
      }
      credential.lastTokenIssuedAt = issuedAtIso;
      credential.lastTokenExpiresAt = expiresAtIso;
      credential.updatedAt = issuedAtIso;
    });
  }

  private async parseJsonResponse<T = JsonRecord>(response: Response) {
    const text = await response.text();
    if (!text.trim()) {
      return {
        body: null as T | null,
        code: null as string | null,
        message: null as string | null,
      };
    }

    try {
      const parsed = JSON.parse(text) as T & { code?: string; message?: string };
      return {
        body: parsed,
        code: typeof parsed.code === "string" ? parsed.code : null,
        message: typeof parsed.message === "string" ? parsed.message : null,
      };
    } catch {
      return {
        body: null as T | null,
        code: null as string | null,
        message: text,
      };
    }
  }

  private buildCacheKey(store: Store, credential: ResolvedCommerceCredential) {
    return `${store.sellerAccountId}:${credential.clientId}:${normalizeText(store.channelNo)}`;
  }
}
