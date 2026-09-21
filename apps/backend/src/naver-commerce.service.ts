import {
  BadGatewayException,
  BadRequestException,
  Injectable,
} from "@nestjs/common";
import { SaleStatus, Store, normalizeText } from "@patima/shared";
import bcrypt from "bcryptjs";
import {
  NaverRequestError,
  requestNaverJson,
  waitForNaverRetry,
  waitForNaverToken,
} from "./naver-request";
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
  rawPayload: Record<string, unknown> | null;
}

interface CachedSellerToken {
  accessToken: string;
  expiresAt: number;
}

export interface OrderStreamOptions {
  includeRawPayload?: boolean;
  requestedCutoffAt?: string;
  changedFrom?: string;
  existingProductOrderIds?: Iterable<string>;
  signal?: AbortSignal;
  onProgress?: (progress: {
    stage: "AUTHENTICATING" | "FETCHING_ORDERS" | "FETCHING_DETAILS";
    queryKind?: "PAYMENT" | "EXISTING" | "CHANGED";
    page?: number;
    dateWindow?: { from: string; to: string };
  }) => Promise<void>;
}
export interface OrderStreamChunk {
  items: SyncedOrderItemInput[];
  checkpoint: {
    schemaVersion: number;
    queryKind: "PAYMENT" | "CHANGED" | "EXISTING";
    windowFrom: string;
    windowTo: string;
    page: number;
  };
  fetchedCount: number;
  validatedCount: number;
  warnings: string[];
}
const toKstTimestamp = (value: number) =>
  new Date(value + 9 * 60 * 60 * 1000).toISOString().replace("Z", "+09:00");

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
    if (
      typeof value === "string" &&
      value.trim().length > 0 &&
      Number.isFinite(Number(value))
    ) {
      return Number(value);
    }
  }
  return null;
};

const toDateString = (value: string | null): string | null => {
  if (!value || !Number.isFinite(Date.parse(value))) {
    return null;
  }
  return kstDateFormatter.format(new Date(value));
};

