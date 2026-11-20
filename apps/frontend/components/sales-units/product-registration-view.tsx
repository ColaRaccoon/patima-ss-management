"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { ChevronDown, Copy, Plus, X } from "lucide-react";
import { requestBrowserApi } from "@/lib/api/browser";
import type { ProductEditData, ProductOrderContext, ProductRegistrationResult } from "@/lib/api/product-registrations";
import type { StoreListItem } from "@/lib/api/types";
import { buildHrefWithStore } from "@/lib/store-selection";

const MAX_CONFIGURATIONS = 50;

function emptyConfiguration(id: number) {
  return { id, name: "", unitCost: "", otherCost: "", feeRate: "", effectiveFrom: "", aliases: "", productIds: "", optionCodes: "", manageCodes: "", memo: "" };
}

function editConfigurations(edit: ProductEditData) {
  return edit.configurations.map((row, index) => ({
    id: index + 1,
    name: row.name,
    unitCost: row.cost ? String(row.cost.unitCost) : "",
    otherCost: row.cost ? String(row.cost.otherCost) : "",
    feeRate: row.cost?.feeRate == null ? "" : String(row.cost.feeRate * 100),
    effectiveFrom: row.cost && row.cost.effectiveFrom !== edit.effectiveFrom ? row.cost.effectiveFrom : "",
    aliases: row.matchAliases.join(", "),
    productIds: row.linkedProductIds.join(", "),
    optionCodes: row.linkedOptionCodes.join(", "),
    manageCodes: row.linkedManageCodes.join(", "),
    memo: row.memo ?? "",
  }));
}

function splitValues(value: string) {
  return [...new Set(value.split(/[\r\n,]+/).map((item) => item.trim()).filter(Boolean))];
}

function createRequestId() {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join("-");
}

