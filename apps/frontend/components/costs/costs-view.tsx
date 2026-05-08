"use client";

import Link from "next/link";
import { useState, useEffect, useTransition, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { DataTable } from "@/components/shared/data-table";
import { EmptyState } from "@/components/shared/empty-state";
import { PageHeader } from "@/components/shared/page-header";
import { Panel } from "@/components/shared/panel";
import { SourceBanner } from "@/components/shared/source-banner";
import { readApiResponse } from "@/lib/api/browser";
import type { CostSnapshotListItem, CostsPageData } from "@/lib/api/types";
import { formatDate, formatDateTime, formatNumber } from "@/lib/format";

function Toast({ message, duration = 5000 }: { message: string; duration?: number }) {
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    const timer = setTimeout(() => setVisible(false), duration);
    return () => clearTimeout(timer);
  }, [duration]);

  if (!visible) return null;

  return (
    <div className="fixed bottom-4 right-4 z-50 rounded-2xl bg-amber-100 px-4 py-3 text-sm text-amber-900 border border-amber-200">
      {message}
    </div>
  );
}

export function CostsView({ data }: { data: CostsPageData }) {
  const router = useRouter();
  const [effectiveFrom, setEffectiveFrom] = useState("");
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [mismatchToast, setMismatchToast] = useState<boolean>(false);
  const [isUploading, setIsUploading] = useState(false);
  const [isRefreshing, startRefresh] = useTransition();

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

  const isBusy = isUploading || isRefreshing;

  const startRefreshMessage = (message: string) => {
    setSuccessMessage(message);
    startRefresh(() => {
      router.refresh();
    });
  };

  const handleDownload = () => {
    window.location.href = `/api/sales-unit-cost-snapshots/export?storeId=${data.primaryStore!.id}`;
  };

  const handleUploadSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setMismatchToast(false);
    setErrorMessage(null);
    setSuccessMessage(null);

    if (!effectiveFrom.trim() || !selectedFile) {
      setErrorMessage("시작일과 .xlsx 파일을 모두 선택해 주세요.");
      return;
    }

    setIsUploading(true);
    try {
      const formData = new FormData();
      formData.append("storeId", data.primaryStore!.id);
      formData.append("effectiveFrom", effectiveFrom);
      formData.append("file", selectedFile);

      const response = await fetch("/api/sales-unit-cost-snapshots/import", {
        method: "POST",
        body: formData,
      });

      const payload = await response.json();
      if (!response.ok) {
        setErrorMessage(payload?.message ?? "업로드 실패");
        return;
      }

      const { mismatch, replacedSnapshot } = payload.data;

      let message = `${effectiveFrom} 시점 비용 표가 적용되었습니다.`;
      if (replacedSnapshot) {
        message += ` (같은 시점의 기존 스냅샷을 덮어썼습니다.)`;
      }
      setSuccessMessage(message);

      if (mismatch?.salesUnitCount !== mismatch?.entryCount) {
        setMismatchToast(true);  // 5초 후 자동 사라짐 (Toast 컴포넌트 내부에서 처리)
      }

      setSelectedFile(null);
      setEffectiveFrom("");
      startRefreshMessage("");
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "업로드 실패");
    } finally {
      setIsUploading(false);
    }
  };

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
            <Link className="button-shell button-secondary" href="/sales-units">
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

      <Panel title="비용 표 업로드">
        <form className="space-y-4" onSubmit={handleUploadSubmit}>
          <div>
            <label className="block">
              <span className="mb-2 block text-sm font-medium text-ink">시작일 (effectiveFrom)</span>
              <input
                className="input-shell"
                type="date"
                value={effectiveFrom}
                onChange={(e) => setEffectiveFrom(e.target.value)}
                disabled={isBusy}
              />
            </label>
          </div>

          <div>
            <label className="block">
              <span className="mb-2 block text-sm font-medium text-ink">엑셀 파일 선택</span>
              <input
                className="input-shell"
                type="file"
                accept=".xlsx"
                onChange={(e) => setSelectedFile(e.target.files?.[0] ?? null)}
                disabled={isBusy}
              />
            </label>
          </div>

          {errorMessage ? (
            <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
              {errorMessage}
            </div>
          ) : null}

          {successMessage ? (
            <div className="rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
              {successMessage}
            </div>
          ) : null}

          {mismatchToast && (
            <Toast message="판매단위와 비용 항목의 갯수가 맞지 않습니다." duration={5000} />
          )}

          <button
            className="button-shell button-primary"
            type="submit"
            disabled={isBusy}
          >
            업로드
          </button>
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