const buildOrderRangeStart = (dateFrom: string) =>
  `${dateFrom}T00:00:00.000+09:00`;
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
  if (
    raw.includes("RETURN") ||
    raw === "COLLECTING" ||
    raw === "COLLECT_DONE"
  ) {
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
  private readonly tokenRequests = new Map<string, Promise<string>>();

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
      maskedClientId: this.naverCommerceConfigService.maskClientId(
        resolved.credential.clientId,
      ),
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

    let channelInfo: Awaited<
      ReturnType<NaverCommerceService["lookupSellerChannels"]>
    >;
    try {
      channelInfo = await this.lookupSellerChannels(
        resolved.store,
        resolved.credential,
      );
    } catch (error) {
      // Preserve the existing credential-test HTTP 502 contract.
      if (error instanceof NaverRequestError)
        throw new BadGatewayException(error.safeMessage);
      throw error;
    }
    const matched =
      channelInfo.find(
        (entry) => entry.channelNo === resolved.store.channelNo,
      ) ?? null;
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

  async fetchOrderItems(
    storeId: string,
    dateFrom: string,
    dateTo: string,
    options?: OrderStreamOptions,
  ): Promise<SyncedOrderItemInput[]> {
    const items = new Map<string, SyncedOrderItemInput>();
    for await (const batch of this.streamOrderItems(
      storeId,
      dateFrom,
      dateTo,
      options,
    )) {
      for (const item of batch.items)
        items.set(item.externalProductOrderId, item);
    }
    return [...items.values()];
  }

  async *streamOrderItems(
    storeId: string,
    dateFrom: string,
    dateTo: string,
    options: OrderStreamOptions = {},
  ): AsyncGenerator<OrderStreamChunk> {
    options.signal?.throwIfAborted();
    await options.onProgress?.({ stage: "AUTHENTICATING" });
    const resolved = this.getResolvedConfiguration(storeId);
    if (!resolved)
      throw new NaverRequestError("NAVER_CREDENTIALS_NOT_CONFIGURED");
    const { store, credential } = resolved;
    let fetchedCount = 0;
    let validatedCount = 0;
    const cutoff = Date.parse(
      options.requestedCutoffAt ?? buildOrderRangeEnd(dateTo),
    );
    const rangeStart = Date.parse(buildOrderRangeStart(dateFrom));
    const rangeEnd = Date.parse(buildOrderRangeEnd(dateTo));
    if (
      !Number.isFinite(cutoff) ||
      !Number.isFinite(rangeStart) ||
      !Number.isFinite(rangeEnd) ||
      rangeStart > rangeEnd ||
      rangeStart > cutoff
    )
      throw new NaverRequestError("INVALID_ORDER_RANGE");
    const makeChunk = async (
      ids: string[],
      checkpoint: OrderStreamChunk["checkpoint"],
      changed = new Map<string, JsonRecord>(),
    ): Promise<OrderStreamChunk> => {
      options.signal?.throwIfAborted();
      fetchedCount += ids.length;
      await options.onProgress?.({
        stage: "FETCHING_DETAILS",
        queryKind: checkpoint.queryKind,
        page: checkpoint.page,
        dateWindow: { from: checkpoint.windowFrom, to: checkpoint.windowTo },
      });
      const details = await this.fetchOrderDetails(
        store,
        credential,
        ids,
        options.signal,
      );
      const items = details.map((detail) =>
        this.normalizeOrderDetail(
          detail,
          changed.get(this.extractProductOrderId(detail)!),
          options,
        ),
      );
      validatedCount += items.length;
      return {
        items,
        checkpoint,
        fetchedCount,
        validatedCount,
        warnings: items.some((item) => item.saleStatus === "UNKNOWN")
          ? ["UNKNOWN_ORDER_STATUS"]
          : [],
      };
    };
    for (const date of enumerateDateRange(dateFrom, dateTo)) {
      const from = buildOrderRangeStart(date);
      const to = toKstTimestamp(
        Math.min(Date.parse(buildOrderRangeEnd(date)), cutoff),
      );
      if (Date.parse(from) > Date.parse(to)) continue;
      const seenPages = new Set<string>();
      for (let page = 1; page <= MAX_CONDITIONAL_ORDER_PAGES; page += 1) {
        await options.onProgress?.({
          stage: "FETCHING_ORDERS",
          queryKind: "PAYMENT",
          page,
          dateWindow: { from, to },
        });
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
            signal: options.signal,
          },
        );
        if (
          !isRecord(response) ||
          !isRecord(response.data) ||
          !Array.isArray(response.data.contents) ||
          !isRecord(response.data.pagination)
        )
          throw new NaverRequestError("NAVER_INVALID_RESPONSE");
        const pagination = response.data.pagination;
        if (typeof pagination.hasNext !== "boolean" || pagination.page !== page)
          throw new NaverRequestError("NAVER_INVALID_PAGINATION");
        const ids = response.data.contents.map((entry: unknown) => {
          if (!isRecord(entry))
            throw new NaverRequestError("NAVER_INVALID_ORDER");
          if (!isRecord(entry.content))
            throw new NaverRequestError("NAVER_INVALID_ORDER");
          const id = this.extractProductOrderId(entry.content);
          if (!id) throw new NaverRequestError("NAVER_INVALID_ORDER_ID");
          return id;
        });
        const fingerprint = [...ids].sort().join(",");
        if (
          (ids.length === 0 && pagination.hasNext) ||
          (ids.length > 0 && seenPages.has(fingerprint))
        )
          throw new NaverRequestError("INCOMPLETE_PAGINATION");
        seenPages.add(fingerprint);
        yield await makeChunk(uniqueStrings(ids), {
          schemaVersion: 1,
          queryKind: "PAYMENT",
          windowFrom: from,
          windowTo: to,
          page,
        });
        if (!pagination.hasNext) break;
        if (page === MAX_CONDITIONAL_ORDER_PAGES)
          throw new NaverRequestError("INCOMPLETE_PAGINATION");
      }
    }
    let existing: string[] = [];
    let page = 0;
    for (const id of options.existingProductOrderIds ?? []) {
      existing.push(id);
      if (existing.length === DETAIL_BATCH_SIZE) {
        yield await makeChunk(uniqueStrings(existing), {
          schemaVersion: 1,
          queryKind: "EXISTING",
          windowFrom: dateFrom,
          windowTo: dateTo,
          page: ++page,
        });
        existing = [];
      }
    }
    if (existing.length)
      yield await makeChunk(uniqueStrings(existing), {
        schemaVersion: 1,
        queryKind: "EXISTING",
        windowFrom: dateFrom,
        windowTo: dateTo,
        page: ++page,
      });
    if (options.changedFrom) {
      // NAVER FAQ #10 recommends allowing five seconds for upstream publication.
      if (cutoff > Date.now() + 1000)
        throw new NaverRequestError("INVALID_ORDER_RANGE");
      await waitForNaverRetry(
        Math.max(0, cutoff + 5000 - Date.now()),
        options.signal,
      );
      let start = Date.parse(options.changedFrom);
      if (!Number.isFinite(start) || start > cutoff)
        throw new NaverRequestError("INVALID_ORDER_RANGE");
      // Re-read five minutes before the committed watermark for delayed changes.
      start -= 5 * 60 * 1000;
      while (start <= cutoff) {
        const end = Math.min(start + 24 * 60 * 60 * 1000 - 1, cutoff);
        const to = toKstTimestamp(end);
        let from = toKstTimestamp(start);
        let sequence: string | undefined;
        const seen = new Set<string>();
        for (let page = 1; page <= MAX_CHANGED_ORDER_PAGES; page += 1) {
          await options.onProgress?.({
            stage: "FETCHING_ORDERS",
            queryKind: "CHANGED",
            page,
            dateWindow: { from, to },
          });
          const response = await this.requestSellerJson(
            "/v1/pay-order/seller/product-orders/last-changed-statuses",
            store,
            credential,
            {
              query: {
                lastChangedFrom: from,
                lastChangedTo: to,
                limitCount: "300",
                ...(sequence ? { moreSequence: sequence } : {}),
              },
              signal: options.signal,
            },
          );
          const { entries, more } = this.parseChangedOrders(response);
          const changed = new Map(
            entries.map((entry) => [String(entry.productOrderId), entry]),
          );
          yield await makeChunk(
            [...changed.keys()],
            {
              schemaVersion: 1,
              queryKind: "CHANGED",
              windowFrom: toKstTimestamp(start),
              windowTo: to,
              page,
            },
            changed,
          );
          if (!more) break;
          const cursor = `${more.moreFrom}:${more.moreSequence}`;
          if (
            seen.has(cursor) ||
            Date.parse(more.moreFrom) < Date.parse(from) ||
            Date.parse(more.moreFrom) > end ||
            page === MAX_CHANGED_ORDER_PAGES
          )
            throw new NaverRequestError("INCOMPLETE_PAGINATION");
          seen.add(cursor);
          from = toKstTimestamp(Date.parse(more.moreFrom));
          sequence = String(more.moreSequence);
        }
        start = end + 1;
      }
    }
  }

  private resolveCredential(store: Store): ResolvedCommerceCredential | null {
    const envCredential =
      this.naverCommerceConfigService.getEnvCredentialForStore(store);
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

  private async lookupSellerChannels(
    store: Store,
    credential: ResolvedCommerceCredential,
  ) {
    const response = await this.requestSellerJson(
      "/v1/seller/channels",
      store,
      credential,
    );
    return this.extractChannelEntries(response);
  }

  private parseChangedOrders(payload: unknown): {
    entries: JsonRecord[];
    more: { moreFrom: string; moreSequence: string | number } | null;
  } {
    if (!isRecord(payload))
      throw new NaverRequestError("NAVER_INVALID_RESPONSE");
    // Official NAVER notice #321 (2025-04-16): empty responses omit data.
    if (
      Object.keys(payload).every(
        (key) => key === "traceId" || key === "timestamp",
      ) &&
      typeof payload.traceId === "string" &&
      typeof payload.timestamp === "string" &&
      Number.isFinite(Date.parse(payload.timestamp))
    )
      return { entries: [], more: null };
    const data = payload.data;
    if (!isRecord(data) || !Array.isArray(data.lastChangeStatuses))
      throw new NaverRequestError("NAVER_INVALID_RESPONSE");
    const entries = data.lastChangeStatuses.map((entry: unknown) => {
      if (
        !isRecord(entry) ||
        !pickString(entry.productOrderId) ||
        !pickString(entry.orderId) ||
        typeof entry.lastChangedDate !== "string" ||
        !Number.isFinite(Date.parse(entry.lastChangedDate))
      )
        throw new NaverRequestError("NAVER_INVALID_CHANGED_ORDER");
      return entry;
    });
    if (data.count !== entries.length)
      throw new NaverRequestError("NAVER_INVALID_CHANGED_COUNT");
    if (data.more == null) return { entries, more: null };
    const more = data.more;
    if (
      !entries.length ||
      !isRecord(more) ||
      typeof more.moreFrom !== "string" ||
      !Number.isFinite(Date.parse(more.moreFrom)) ||
      (typeof more.moreSequence !== "string" &&
        typeof more.moreSequence !== "number")
    )
      throw new NaverRequestError("NAVER_INVALID_PAGINATION");
    return {
      entries,
      more: { moreFrom: more.moreFrom, moreSequence: more.moreSequence },
    };
  }

  private async fetchOrderDetails(
    store: Store,
    credential: ResolvedCommerceCredential,
    productOrderIds: string[],
    signal?: AbortSignal,
  ): Promise<JsonRecord[]> {
    const results: JsonRecord[] = [];
    for (const batch of chunk(productOrderIds, DETAIL_BATCH_SIZE)) {
      const found = new Map<string, JsonRecord>();
      let missing = batch;
      for (let attempt = 0; attempt < 2 && missing.length; attempt += 1) {
        const response = await this.requestSellerJson(
          "/v1/pay-order/seller/product-orders/query",
          store,
          credential,
          { method: "POST", body: { productOrderIds: missing }, signal },
        );
        if (!isRecord(response) || !Array.isArray(response.data))
          throw new NaverRequestError("NAVER_INVALID_RESPONSE");
        const requested = new Set(missing);
        for (const entry of response.data) {
          if (
            !isRecord(entry) ||
            !isRecord(entry.productOrder) ||
            !isRecord(entry.order)
          )
            throw new NaverRequestError("NAVER_INVALID_ORDER");
          const id = this.extractProductOrderId(entry);
          if (!id || !requested.has(id) || found.has(id))
            throw new NaverRequestError("NAVER_UNEXPECTED_DETAIL_ID");
          found.set(id, entry);
        }
        missing = batch.filter((id) => !found.has(id));
      }
      if (missing.length)
        throw new NaverRequestError("NAVER_MISSING_ORDER_DETAILS", true);
      results.push(...batch.map((id) => found.get(id)!));
    }
    return results;
  }

  private normalizeOrderDetail(
    detailEnvelope: JsonRecord,
    changedOrder: JsonRecord | undefined,
    options?: { includeRawPayload?: boolean },
  ): SyncedOrderItemInput {
    const productOrder = isRecord(detailEnvelope.productOrder)
      ? detailEnvelope.productOrder
      : detailEnvelope;
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

    if (
      !externalProductOrderId ||
      !externalOrderId ||
      typeof productOrder.productOrderId !== "string" ||
      typeof order?.orderId !== "string"
    ) {
      throw new NaverRequestError("NAVER_INVALID_ORDER_ID");
    }

    const quantity = pickNumber(productOrder.quantity);
    const amount = pickNumber(productOrder.totalPaymentAmount);
    if (
      quantity == null ||
      !Number.isInteger(quantity) ||
      quantity < 1 ||
      amount == null ||
      !Number.isFinite(amount) ||
      amount < 0
    )
      throw new NaverRequestError("NAVER_INVALID_ORDER_AMOUNT");
    for (const field of [
      "totalProductAmount",
      "deliveryFeeAmount",
      "paymentCommission",
      "knowledgeShoppingSellingInterlockCommission",
      "saleCommission",
      "channelCommission",
    ]) {
      if (
        productOrder[field] != null &&
        pickNumber(productOrder[field]) == null
      )
        throw new NaverRequestError("NAVER_INVALID_ORDER_AMOUNT");
    }

    const rawProductName =
      pickString(
        productOrder.productName,
        product?.productName,
        detailEnvelope.productName,
      ) ?? `NAVER_PRODUCT_${externalProductOrderId}`;
    const rawOptionInfo = this.buildOptionInfo(
      productOrder,
      product,
      detailEnvelope,
    );
    const productOrderStatus = pickString(
      productOrder.productOrderStatus,
      detailEnvelope.productOrderStatus,
      changedOrder?.productOrderStatus,
    );
    const claimStatus = this.extractClaimStatus(
      productOrder,
      detailEnvelope,
      changedOrder,
    );
    const rawStatus = claimStatus ?? productOrderStatus ?? "UNKNOWN";
    const orderDateTime = pickString(
      order?.orderDate,
      productOrder.orderDate,
      detailEnvelope.orderDate,
    );
    const paymentDateTime = pickString(
      order?.paymentDate,
      productOrder.paymentDate,
      detailEnvelope.paymentDate,
      productOrder.decisionDate,
    );
    if (
      !orderDateTime ||
      !Number.isFinite(Date.parse(orderDateTime)) ||
      (paymentDateTime != null && !Number.isFinite(Date.parse(paymentDateTime)))
    )
      throw new NaverRequestError("NAVER_INVALID_ORDER_DATE");

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
      quantity,
      productPaymentAmount: amount,
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
      paymentCommission: pickNumber(
        productOrder.paymentCommission,
        detailEnvelope.paymentCommission,
      ),
      knowledgeShoppingSellingInterlockCommission: pickNumber(
        productOrder.knowledgeShoppingSellingInterlockCommission,
        detailEnvelope.knowledgeShoppingSellingInterlockCommission,
      ),
      saleCommission: pickNumber(
        productOrder.saleCommission,
        detailEnvelope.saleCommission,
      ),
      channelCommission: pickNumber(
        productOrder.channelCommission,
        detailEnvelope.channelCommission,
      ),
      orderDate: toDateString(orderDateTime),
      paymentDate: toDateString(paymentDateTime),
      orderDateTime,
      paymentDateTime,
      productOrderStatus,
      claimStatus,
      rawStatus,
      saleStatus: saleStatusFromNaverState(productOrderStatus, claimStatus),
      packageNumber: pickString(
        productOrder.packageNumber,
        delivery?.packageNumber,
        detailEnvelope.packageNumber,
      ),
      rawPayload:
        options?.includeRawPayload === true
          ? {
              changedOrder: changedOrder ?? null,
              detail: detailEnvelope,
            }
          : null,
    };

    // optionManageCode가 있으면 추가 (빈 문자열은 제외)
    if (optionManageCode) {
      result.optionManageCode = optionManageCode;
    }

    return result;
  }

  private buildOptionInfo(
    productOrder: JsonRecord,
    product: JsonRecord | null,
    detailEnvelope: JsonRecord,
  ) {
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

    return pickString(
      productOrder.productOption,
      readableOptionInfo,
      productOrder.optionCode,
    );
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
        return optionPartsToText([
          entry.optionName,
          entry.valueName,
          entry.optionValue,
        ]);
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

      const currentClaim = isRecord(node.currentClaim)
        ? node.currentClaim
        : null;
      if (!currentClaim) {
        continue;
      }

      const nestedStatuses = [
        pickString(currentClaim.claimStatus),
        isRecord(currentClaim.cancel)
          ? pickString(currentClaim.cancel.claimStatus)
          : null,
        isRecord(currentClaim.return)
          ? pickString(currentClaim.return.claimStatus)
          : null,
        isRecord(currentClaim.exchange)
          ? pickString(currentClaim.exchange.claimStatus)
          : null,
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

  private extractChannelEntries(
    payload: unknown,
  ): Array<{ channelNo: string; channelName: string | null }> {
    const entries: Array<{ channelNo: string; channelName: string | null }> =
      [];

    const visit = (node: unknown) => {
      if (Array.isArray(node)) {
        node.forEach((entry) => visit(entry));
        return;
      }
      if (!isRecord(node)) {
        return;
      }

      const channelNo = pickString(
        node.channelNo,
        node.defaultChannelNo,
        node.representChannelNo,
      );
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
      signal?: AbortSignal;
    },
  ): Promise<unknown> {
    const url = new URL(`${NAVER_API_BASE_URL}${path}`);
    Object.entries(options?.query ?? {}).forEach(([key, value]) =>
      url.searchParams.set(key, value),
    );
    for (let attempt = 0; attempt < 2; attempt += 1) {
      options?.signal?.throwIfAborted();
      const token = await waitForNaverToken(
        this.getSellerToken(store, credential),
        options?.signal,
      );
      options?.signal?.throwIfAborted();
      try {
        return await requestNaverJson(
          url,
          {
            method: options?.method ?? "GET",
            headers: {
              Authorization: `Bearer ${token}`,
              ...(options?.body ? { "Content-Type": "application/json" } : {}),
            },
            body: options?.body ? JSON.stringify(options.body) : undefined,
          },
          options?.signal,
        );
      } catch (error) {
        if (
          !(error instanceof NaverRequestError) ||
          error.upstreamStatus !== 401 ||
          error.upstreamCode !== "GW.AUTHN" ||
          attempt > 0
        )
          throw error;
        const key = this.buildCacheKey(store, credential);
        if (this.tokenCache.get(key)?.accessToken === token)
          this.tokenCache.delete(key);
      }
    }
    throw new NaverRequestError("NAVER_AUTHENTICATION_FAILED");
  }

  private async getSellerToken(
    store: Store,
    credential: ResolvedCommerceCredential,
  ): Promise<string> {
    const cacheKey = this.buildCacheKey(store, credential);
    const cached = this.tokenCache.get(cacheKey);
    if (cached && cached.expiresAt - TOKEN_RENEWAL_BUFFER_MS > Date.now())
      return cached.accessToken;
    const pending = this.tokenRequests.get(cacheKey);
    if (pending) return pending;
    const request = this.issueSellerToken(store, credential, cacheKey);
    this.tokenRequests.set(cacheKey, request);
    try {
      return await request;
    } finally {
      this.tokenRequests.delete(cacheKey);
    }
  }

  private async issueSellerToken(
    store: Store,
    credential: ResolvedCommerceCredential,
    cacheKey: string,
  ): Promise<string> {
    const timestamp = Date.now().toString();
    const body = new URLSearchParams({
      client_id: credential.clientId,
      timestamp,
      client_secret_sign: createNaverClientSecretSign(
        credential.clientId,
        credential.clientSecret,
        timestamp,
      ),
      grant_type: "client_credentials",
      type: "SELLER",
      account_id: store.sellerAccountId,
    });
    const parsed = await requestNaverJson(
      `${NAVER_API_BASE_URL}/v1/oauth2/token`,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
      },
    );
    if (
      !isRecord(parsed) ||
      typeof parsed.access_token !== "string" ||
      !parsed.access_token ||
      typeof parsed.expires_in !== "number" ||
      !Number.isFinite(parsed.expires_in) ||
      parsed.expires_in <= 0
    )
      throw new NaverRequestError("NAVER_INVALID_TOKEN_RESPONSE");
    const expiresAt = Date.now() + parsed.expires_in * 1000;
    await this.recordTokenIssuedAt(credential.credentialId, expiresAt);
    this.tokenCache.set(cacheKey, {
      accessToken: parsed.access_token,
      expiresAt,
    });
    return parsed.access_token;
  }

  private async recordTokenIssuedAt(
    credentialId: string | null,
    expiresAt: number,
  ) {
    if (!credentialId) {
      return;
    }

    const issuedAtIso = new Date().toISOString();
    const expiresAtIso = new Date(expiresAt).toISOString();
    await this.databaseService.writeCommitted((draft) => {
      const credential = draft.commerceCredentials.find(
        (item) => item.id === credentialId,
      );
      if (!credential) {
        return;
      }
      credential.lastTokenIssuedAt = issuedAtIso;
      credential.lastTokenExpiresAt = expiresAtIso;
      credential.updatedAt = issuedAtIso;
    });
  }

  private buildCacheKey(store: Store, credential: ResolvedCommerceCredential) {
    return `${store.sellerAccountId}:${credential.clientId}:${normalizeText(store.channelNo)}`;
  }
}