export function ProductRegistrationView({
  store,
  today,
  signatureIds,
  onSaved,
  edit,
  focusConfigurationId,
  onSavingChange,
  disabled = false,
}: {
  store: StoreListItem;
  today: string;
  signatureIds: string[];
  onSaved: (result: Pick<ProductRegistrationResult, "salesUnitId" | "recalculationPending">, effectiveFrom: string) => void;
  edit?: ProductEditData;
  focusConfigurationId?: string;
  onSavingChange?: (saving: boolean) => void;
  disabled?: boolean;
}) {
  const [name, setName] = useState(edit?.product.displayName ?? "");
  const [effectiveFrom, setEffectiveFrom] = useState(edit?.effectiveFrom ?? today);
  const [aliases, setAliases] = useState(edit?.product.matchAliases.join(", ") ?? "");
  const [memo, setMemo] = useState(edit?.product.memo ?? "");
  const [configurations, setConfigurations] = useState(() => edit ? editConfigurations(edit) : [emptyConfiguration(1)]);
  const [orderContext, setOrderContext] = useState<ProductOrderContext[]>([]);
  const [assignments, setAssignments] = useState<Record<string, number>>({});
  const [isLoadingOrders, setIsLoadingOrders] = useState(signatureIds.length > 0);
  const [orderLoadError, setOrderLoadError] = useState("");
  const [loadVersion, setLoadVersion] = useState(0);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [advancedRows, setAdvancedRows] = useState<Record<number, boolean>>(() => {
    const index = edit?.configurations.findIndex((row) => row.id === focusConfigurationId) ?? -1;
    return index === -1 ? {} : { [index + 1]: true };
  });
  const nextRowId = useRef(2);
  const attempt = useRef<{ payload: string; id: string } | null>(null);
  const inFlight = useRef(false);

  useEffect(() => {
    if (!signatureIds.length) return;
    const controller = new AbortController();
    const query = new URLSearchParams({ storeId: store.id });
    for (const id of signatureIds) query.append("signatureId", id);
    setIsLoadingOrders(true);
    setOrderLoadError("");
    void requestBrowserApi<{ items: ProductOrderContext[] }>(
      "/api/product-registrations/order-context?" + query,
      { signal: controller.signal, cache: "no-store" },
      "선택한 주문을 불러오지 못했습니다.",
    ).then(({ items }) => {
      if (controller.signal.aborted) return;
      if (items.length !== signatureIds.length) throw new Error("선택한 주문 일부를 찾을 수 없습니다. 주문 매핑 화면에서 다시 선택해 주세요.");
      setOrderContext(items);
      setAssignments({});
      if (items[0]?.productName && items.every((item) => item.productName === items[0].productName)) {
        setName((current) => current || items[0].productName);
      }
    }).catch((cause: unknown) => {
      if (!controller.signal.aborted) setOrderLoadError(cause instanceof Error ? cause.message : "선택한 주문을 불러오지 못했습니다.");
    }).finally(() => {
      if (!controller.signal.aborted) setIsLoadingOrders(false);
    });
    return () => controller.abort();
  }, [store.id, signatureIds, loadVersion]);

  const updateRow = (id: number, patch: Partial<Omit<ReturnType<typeof emptyConfiguration>, "id">>) => {
    setConfigurations((current) => current.map((row) => row.id === id ? { ...row, ...patch } : row));
  };

  const addConfiguration = () => {
    const id = nextRowId.current++;
    setConfigurations((current) => [...current, emptyConfiguration(id)]);
    // Existing order rows need an explicit destination once multiple configurations exist.
    if (configurations.length === 1) setAssignments({});
  };

  const removeConfiguration = (id: number) => {
    const remaining = configurations.filter((row) => row.id !== id);
    setConfigurations(remaining);
    setAssignments((current) => remaining.length === 1
      ? Object.fromEntries(orderContext.map((order) => [order.id, remaining[0].id]))
      : Object.fromEntries(Object.entries(current).filter(([, rowId]) => rowId !== id)));
  };

  const copyFirstCosts = () => {
    const { unitCost, otherCost, feeRate } = configurations[0];
    setConfigurations((current) => current.map((row) => ({ ...row, unitCost, otherCost, feeRate })));
  };

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlight.current || disabled || isLoadingOrders || orderLoadError) return;
    setError("");
    const displayName = name.trim();
    const requiresConfigurationName = edit?.product.isGroup ?? configurations.length > 1;
    if (!displayName || configurations.some((row) => requiresConfigurationName && !row.name.trim())) {
      setError("상품명과 각 구성의 이름을 입력해 주세요.");
      return;
    }
    const assignedRow = (id: string) => configurations.length === 1 ? configurations[0].id : assignments[id];
    if (signatureIds.some((id) => !configurations.some((row) => row.id === assignedRow(id)))) {
      setError("선택한 모든 주문의 판매 구성을 지정해 주세요.");
      return;
    }
    if (configurations.some((row) => !row.unitCost && (Number(row.otherCost) !== 0 || row.feeRate !== ""))) {
      setError("기타비용이나 수수료율을 저장하려면 해당 구성의 원가를 입력해 주세요.");
      return;
    }
    const payload = {
      storeId: store.id,
      displayName,
      effectiveFrom,
      matchAliases: splitValues(aliases),
      configurations: configurations.map((row) => ({
        name: row.name.trim(),
        effectiveFrom: row.effectiveFrom || undefined,
        unitCost: row.unitCost === "" ? null : Number(row.unitCost),
        otherCost: row.otherCost === "" ? 0 : Number(row.otherCost),
        feeRate: row.feeRate === "" ? null : Number(row.feeRate) / 100,
        matchAliases: splitValues(row.aliases),
        linkedProductIds: splitValues(row.productIds),
        linkedOptionCodes: splitValues(row.optionCodes),
        linkedManageCodes: splitValues(row.manageCodes),
        orderSignatureIds: signatureIds.filter((id) => assignedRow(id) === row.id),
      })),
    };
    const serialized = JSON.stringify(payload);
    inFlight.current = true;
    setSaving(true);
    onSavingChange?.(true);
    try {
      if (edit) {
        const originalRows = editConfigurations(edit);
        const result = await requestBrowserApi<Pick<ProductRegistrationResult, "salesUnitId" | "recalculationPending">>(
          "/api/product-registrations/" + encodeURIComponent(edit.product.id) + "/edit",
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              ...payload,
              date: edit.date,
              version: edit.version,
              memo,
              configurations: payload.configurations.map((row, index) => {
                const current = configurations[index];
                const original = originalRows[index];
                const costDate = row.effectiveFrom || effectiveFrom;
                const changedCost = current.unitCost !== original.unitCost || current.otherCost !== original.otherCost ||
                  current.feeRate !== original.feeRate || costDate !== (original.effectiveFrom || edit.effectiveFrom);
                return {
                  ...row,
                  id: edit.configurations[index].id,
                  memo: current.memo,
                  ...(changedCost && (row.unitCost !== null || edit.configurations[index].cost) && {
                    cost: row.unitCost === null ? null : {
                      effectiveFrom: costDate, unitCost: row.unitCost, otherCost: row.otherCost, feeRate: row.feeRate,
                    },
                  }),
                };
              }),
            }),
          },
          "판매단위를 수정하지 못했습니다.",
        );
        onSaved(result, effectiveFrom);
        return;
      }
      if (attempt.current?.payload !== serialized) {
        attempt.current = { payload: serialized, id: createRequestId() };
      }
      const result = await requestBrowserApi<ProductRegistrationResult>("/api/product-registrations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...payload, requestId: attempt.current.id }),
      }, "신상품을 저장하지 못했습니다.");
      onSaved(result, effectiveFrom);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "신상품을 저장하지 못했습니다.");
      inFlight.current = false;
      setSaving(false);
    } finally {
      onSavingChange?.(false);
    }
  }


  return (
    <form onSubmit={(event) => void submit(event)} className={edit ? "pt-2" : "border-t border-ink/10 px-3 pb-3 pt-2.5 sm:px-4"}>
      <fieldset disabled={saving || disabled} className="min-w-0 space-y-2.5 text-sm">
        <div className="grid gap-2.5 sm:grid-cols-[minmax(0,1.2fr)_10rem] lg:grid-cols-[minmax(0,1.2fr)_10rem_minmax(0,1fr)]">
          <label className="min-w-0">
            <span className="mb-1 block text-xs font-semibold">상품명</span>
            <input id={edit ? undefined : "new-product-name"} className="input-shell" required maxLength={edit ? 200 : 120} placeholder="예: 에어핏 러닝벨트" value={name} onChange={(event) => setName(event.target.value)} />
          </label>
          <label className="min-w-0">
            <span className="mb-1 block text-xs font-semibold">공통 원가 적용일</span>
            <input className="input-shell" type="date" required value={effectiveFrom} onChange={(event) => setEffectiveFrom(event.target.value)} />
          </label>
          <label className="min-w-0 sm:col-span-2 lg:col-span-1">
            <span className="mb-1 block text-xs font-semibold">공통 연결 키워드 <span className="font-normal text-ink/65">(선택)</span></span>
            <input className="input-shell" placeholder="상품 고유 키워드를 쉼표로 구분" value={aliases} onChange={(event) => setAliases(event.target.value)} />
          </label>
        </div>
        {edit && (
          <label className="block">
            <span className="mb-1 block text-xs font-semibold">메모</span>
            <input className="input-shell" value={memo} onChange={(event) => setMemo(event.target.value)} maxLength={1000} />
          </label>
        )}

        {(configurations.length > 0 || !edit) && <section className="rounded-md border border-ink/10 bg-white/70" aria-label="판매 구성과 원가">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-ink/10 px-2.5 py-1.5">
            <h3 className="text-sm font-semibold">판매 구성 · 원가</h3>
            <div className="flex flex-wrap items-center gap-2">
              {configurations.length > 1 && (
                <button type="button" className="button-shell button-ghost" onClick={copyFirstCosts}><Copy aria-hidden="true" size={14} /> 첫 구성 비용 복사</button>
              )}
              {!edit && <button type="button" className="button-shell button-secondary" disabled={configurations.length >= MAX_CONFIGURATIONS} onClick={addConfiguration}><Plus aria-hidden="true" size={14} /> 구성 추가</button>}
            </div>
          </div>

          {configurations.map((row, index) => (
            <fieldset key={row.id} className="min-w-0 border-ink/10 px-2.5 py-2 [&:not(:last-child)]:border-b">
              <legend className="sr-only">{row.name.trim() || "판매 구성 " + (index + 1)}</legend>
              <div className="grid grid-cols-2 items-end gap-2 sm:grid-cols-[1.35fr_1fr_1fr_1fr] lg:grid-cols-[1.35fr_1fr_1fr_1fr_6rem]">
                <label className="min-w-0">
                  <span className="mb-1 block text-xs font-medium">구성 이름</span>
                  <input className="input-shell" placeholder={index === 0 ? "예: 단품" : "예: 1+1"} value={row.name} maxLength={edit ? 200 : 100} required={edit?.product.isGroup ?? configurations.length > 1} onChange={(event) => updateRow(row.id, { name: event.target.value })} />
                </label>
                <label className="min-w-0">
                  <span className="mb-1 block text-xs font-medium">원가 (원)</span>
                  <input className="input-shell" type="number" min={0} step={edit ? "any" : 1} value={row.unitCost} onChange={(event) => updateRow(row.id, { unitCost: event.target.value })} />
                </label>
                <label className="min-w-0">
                  <span className="mb-1 block text-xs font-medium">기타비용 (원)</span>
                  <input className="input-shell" type="number" min={0} step={edit ? "any" : 1} placeholder="0" value={row.otherCost} onChange={(event) => updateRow(row.id, { otherCost: event.target.value })} />
                </label>
                <label className="min-w-0">
                  <span className="mb-1 block text-xs font-medium">수수료율 (%)</span>
                  <input className="input-shell" type="number" min={0} max={100} step="any" placeholder="자동" value={row.feeRate} onChange={(event) => updateRow(row.id, { feeRate: event.target.value })} />
                </label>
                <div className="col-span-2 flex justify-end gap-0.5 sm:col-span-4 lg:col-span-1">
                  <button type="button" className="button-shell button-ghost" aria-expanded={Boolean(advancedRows[row.id])} onClick={() => setAdvancedRows((current) => ({ ...current, [row.id]: !current[row.id] }))}>
                    옵션 <ChevronDown aria-hidden="true" size={13} className={advancedRows[row.id] ? "rotate-180" : ""} />
                  </button>
                  {!edit && configurations.length > 1 && (
                    <button type="button" className="button-shell button-ghost text-ink/70" aria-label={(row.name || "구성 " + (index + 1)) + " 삭제"} onClick={() => removeConfiguration(row.id)}><X aria-hidden="true" size={14} /></button>
                  )}
                </div>
              </div>
              {edit?.configurations[index].cost && (
                <p className="mt-1 text-xs text-ink/65">
                  현재 불러온 원가 · {edit.configurations[index].cost.effectiveFrom} · {edit.configurations[index].cost.source === "EXCEL"
                    ? (edit.configurations[index].cost.sourceFileName || "엑셀") + " · 변경값은 개별 원가로 저장됩니다."
                    : edit.configurations[index].canChangeExistingCost ? "개별 원가" : "주문에 적용된 원가 · 옵션에서 새 적용일을 지정하세요."}
                </p>
              )}
              <div hidden={!advancedRows[row.id]} className="mt-2 border-t border-ink/10 pt-2">
                <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
                  <label className="min-w-0">
                    <span className="mb-1 block text-xs font-medium">개별 원가 적용일</span>
                    <input className="input-shell" type="date" value={row.effectiveFrom} onChange={(event) => updateRow(row.id, { effectiveFrom: event.target.value })} />
                  </label>
                  {([
                    ["aliases", "상품명·옵션 키워드"],
                    ["productIds", "네이버 상품 ID"],
                    ["optionCodes", "네이버 옵션 코드"],
                    ["manageCodes", "옵션 관리 코드"],
                  ] as const).map(([field, label]) => (
                    <label className="min-w-0" key={field}>
                      <span className="mb-1 block text-xs font-medium">{label}</span>
                      <input className="input-shell" placeholder="쉼표로 구분" value={row[field]} onChange={(event) => updateRow(row.id, { [field]: event.target.value })} />
                    </label>
                  ))}
                </div>
                {edit?.product.isGroup && (
                  <label className="mt-2 block">
                    <span className="mb-1 block text-xs font-medium">구성 메모</span>
                    <input className="input-shell" value={row.memo} onChange={(event) => updateRow(row.id, { memo: event.target.value })} maxLength={1000} />
                  </label>
                )}
                <p className="mt-1.5 text-xs text-ink/65">개별 적용일이 비어 있으면 공통 적용일을 사용합니다. 같은 상품 ID에 구성이 여러 개면 옵션 코드 또는 구성별 키워드를 함께 입력하세요.</p>
              </div>
            </fieldset>
          ))}
        </section>}

        {signatureIds.length > 0 && (
          <section className="rounded-md border border-ink/10 px-2.5 py-2">
            <h3 className="mb-1 text-sm font-semibold">연결할 주문 {signatureIds.length}개</h3>
            {isLoadingOrders && <p role="status">주문을 불러오는 중입니다.</p>}
            {orderLoadError && (
              <div className="space-y-1.5">
                <p role="alert" className="text-sm text-red-700">{orderLoadError}</p>
                <button type="button" className="button-shell button-secondary" onClick={() => setLoadVersion((value) => value + 1)}>다시 불러오기</button>
                <Link href={buildHrefWithStore("/mappings", null, store.id)} className="button-shell button-ghost">주문 매핑으로 돌아가기</Link>
              </div>
            )}
            <ul className="max-h-56 divide-y divide-ink/10 overflow-y-auto">
              {orderContext.map((order) => (
                <li key={order.id} className="grid gap-1.5 py-1.5 sm:grid-cols-[1fr_14rem] sm:items-center">
                  <div>
                    <p className="break-words text-sm font-medium">{order.productName || "상품명 미확인"}</p>
                    <p className="break-words text-xs text-ink/65">{order.optionInfo || "옵션 없음"} · 주문 {order.usageCount}건</p>
                  </div>
                  <select aria-label={(order.productName || "주문") + " " + (order.optionInfo ?? "") + " 연결 구성"} className="input-shell" required value={configurations.length === 1 ? configurations[0].id : assignments[order.id] ?? ""} onChange={(event) => setAssignments((current) => ({ ...current, [order.id]: Number(event.target.value) }))}>
                    <option value="">연결 구성 선택</option>
                    {configurations.map((row, index) => <option key={row.id} value={row.id}>{row.name.trim() || "판매 구성 " + (index + 1)}</option>)}
                  </select>
                </li>
              ))}
            </ul>
          </section>
        )}

        {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs text-ink/65">{edit ? "원가를 바꾸면 지정한 적용일부터 손익에 반영됩니다." : "단일 상품은 구성 이름 생략 가능 · 원가 미정은 빈칸, 0원은 0 입력"}</p>
          <button className="button-shell button-primary" type="submit" disabled={saving || isLoadingOrders || Boolean(orderLoadError)}>
            {saving ? "저장 중…" : edit ? "수정 저장" : "상품 저장"}
          </button>
        </div>
      </fieldset>
    </form>
  );
}
