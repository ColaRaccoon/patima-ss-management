"use client";

import { useEffect, useState } from "react";
import { readApiResponse } from "@/lib/api/browser";
import type { DailySalesUnitDetail, DailySalesUnitProfit, ProfitsPageData } from "@/lib/api/types";

const profitKey = (row: Pick<DailySalesUnitProfit, "canonicalSalesUnitId" | "date">) =>
  `${row.canonicalSalesUnitId}-${row.date}`;

interface DetailState {
  row: DailySalesUnitProfit;
  storeId: string;
  detail: DailySalesUnitDetail | null;
  error: string | null;
  loading: boolean;
}

export function useProfitDetail(data: ProfitsPageData) {
  const [requestedKey, setRequestedKey] = useState<string | null>(null);
  const [requestVersion, setRequestVersion] = useState(0);
  const [state, setState] = useState<DetailState | null>(null);
  const rows = data.profits.filter((row) => !row.parentSalesUnitId);
  const selectedRow = rows.find((row) => profitKey(row) === requestedKey)
    ?? rows.find((row) => data.selectedDetail && profitKey(row) === profitKey(data.selectedDetail))
    ?? rows[0]
    ?? null;
  const storeId = data.primaryStore?.id;
  const serverDetail = selectedRow && data.selectedDetail && profitKey(selectedRow) === profitKey(data.selectedDetail)
    ? data.selectedDetail
    : null;

  useEffect(() => {
    if (!selectedRow || !storeId || serverDetail) return;

    const controller = new AbortController();
    let current = true;
    const timeout = setTimeout(() => controller.abort(), 30_000);
    const base = { row: selectedRow, storeId };
    setState({ ...base, detail: null, error: null, loading: true });

    const load = async () => {
      try {
        const query = new URLSearchParams({ storeId, date: selectedRow.date });
        const detail = await readApiResponse<DailySalesUnitDetail>(
          await fetch(`/api/profits/daily-sales-units/${encodeURIComponent(selectedRow.canonicalSalesUnitId)}?${query}`, {
            cache: "no-store",
            signal: controller.signal,
          }),
          "손익 상세를 불러오지 못했습니다.",
        );
        if (detail.canonicalSalesUnitId !== selectedRow.canonicalSalesUnitId || detail.date !== selectedRow.date) {
          throw new Error("선택한 손익과 상세 응답이 일치하지 않습니다. 다시 시도해 주세요.");
        }
        if (current) setState({ ...base, detail, error: null, loading: false });
      } catch (error) {
        if (current) {
          setState({
            ...base,
            detail: null,
            error: controller.signal.aborted
              ? "상세 조회 시간이 초과되었습니다. 다시 시도해 주세요."
              : error instanceof Error ? error.message : "손익 상세를 불러오지 못했습니다.",
            loading: false,
          });
        }
      } finally {
        clearTimeout(timeout);
      }
    };
    void load();

    return () => {
      current = false;
      clearTimeout(timeout);
      controller.abort();
    };
  }, [selectedRow, storeId, serverDetail, requestVersion]);

  // Tag results with the actual row object so refreshes cannot display an old calculation.
  const currentState = state?.row === selectedRow && state?.storeId === storeId ? state : null;
  return {
    selectedProfitKey: selectedRow ? profitKey(selectedRow) : null,
    selectedDetail: serverDetail ?? currentState?.detail ?? null,
    detailError: serverDetail ? null : currentState?.error ?? null,
    isLoadingDetail: Boolean(selectedRow && storeId && !serverDetail && (!currentState || currentState.loading)),
    selectProfit: (row: DailySalesUnitProfit) => setRequestedKey(profitKey(row)),
    retryDetail: () => setRequestVersion((value) => value + 1),
  };
}
