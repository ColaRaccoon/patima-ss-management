"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { PageHeader } from "@/components/shared/page-header";
import { Panel } from "@/components/shared/panel";
import { StatusBadge } from "@/components/shared/status-badge";
import { requestBrowserApi } from "@/lib/api/browser";
import type { ProductStatus } from "@/lib/api/product-registrations";
import type { StoreListItem } from "@/lib/api/types";
import { formatCurrency, formatDate, formatNumber, formatPercent } from "@/lib/format";
import { buildHrefWithStore } from "@/lib/store-selection";

const orderLabels = { CONNECTED: "주문 연결 완료", REVIEW: "주문 연결 확인 필요", WAITING: "첫 주문 대기" };
const profitLabels = { COMPLETE: "손익 반영", INCOMPLETE_COST: "원가 부족", WAITING: "손익 데이터 대기" };
const adLabels = { CONNECTED: "광고 연결 완료", REVIEW: "광고 연결 확인 필요", WAITING: "광고 데이터 대기", NOT_ADVERTISED: "미집행" };

export function ProductStatusView({
  store, salesUnitId, initialDate, recalculationPending,
}: {
  store: StoreListItem;
  salesUnitId: string;
  initialDate: string;
  recalculationPending: boolean;
}) {
  const [date, setDate] = useState(initialDate);
  const [draftDate, setDraftDate] = useState(initialDate);
  const [status, setStatus] = useState<ProductStatus | null>(null);
  const [version, setVersion] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [actionError, setActionError] = useState("");
  const [notice, setNotice] = useState("");
  const [saving, setSaving] = useState(false);
  const [orderTargets, setOrderTargets] = useState<Record<string, string>>({});
  const [adSelections, setAdSelections] = useState<string[]>([]);
  const [campaignPattern, setCampaignPattern] = useState("");
  const inFlight = useRef(false);
  const alert = useRef<HTMLDivElement>(null);
  const productApi = "/api/product-registrations/" + encodeURIComponent(salesUnitId);
  const listHref = buildHrefWithStore("/sales-units", null, store.id);
  const canWrite = store.isActive && Boolean(status?.product.isActive) && !loading && !saving;

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    void requestBrowserApi<ProductStatus>(
      productApi + "/status?" + new URLSearchParams({ storeId: store.id, date }),
      { cache: "no-store", signal: controller.signal },
      "상품 상태를 불러오지 못했습니다.",
    ).then((data) => {
      if (!controller.signal.aborted) {
        setStatus(data);
        setOrderTargets({});
        setAdSelections([]);
      }
    }).catch((cause: unknown) => {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "상품 상태를 불러오지 못했습니다.");
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [date, productApi, store.id, version]);

  useEffect(() => {
    if (actionError) alert.current?.focus();
  }, [actionError]);

  function refresh() {
    setLoading(true);
    setVersion((current) => current + 1);
  }

  async function save(path: string, body: object, success: string, method = "POST") {
    if (inFlight.current || !canWrite) return false;
    inFlight.current = true;
    setSaving(true);
    setActionError("");
    setNotice("");
    try {
      await requestBrowserApi(path, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }, "변경사항을 저장하지 못했습니다.");
      setNotice(success);
      refresh();
      return true;
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : "변경사항을 저장하지 못했습니다.");
      return false;
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  }

  const activeConfigurations = status?.configurations.filter((row) => row.isActive) ?? [];
  const profitsHref = buildHrefWithStore("/profits", new URLSearchParams({ date, salesUnitId }), store.id);
  const mappingsHref = (kind: "order" | "ad") => {
    const search = new URLSearchParams({ [kind + "Q"]: status?.product.displayName ?? "" });
    return buildHrefWithStore("/mappings", search, store.id) + (kind === "order" ? "#order-mapping" : "#advertising-mapping");
  };

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <PageHeader
        eyebrow={store.name}
        title={status?.product.displayName ?? "상품 상태"}
        description="판매 구성별 원가, 주문·광고 연결, 손익 반영 상태를 확인하세요."
        actions={<Link href={listHref} className="button-shell button-secondary">판매단위 목록</Link>}
      />
      <div className="flex flex-wrap items-end justify-between gap-3 rounded-2xl border border-ink/10 bg-white/75 p-4">
        <form className="flex flex-wrap items-end gap-2" onSubmit={(event) => {
          event.preventDefault();
          setDate(draftDate);
          setNotice("");
          setActionError("");
          refresh();
        }}>
          <label>
            <span className="mb-1 block text-sm font-medium">기준일</span>
            <input className="input-shell" type="date" required value={draftDate} disabled={saving} onChange={(event) => setDraftDate(event.target.value)} />
          </label>
          <button className="button-shell button-secondary" type="submit" disabled={saving || loading}>조회</button>
        </form>
        {status && <Link className="button-shell button-primary" href={profitsHref}>이 상품의 손익 보기</Link>}
      </div>
      {recalculationPending && (
        <p className="rounded-xl bg-amber-50 p-3 text-sm text-amber-900">등록 당시 손익 갱신이 완료되지 않았습니다. 아래에서 현재 반영 상태를 확인하세요.</p>
      )}
      <div aria-live="polite" className="empty:hidden">
        {loading && <p className="text-sm text-ink/65">상품 상태를 확인하는 중입니다.</p>}
        {notice && <p className="rounded-xl bg-emerald-50 p-3 text-sm text-emerald-800">{notice}</p>}
      </div>
      {(error || actionError) && (
        <div ref={alert} tabIndex={-1} role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800">
          <p>{error || actionError}</p>
          <button type="button" className="button-shell button-secondary" disabled={loading || saving} onClick={() => { setActionError(""); refresh(); }}>상태 다시 조회</button>
        </div>
      )}
      {status && status.date === date && !error && (
        <>
          <Panel title="판매 구성별 반영 상태" description={formatDate(status.date) + " 기준 비용과 손익입니다. 주문 연결 건수는 스토어의 수집 이력을 기준으로 표시합니다."}>
            {status.product.isGroup && (
              <div className="mb-4 flex flex-wrap items-center gap-3 border-b border-ink/10 pb-4">
                <span className="text-sm font-semibold">상품군 전체 손익</span>
                <StatusBadge tone={status.profit.state === "COMPLETE" ? "success" : status.profit.state === "INCOMPLETE_COST" ? "warning" : "muted"}>{profitLabels[status.profit.state]}</StatusBadge>
                {status.profit.estimatedNetProfit !== null && <span className="text-sm font-semibold">{formatCurrency(status.profit.estimatedNetProfit)}</span>}
              </div>
            )}
            {status.configurations.length === 0 && <p className="text-sm text-ink/65">등록된 판매 구성이 없습니다.</p>}
            <div className="space-y-3">
              {status.configurations.map((row) => (
                <div key={row.id} className="rounded-2xl border border-ink/10 bg-white/70 p-4">
                  <div className="grid items-start gap-4 sm:grid-cols-2 lg:grid-cols-[1.1fr_1fr_1fr_1fr]">
                    <div className="min-w-0">
                      <h3 className="break-words font-semibold">{row.displayName}</h3>
                      {!row.isActive && <span className="text-xs text-ink/65">비활성</span>}
                    </div>
                    <div className="min-w-0">
                      <StatusBadge tone={row.cost ? "success" : "warning"}>{row.cost ? "원가 적용" : "원가 미설정"}</StatusBadge>
                      {row.cost && (
                        <div className="mt-2 space-y-1 text-xs text-ink/70">
                          <p className="text-sm font-semibold text-ink">{formatCurrency(row.cost.unitCost)}</p>
                          <p>기타 {formatCurrency(row.cost.otherCost)} · 수수료 {row.cost.feeRate == null ? "자동" : formatPercent(row.cost.feeRate)}</p>
                          <p className="break-words">{row.cost.source === "EXCEL" ? row.cost.sourceFileName || "비용 엑셀" : "개별 입력"} · {row.cost.effectiveFrom} 적용</p>
                        </div>
                      )}
                    </div>
                    <div>
                      <StatusBadge tone={row.order.state === "CONNECTED" ? "success" : row.order.state === "REVIEW" ? "warning" : "muted"}>{orderLabels[row.order.state]}</StatusBadge>
                      {row.order.mappedSignatureCount > 0 && <p className="mt-2 text-xs text-ink/65">주문 조합 {formatNumber(row.order.mappedSignatureCount)}개 · 상품 행 {formatNumber(row.order.orderItemCount)}건</p>}
                    </div>
                    <div>
                      <StatusBadge tone={row.profit.state === "COMPLETE" ? "success" : row.profit.state === "INCOMPLETE_COST" ? "warning" : "muted"}>{profitLabels[row.profit.state]}</StatusBadge>
                      {row.profit.estimatedNetProfit !== null && <p className="mt-2 text-sm font-semibold">{formatCurrency(row.profit.estimatedNetProfit)}</p>}
                    </div>
                  </div>
                  {!row.cost && row.isActive && status.product.isActive && store.isActive && (
                    <CostEntryForm key={row.id + ":" + date} disabled={!canWrite} date={date} onSave={(cost) => save("/api/sales-unit-cost-settings", {
                      ...cost,
                      storeId: store.id,
                      canonicalSalesUnitId: row.id,
                      effectiveFrom: date,
                    }, row.displayName + " 원가를 저장했습니다.")} />
                  )}
                </div>
              ))}
            </div>
          </Panel>
          <Panel title="주문 연결" aside={
            <div className="flex flex-wrap gap-2">
              <Link href={buildHrefWithStore("/orders", null, store.id)} className="button-shell button-secondary">주문 데이터</Link>
              <Link href={mappingsHref("order")} className="button-shell button-ghost">주문 더 찾기</Link>
            </div>
          }>
            {status.orderCandidates.length === 0 ? (
              <p className="text-sm text-ink/65">확인이 필요한 주문 후보가 없습니다. 주문 데이터에서 동기화하거나 주문 매핑에서 상품명으로 검색할 수 있습니다.</p>
            ) : (
              <ul className="divide-y divide-ink/10">
                {status.orderCandidates.map((order) => (
                  <li className="grid items-center gap-3 py-3 lg:grid-cols-[minmax(0,1fr)_14rem_auto]" key={order.id}>
                    <div className="min-w-0">
                      <p className="break-words text-sm font-semibold">{order.productName || "상품명 미확인"}</p>
                      <p className="break-words text-xs text-ink/65">{order.optionInfo || "옵션 없음"} · 주문 {formatNumber(order.usageCount)}건{order.mappingStatus === "CONFLICT" ? " · 연결 충돌" : ""}</p>
                      {order.suggestedConfigurationIds.length > 0 && (
                        <p className="mt-1 text-xs text-ink/65">후보 {activeConfigurations.filter((row) => order.suggestedConfigurationIds.includes(row.id)).map((row) => row.displayName).join(", ")}</p>
                      )}
                    </div>
                    <select className="input-shell" aria-label={(order.productName || "주문") + " " + (order.optionInfo ?? "") + " 연결 구성"} value={orderTargets[order.id] ?? ""} disabled={!canWrite} onChange={(event) => setOrderTargets((current) => ({ ...current, [order.id]: event.target.value }))}>
                      <option value="">연결 구성 선택</option>
                      {activeConfigurations.map((row) => <option key={row.id} value={row.id}>{row.displayName}</option>)}
                    </select>
                    <button className="button-shell button-secondary justify-self-start" type="button" disabled={!canWrite || !orderTargets[order.id]} onClick={() => void save("/api/order-source-signatures/batch-mapping", {
                      signatureIds: [order.id],
                      canonicalSalesUnitId: orderTargets[order.id],
                      requireUnmapped: true,
                    }, "주문 연결을 저장했습니다.")}>연결 확정</button>
                  </li>
                ))}
              </ul>
            )}
            {status.orderCandidateCount > status.orderCandidates.length && <p className="mt-3 text-sm text-ink/65">후보 {formatNumber(status.orderCandidateCount)}개 중 {formatNumber(status.orderCandidates.length)}개를 표시했습니다.</p>}
          </Panel>
          <Panel title="광고 연결" aside={
            <div className="flex flex-wrap gap-2">
              <Link href={buildHrefWithStore("/ads/uploads", null, store.id)} className="button-shell button-secondary">광고 업로드</Link>
              <Link href={mappingsHref("ad")} className="button-shell button-ghost">캠페인 더 찾기</Link>
            </div>
          }>
            <div className="flex flex-wrap items-center gap-3">
              <StatusBadge tone={status.advertising.state === "CONNECTED" ? "success" : status.advertising.state === "REVIEW" ? "warning" : "muted"}>{adLabels[status.advertising.state]}</StatusBadge>
              <p className="text-sm text-ink/70">연결 캠페인 {formatNumber(status.advertising.campaignCount)}개 · 활성 규칙 {formatNumber(status.advertising.activeRuleCount)}개 · 기준일 광고비 {formatCurrency(status.advertising.dateCost)}</p>
              {(status.advertising.declaredNotAdvertised || status.advertising.state === "WAITING") && (
                <button type="button" className="button-shell button-ghost" disabled={!canWrite} onClick={() => void save(productApi + "/advertising", {
                  storeId: store.id,
                  notAdvertised: !status.advertising.declaredNotAdvertised,
                }, status.advertising.declaredNotAdvertised ? "미집행 표시를 해제했습니다." : "광고 미집행으로 표시했습니다.", "PUT")}>
                  {status.advertising.declaredNotAdvertised ? "미집행 표시 해제" : "광고 미집행으로 표시"}
                </button>
              )}
            </div>
            {status.advertising.candidates.length > 0 && (
              <div className="mt-4 rounded-2xl border border-ink/10 bg-white/70 p-4">
                <h3 className="text-sm font-semibold">확인이 필요한 캠페인</h3>
                <ul className="mt-2 divide-y divide-ink/10">
                  {status.advertising.candidates.map((campaign) => (
                    <li key={campaign.id}>
                      <label className="flex items-start gap-3 py-2 text-sm">
                        <input className="mt-1 accent-[var(--accent)]" type="checkbox" checked={adSelections.includes(campaign.id)} disabled={!canWrite} onChange={(event) => setAdSelections((current) => event.target.checked ? [...current, campaign.id] : current.filter((id) => id !== campaign.id))} />
                        <span className="min-w-0"><span className="block break-words font-medium">{campaign.campaignName}</span>
                          <span className="block break-words text-xs text-ink/65">{campaign.reportDate} · {formatCurrency(campaign.totalCost)}{campaign.mappingReason ? " · " + campaign.mappingReason : ""}</span>
                        </span>
                      </label>
                    </li>
                  ))}
                </ul>
                {status.advertising.candidateCount > status.advertising.candidates.length && <p className="my-2 text-sm text-ink/65">후보 {formatNumber(status.advertising.candidateCount)}개 중 {formatNumber(status.advertising.candidates.length)}개를 표시했습니다.</p>}
                <button type="button" className="button-shell button-secondary mt-2" disabled={!canWrite || !adSelections.length} onClick={() => void save("/api/ad-campaign-costs/batch-mapping", {
                  adCostIds: adSelections,
                  canonicalSalesUnitId: status.product.id,
                  requireUnmapped: true,
                }, "선택한 광고를 연결했습니다.")}>선택한 광고 연결</button>
              </div>
            )}
            {status.product.isActive && store.isActive && (
              <details className="mt-4 border-t border-ink/10 pt-3 text-sm">
                <summary className="cursor-pointer font-medium">캠페인 자동 연결 규칙 추가</summary>
                <form className="mt-3 flex flex-wrap items-end gap-3" onSubmit={async (event) => {
                  event.preventDefault();
                  if (!campaignPattern.trim()) return;
                  if (await save("/api/campaign-mappings", {
                    storeId: store.id,
                    canonicalSalesUnitId: status.product.id,
                    campaignPattern: campaignPattern.trim(),
                  }, "캠페인 연결 규칙을 저장했습니다.")) setCampaignPattern("");
                }}>
                  <label className="min-w-0 flex-1">
                    <span className="mb-2 block text-sm">이 상품의 캠페인에만 들어가는 이름이나 코드</span>
                    <input className="input-shell" required value={campaignPattern} disabled={!canWrite} onChange={(event) => setCampaignPattern(event.target.value)} />
                  </label>
                  <button type="submit" className="button-shell button-secondary" disabled={!canWrite || !campaignPattern.trim()}>연결 규칙 저장</button>
                </form>
              </details>
            )}
          </Panel>
        </>
      )}
    </div>
  );
}

