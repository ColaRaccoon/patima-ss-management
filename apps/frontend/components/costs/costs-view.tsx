"use client";

import Link from "next/link";
import { useRef, useState, useTransition, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import type { CostSnapshotPreview } from "@patima/shared";
import { DataTable } from "@/components/shared/data-table";
import { EmptyState } from "@/components/shared/empty-state";
import { PageHeader } from "@/components/shared/page-header";
import { Panel } from "@/components/shared/panel";
import { SourceBanner } from "@/components/shared/source-banner";
import { readApiResponse } from "@/lib/api/browser";
import type { CostSnapshotListItem, CostsPageData } from "@/lib/api/types";
import { formatDate, formatDateTime, formatNumber, formatPercent } from "@/lib/format";
import { buildHrefWithStore } from "@/lib/store-selection";

function describeCost(cost: CostSnapshotPreview["created"][number]["cost"]) {
  return cost
    ? `원가 ${formatNumber(cost.unitCost)}원 · 기타비용 ${formatNumber(cost.otherCost)}원 · 수수료율 ${cost.feeRate === null ? "미입력" : formatPercent(cost.feeRate)}`
    : "원가 미설정";
}

function CostPreviewDetails({ preview }: { preview: CostSnapshotPreview }) {
  return (
    <section aria-labelledby="cost-preview-heading" className="space-y-3 rounded-2xl border border-ink/10 bg-sand/40 p-4">
      <div>
        <h3 id="cost-preview-heading" className="font-semibold text-ink">적용할 변경 내용</h3>
        <p className="mt-1 break-words text-sm text-ink/65">
          {formatDate(preview.effectiveFrom)} 기준 · {preview.fileName}
        </p>
        {preview.nextSnapshotDate && (
          <p className="mt-1 text-sm text-ink/65">다음 전체 비용 표 적용일은 {formatDate(preview.nextSnapshotDate)}입니다.</p>
        )}
      </div>
      {preview.replaces && (
        <p className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2.5 text-sm text-amber-900">
          같은 적용일의 기존 비용 표를 교체합니다.
          {preview.replaces.sourceFileName ? ` ${preview.replaces.sourceFileName} ·` : ""}
          {" "}{formatDateTime(preview.replaces.createdAt)} 업로드
        </p>
      )}
      <details className="rounded-xl border border-ink/10 bg-white px-3 py-2.5" open={preview.created.length > 0}>
        <summary className="cursor-pointer font-medium text-ink">새 판매단위 {formatNumber(preview.created.length)}개</summary>
        {preview.created.length === 0 ? (
          <p className="mt-2 text-sm text-ink/60">추가할 판매단위가 없습니다.</p>
        ) : (
          <ul className="mt-2 max-h-60 divide-y divide-ink/10 overflow-auto text-sm">
            {preview.created.map((item) => (
              <li key={item.row} className="py-2">
                <p className="font-medium text-ink">{item.displayName} <span className="font-normal text-ink/60">{item.row}행</span></p>
                <p className="text-ink/70">{describeCost(item.cost)}</p>
              </li>
            ))}
          </ul>
        )}
      </details>
      <details className="rounded-xl border border-ink/10 bg-white px-3 py-2.5" open={preview.changed.length > 0}>
        <summary className="cursor-pointer font-medium text-ink">기존 판매단위 변경 {formatNumber(preview.changed.length)}개</summary>
        {preview.changed.length === 0 ? (
          <p className="mt-2 text-sm text-ink/60">바뀌는 판매단위가 없습니다.</p>
        ) : (
          <ul className="mt-2 max-h-60 divide-y divide-ink/10 overflow-auto text-sm">
            {preview.changed.map((item) => (
              <li key={item.id} className="py-2">
                <p className="font-medium text-ink">
                  {item.previousName === item.displayName ? item.displayName : `${item.previousName} → ${item.displayName}`}
                  {item.metadataChanged && <span className="ml-2 font-normal text-ink/60">판매단위 정보 변경</span>}
                </p>
                <p className="text-ink/70">현재 {describeCost(item.previousCost)}</p>
                <p className="text-ink/70">적용 후 {describeCost(item.nextCost)}</p>
              </li>
            ))}
          </ul>
        )}
      </details>
      <details className="rounded-xl border border-ink/10 bg-white px-3 py-2.5" open={preview.missing.length > 0}>
        <summary className="cursor-pointer font-medium text-ink">비용 표에서 누락된 기존 판매단위 {formatNumber(preview.missing.length)}개</summary>
        {preview.missing.length === 0 ? (
          <p className="mt-2 text-sm text-ink/60">비용이 빠진 활성 판매단위가 없습니다.</p>
        ) : (
          <ul className="mt-2 max-h-60 divide-y divide-ink/10 overflow-auto text-sm">
            {preview.missing.map((item) => (
              <li key={item.id} className="py-2">
                <p className="font-medium text-ink">{item.displayName}</p>
                <p className="text-ink/70">
                  {item.reason === "OMITTED" ? "엑셀에서 행 누락" : "엑셀에서 원가 미입력"}
                  {item.losesCurrentCost && <span className="ml-2 font-medium text-amber-800">적용 후 원가 미설정</span>}
                </p>
              </li>
            ))}
          </ul>
        )}
      </details>
    </section>
  );
}

export function CostsView({ data }: { data: CostsPageData }) {
  return <StoreCostsView key={data.primaryStore?.id} data={data} />;
}

function StoreCostsView({ data }: { data: CostsPageData }) {
  const router = useRouter();
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [preview, setPreview] = useState<CostSnapshotPreview | null>(null);
  const [pendingAction, setPendingAction] = useState<"preview" | "import" | null>(null);
  const [isRefreshing, startRefresh] = useTransition();
  const uploadForm = useRef<HTMLFormElement>(null);

  if (!data.primaryStore) {
    return (
      <EmptyState
        title="비용 설정은 스토어가 있어야 시작할 수 있습니다."
        description="대표 스토어가 정해져야 비용 스냅샷을 안전하게 관리할 수 있습니다."
        actionHref="/settings/stores"
        actionLabel="스토어 설정"
      />
    );
  }

  const storeId = data.primaryStore.id;
  const isBusy = pendingAction !== null || isRefreshing;
  const salesUnitsHref = buildHrefWithStore(
    "/sales-units",
    null,
    storeId,
  );

  const startRefreshMessage = (message: string) => {
    setSuccessMessage(message);
    startRefresh(() => {
      router.refresh();
    });
  };

  const handleDownload = () => {
    window.location.href = `/api/sales-unit-cost-snapshots/export?storeId=${storeId}`;
  };

  async function uploadCosts(action: "preview" | "import") {
    const form = uploadForm.current;
    if (!form || isBusy || (action === "import" && !preview)) return;
    setErrorMessage(null);
    setSuccessMessage(null);
    const formData = new FormData(form);
    const effectiveFrom = formData.get("effectiveFrom");
    const selectedFile = formData.get("file");
    if (typeof effectiveFrom !== "string" || !effectiveFrom || !(selectedFile instanceof File) || !selectedFile.size) {
      setErrorMessage("시작일과 .xlsx 파일을 모두 선택해 주세요.");
      return;
    }

    setPendingAction(action);
    try {
      formData.append("storeId", storeId);
      if (action === "import" && preview) formData.append("previewToken", preview.token);

      const response = await fetch(`/api/sales-unit-cost-snapshots/${action}`, {
        method: "POST",
        body: formData,
      });
      if (response.status === 409) setPreview(null);

      if (action === "preview") {
        setPreview(await readApiResponse<CostSnapshotPreview>(response, "비용 표를 확인하지 못했습니다."));
        return;
      }

      const { replacedSnapshot } = await readApiResponse<{ replacedSnapshot: unknown }>(response, "비용 표 적용에 실패했습니다.");
      const message = `${formatDate(effectiveFrom)} 비용 표를 ${replacedSnapshot ? "교체했습니다" : "적용했습니다"}.`;
      setPreview(null);
      form.reset();
      startRefreshMessage(message);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "비용 표를 처리하지 못했습니다.");
    } finally {
      setPendingAction(null);
    }
  }

  function handlePreview(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void uploadCosts("preview");
  }

  const handleDelete = async (snapshotId: string, effectiveFromLabel: string) => {
    if (!confirm(`${effectiveFromLabel} 스냅샷을 정말 삭제하시겠습니까?`)) {
      return;
    }

    try {
      const response = await fetch(`/api/sales-unit-cost-snapshots/${snapshotId}`, {
        method: "DELETE",
      });

      const payload = await response.json();
      if (!response.ok) {
        setErrorMessage(payload?.message ?? "삭제 실패");
        return;
      }

      setPreview(null);
      startRefreshMessage(`${effectiveFromLabel} 스냅샷이 삭제되었습니다.`);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "삭제 실패");
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Costs"
        title="비용 표 관리"
        description="판매단위와 비용을 통합 엑셀로 관리합니다."
        actions={
          <>
            <Link className="button-shell button-secondary" href={salesUnitsHref}>
              판매단위 보기
            </Link>
          </>
        }
      />

      <SourceBanner sources={data.sources} />

      <Panel title="현재 비용 표 다운로드">
        <div className="space-y-4">
          <p className="text-sm text-ink/65">현재 적용 중인 비용 표를 엑셀 파일로 다운로드할 수 있습니다.</p>
          <button
            className="button-shell button-primary"
            type="button"
            disabled={isBusy}
            onClick={handleDownload}
          >
            현재 적용 중인 표 .xlsx 로 다운로드
          </button>
        </div>
      </Panel>

      <Panel title="비용 표 업로드" description={`${data.primaryStore.name}에 적용하기 전에 신규·변경·누락 항목을 확인합니다.`}>
        <form ref={uploadForm} className="space-y-4" onSubmit={handlePreview} onChange={() => setPreview(null)}>
          <div>
            <label className="block">
              <span className="mb-2 block text-sm font-medium text-ink">적용 시작일</span>
              <input
                className="input-shell"
                name="effectiveFrom"
                type="date"
                disabled={isBusy}
              />
            </label>
          </div>

          <div>
            <label className="block">
              <span className="mb-2 block text-sm font-medium text-ink">엑셀 파일 선택</span>
              <input
                className="input-shell"
                name="file"
                type="file"
                accept=".xlsx"
                disabled={isBusy}
              />
            </label>
          </div>

          {errorMessage ? (
            <div role="alert" className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
              {errorMessage}
            </div>
          ) : null}

          {successMessage ? (
            <div role="status" className="rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
              {successMessage}
            </div>
          ) : null}

          {preview ? (
            <>
              <CostPreviewDetails preview={preview} />
              <button
                className="button-shell button-primary"
                type="button"
                disabled={isBusy}
                onClick={() => void uploadCosts("import")}
              >
                {pendingAction === "import" ? "적용 중…" : preview.replaces ? "기존 비용 표 덮어쓰기" : "이 비용 표 적용"}
              </button>
            </>
          ) : (
            <button className="button-shell button-primary" type="submit" disabled={isBusy}>
              {pendingAction === "preview" ? "확인 중…" : "변경 내용 확인"}
            </button>
          )}
        </form>
      </Panel>

      <Panel
        title="스냅샷 이력"
        description="업로드된 비용 표의 이력을 확인하고 관리할 수 있습니다."
      >
        {data.costSnapshots.length === 0 ? (
          <div className="text-center text-sm text-ink/55">아직 업로드된 스냅샷이 없습니다.</div>
        ) : (
          <DataTable
            caption="비용 스냅샷 이력"
            columns={[
              {
                key: "effectiveFrom",
                title: "적용 시작일",
                render: (row: CostSnapshotListItem) => formatDate(row.effectiveFrom),
              },
              {
                key: "entryCount",
                title: "엔트리 수",
                render: (row: CostSnapshotListItem) => formatNumber(row.entryCount),
              },
              {
                key: "missing",
                title: "누락 판매단위",
                render: (row: CostSnapshotListItem) =>
                  row.missingSalesUnitCount > 0 ? `${row.missingSalesUnitCount}개` : "-",
              },
              {
                key: "createdAt",
                title: "업로드 시각",
                render: (row: CostSnapshotListItem) => formatDateTime(row.createdAt),
              },
              {
                key: "fileName",
                title: "파일명",
                render: (row: CostSnapshotListItem) => row.sourceFileName || "-",
              },
              {
                key: "actions",
                title: "관리",
                render: (row: CostSnapshotListItem) => (
                  <button
                    className="button-shell button-ghost text-sm"
                    type="button"
                    disabled={isBusy}
                    onClick={() => handleDelete(row.id, row.effectiveFrom)}
                  >
                    삭제
                  </button>
                ),
              },
            ]}
            rows={data.costSnapshots}
            getRowKey={(row) => row.id}
          />
        )}
      </Panel>
    </div>
  );
}
