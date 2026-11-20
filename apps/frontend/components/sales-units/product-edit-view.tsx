"use client";

import { useEffect, useState } from "react";
import { requestBrowserApi } from "@/lib/api/browser";
import type { ProductEditData } from "@/lib/api/product-registrations";
import type { StoreListItem } from "@/lib/api/types";
import { ProductRegistrationView } from "./product-registration-view";

const NO_SELECTED_ORDERS: string[] = [];

export function ProductEditView({ store, salesUnitId, today, disabled, onSaved, onSavingChange }: {
  store: StoreListItem;
  salesUnitId: string;
  today: string;
  disabled: boolean;
  onSaved: (recalculationPending?: boolean) => void;
  onSavingChange: (saving: boolean) => void;
}) {
  const [requestedDate, setRequestedDate] = useState(today);
  const [date, setDate] = useState(today);
  const [result, setResult] = useState<ProductEditData>();
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    const query = new URLSearchParams({ storeId: store.id, date });
    setResult(undefined);
    setError("");
    void requestBrowserApi<ProductEditData>(
      "/api/product-registrations/" + encodeURIComponent(salesUnitId) + "/edit?" + query,
      { cache: "no-store", signal: controller.signal },
      "저장된 판매단위 정보를 불러오지 못했습니다.",
    ).then((data) => {
      if (!controller.signal.aborted) setResult(data);
    }).catch((cause: unknown) => {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "저장된 판매단위 정보를 불러오지 못했습니다.");
    });
    return () => controller.abort();
  }, [date, revision, salesUnitId, store.id]);

  return (
    <div>
      <form className="flex flex-wrap items-center gap-2" onSubmit={(event) => {
        event.preventDefault();
        setDate(requestedDate);
        setRevision((value) => value + 1);
      }}>
        <label className="flex items-center gap-2 text-xs font-semibold">
          <span className="whitespace-nowrap">원가 조회 기준일</span>
          <input className="input-shell" required disabled={disabled} type="date" value={requestedDate} onChange={(event) => setRequestedDate(event.target.value)} />
        </label>
        <button type="submit" className="button-shell button-secondary" disabled={disabled || (!error && requestedDate === date)}>조회</button>
      </form>
      {error && <p className="mt-2 text-sm text-red-700" role="alert">{error}</p>}
      {!result && !error && <p className="mt-2 text-sm text-ink/65" role="status">저장된 상품과 원가를 불러오는 중입니다.</p>}
      {result && (
        <ProductRegistrationView
          key={result.version + ":" + revision}
          store={store}
          today={today}
          signatureIds={NO_SELECTED_ORDERS}
          edit={result}
          focusConfigurationId={salesUnitId}
          disabled={disabled}
          onSavingChange={onSavingChange}
          onSaved={(saved) => onSaved(saved.recalculationPending)}
        />
      )}
    </div>
  );
}