function CostEntryForm({ date, disabled, onSave }: {
  date: string;
  disabled: boolean;
  onSave: (cost: { unitCost: number; otherCost: number; feeRate: number | null }) => Promise<boolean>;
}) {
  const [unitCost, setUnitCost] = useState("");
  const [otherCost, setOtherCost] = useState("");
  const [feeRate, setFeeRate] = useState("");
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (unitCost === "") return;
    await onSave({
      unitCost: Number(unitCost),
      otherCost: Number(otherCost),
      feeRate: feeRate === "" ? null : Number(feeRate) / 100,
    });
  }
  return (
    <details className="mt-4 border-t border-ink/10 pt-3 text-sm">
      <summary className="cursor-pointer font-medium">원가 입력</summary>
      <form className="mt-3 grid items-end gap-3 sm:grid-cols-2 lg:grid-cols-4" onSubmit={(event) => void submit(event)}>
        <label><span className="mb-2 block">원가 (원)</span><input className="input-shell" type="number" min={0} step={1} required disabled={disabled} value={unitCost} onChange={(event) => setUnitCost(event.target.value)} /></label>
        <label><span className="mb-2 block">기타비용 (원)</span><input className="input-shell" type="number" min={0} step={1} placeholder="0" disabled={disabled} value={otherCost} onChange={(event) => setOtherCost(event.target.value)} /></label>
        <label><span className="mb-2 block">수수료율 (%)</span><input className="input-shell" type="number" min={0} max={100} step="any" placeholder="자동" disabled={disabled} value={feeRate} onChange={(event) => setFeeRate(event.target.value)} /></label>
        <button type="submit" className="button-shell button-secondary" disabled={disabled || unitCost === ""}>{date}부터 적용</button>
      </form>
    </details>
  );
}
