"use client";

import Link from "next/link";
import { useEffect, useMemo, useState, useTransition, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { DataTable } from "@/components/shared/data-table";
import { EmptyState } from "@/components/shared/empty-state";
import { PageHeader } from "@/components/shared/page-header";
import { Panel } from "@/components/shared/panel";
import { SourceBanner } from "@/components/shared/source-banner";
import { StatusBadge } from "@/components/shared/status-badge";
import { DEFAULT_DELIVERY_UNIT_COST } from "@patima/shared";
import { readApiResponse } from "@/lib/api/browser";
import type {
  CredentialSummary,
  CredentialTestResult,
  StoreListItem,
  StoreSettingsPageData,
} from "@/lib/api/types";
import { formatDateTime, formatNullableText } from "@/lib/format";
import { toneForActive } from "@/lib/status-tone";

function createStoreDraft(store?: StoreListItem | null) {
  return {
    name: store?.name ?? "",
    sellerAccountId: store?.sellerAccountId ?? "",
    channelNo: store?.channelNo ?? "",
    memo: store?.memo ?? "",
    deliveryUnitCost: store?.deliveryUnitCost ?? DEFAULT_DELIVERY_UNIT_COST,
  };
}

export function StoreSettingsView({ data }: { data: StoreSettingsPageData }) {
  const router = useRouter();
  const [selectedStoreId, setSelectedStoreId] = useState<string | null>(
    data.primaryStore?.id ?? data.stores[0]?.id ?? null,
  );
  const [storeDraft, setStoreDraft] = useState(createStoreDraft(data.primaryStore));
  const [credentialSummary, setCredentialSummary] = useState<CredentialSummary | null>(
    data.credential,
  );
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [testResult, setTestResult] = useState<CredentialTestResult | null>(null);
  const [storeError, setStoreError] = useState<string | null>(null);
  const [storeSuccess, setStoreSuccess] = useState<string | null>(null);
  const [credentialError, setCredentialError] = useState<string | null>(null);
  const [credentialSuccess, setCredentialSuccess] = useState<string | null>(null);
  const [isSavingStore, setIsSavingStore] = useState(false);
  const [isSavingCredential, setIsSavingCredential] = useState(false);
  const [isTestingCredential, setIsTestingCredential] = useState(false);
  const [isLoadingCredential, setIsLoadingCredential] = useState(false);
  const [isRefreshing, startRefresh] = useTransition();

  const selectedStore = useMemo(
    () => data.stores.find((store) => store.id === selectedStoreId) ?? null,
    [data.stores, selectedStoreId],
  );

  useEffect(() => {
    if (selectedStoreId && data.stores.some((store) => store.id === selectedStoreId)) {
      return;
    }
    setSelectedStoreId(data.primaryStore?.id ?? data.stores[0]?.id ?? null);
  }, [data.primaryStore, data.stores, selectedStoreId]);

  useEffect(() => {
    setStoreDraft(createStoreDraft(selectedStore));
    setStoreError(null);
    setStoreSuccess(null);
    setCredentialError(null);
    setCredentialSuccess(null);
    setClientSecret("");
    setTestResult(null);
  }, [selectedStore]);

  useEffect(() => {
    async function loadCredentials(storeId: string) {
      setIsLoadingCredential(true);
      try {
        const credential = await readApiResponse<CredentialSummary>(
          await fetch(`/api/stores/${storeId}/commerce-credentials`, {
            cache: "no-store",
          }),
          "인증 정보 조회에 실패했습니다.",
        );
        setCredentialSummary(credential);
        setClientId("");
      } catch (error) {
        setCredentialSummary(null);
        setClientId("");
        setCredentialError(
          error instanceof Error ? error.message : "인증 정보 조회 중 오류가 발생했습니다.",
        );
      } finally {
        setIsLoadingCredential(false);
      }
    }

    if (!selectedStore) {
      setCredentialSummary(null);
      setClientId("");
      return;
    }

    if (selectedStore.id === data.primaryStore?.id && data.credential) {
      setCredentialSummary(data.credential);
      setClientId("");
      return;
    }

    void loadCredentials(selectedStore.id);
  }, [data.credential, data.primaryStore?.id, selectedStore]);

  if (data.stores.length === 0) {
    return (
      <div className="space-y-6">
        <PageHeader
          eyebrow="Settings"
          title="대표 스토어 초기 설정"
          description="첫 스토어를 생성하면 이후 주문, 광고 업로드, 매핑, 비용 관리 화면이 함께 활성화됩니다."
        />
        <SourceBanner sources={data.sources} />
        <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
          <Panel
            title="초기 설정"
            description="백엔드와 바로 연결되는 첫 스토어 입력 폼입니다."
          >
            <form
              className="grid gap-4 sm:grid-cols-2"
              onSubmit={async (event: FormEvent<HTMLFormElement>) => {
                event.preventDefault();
                setStoreError(null);
                setStoreSuccess(null);

                if (
                  !storeDraft.name.trim() ||
                  !storeDraft.sellerAccountId.trim() ||
                  !storeDraft.channelNo.trim()
                ) {
                  setStoreError("스토어명, sellerAccountId, channelNo는 모두 필수입니다.");
                  return;
                }

                setIsSavingStore(true);
                try {
                  await readApiResponse(
                    await fetch("/api/stores", {
                      method: "POST",
                      headers: {
                        "Content-Type": "application/json",
                      },
                      body: JSON.stringify({
                        name: storeDraft.name.trim(),
                        sellerAccountId: storeDraft.sellerAccountId.trim(),
                        channelNo: storeDraft.channelNo.trim(),
                        memo: storeDraft.memo.trim() || null,
                        platformType: "NAVER_SMARTSTORE",
                      }),
                    }),
                    "대표 스토어 생성에 실패했습니다.",
                  );

                  setStoreSuccess("대표 스토어를 생성했습니다.");
                  startRefresh(() => {
                    router.refresh();
                  });
                } catch (error) {
                  setStoreError(
                    error instanceof Error ? error.message : "스토어 생성 중 오류가 발생했습니다.",
                  );
                } finally {
                  setIsSavingStore(false);
                }
              }}
            >
              <label className="block sm:col-span-2">
                <span className="mb-2 block text-sm font-medium text-ink">스토어명</span>
                <input
                  className="input-shell"
                  placeholder="메인 스마트스토어"
                  value={storeDraft.name}
                  onChange={(event) =>
                    setStoreDraft((current) => ({ ...current, name: event.target.value }))
                  }
                />
              </label>
              <label className="block">
                <span className="mb-2 block text-sm font-medium text-ink">sellerAccountId</span>
                <input
                  className="input-shell"
                  placeholder="123456"
                  value={storeDraft.sellerAccountId}
                  onChange={(event) =>
                    setStoreDraft((current) => ({
                      ...current,
                      sellerAccountId: event.target.value,
                    }))
                  }
                />
              </label>
              <label className="block">
                <span className="mb-2 block text-sm font-medium text-ink">channelNo</span>
                <input
                  className="input-shell"
                  placeholder="999999"
                  value={storeDraft.channelNo}
                  onChange={(event) =>
                    setStoreDraft((current) => ({ ...current, channelNo: event.target.value }))
                  }
                />
              </label>
              <label className="block sm:col-span-2">
                <span className="mb-2 block text-sm font-medium text-ink">메모</span>
                <textarea
                  className="input-shell min-h-28"
                  placeholder="스토어 운영 메모"
                  value={storeDraft.memo}
                  onChange={(event) =>
                    setStoreDraft((current) => ({ ...current, memo: event.target.value }))
                  }
                />
              </label>

              {storeError ? (
                <div className="sm:col-span-2 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                  {storeError}
                </div>
              ) : null}

              {storeSuccess ? (
                <div className="sm:col-span-2 rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
                  {storeSuccess}
                </div>
              ) : null}

              <div className="sm:col-span-2 flex flex-wrap gap-3">
                <button
                  className="button-shell button-primary"
                  type="submit"
                  disabled={isSavingStore}
                >
                  대표 스토어 생성
                </button>
              </div>
            </form>
          </Panel>

          <EmptyState
            title="스토어가 생성되면 나머지 화면이 열립니다."
            description="주문 수집, 광고 업로드, 매핑, 비용 입력은 모두 스토어가 준비된 뒤에 연결됩니다."
          />
        </div>
      </div>
    );
  }

  const isBusy =
    isSavingStore ||
    isSavingCredential ||
    isTestingCredential ||
    isLoadingCredential ||
    isRefreshing;

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Settings"
        title="스토어 및 인증 설정"
        description="스토어 기본 정보, 대표 스토어 상태, 커머스 API 인증 정보를 한 곳에서 관리합니다."
        actions={
          <>
            <Link className="button-shell button-secondary" href="/orders">
              주문 화면으로 이동
            </Link>
            <Link className="button-shell button-primary" href="/operations">
              작업 이력 보기
            </Link>
          </>
        }
      />

      <SourceBanner sources={data.sources} />

      <Panel
        title="스토어 목록"
        description="선택한 스토어를 수정하거나 대표 스토어로 지정할 수 있습니다."
      >
        <DataTable
          caption="스토어 목록"
          columns={[
            {
              key: "select",
              title: "선택",
              render: (row) => (
                <button
                  className="button-shell button-ghost"
                  type="button"
                  onClick={() => setSelectedStoreId(row.id)}
                >
                  {row.id === selectedStoreId ? "선택됨" : "선택"}
                </button>
              ),
            },
            {
              key: "name",
              title: "스토어",
              render: (row) => (
                <div>
                  <p className="font-semibold text-ink">{row.name}</p>
                  <p className="mt-1 text-xs text-ink/55">
                    {row.sellerAccountId} / {row.channelNo}
                  </p>
                </div>
              ),
            },
            {
              key: "primary",
              title: "대표",
              render: (row) => (
                <StatusBadge tone={row.isPrimary ? "success" : "muted"}>
                  {row.isPrimary ? "PRIMARY" : "SECONDARY"}
                </StatusBadge>
              ),
            },
            {
              key: "status",
              title: "상태",
              render: (row) => (
                <StatusBadge tone={toneForActive(row.isActive)}>
                  {row.isActive ? "ACTIVE" : "INACTIVE"}
                </StatusBadge>
              ),
            },
            {
              key: "sync",
              title: "최근 동기화",
              render: (row) => formatDateTime(row.lastOrderSyncAt),
            },
          ]}
          rows={data.stores}
          getRowKey={(row) => row.id}
        />
      </Panel>

      {selectedStore ? (
        <div className="grid gap-6 xl:grid-cols-[minmax(0,1.05fr)_minmax(320px,0.95fr)]">
          <Panel
            title="선택한 스토어 정보"
            description="스토어 기본 정보와 대표 스토어 상태를 관리합니다."
            aside={
              <StatusBadge tone={toneForActive(selectedStore.isActive)}>
                {selectedStore.isActive ? "ACTIVE" : "INACTIVE"}
              </StatusBadge>
            }
          >
            <form
              className="space-y-4"
              onSubmit={async (event: FormEvent<HTMLFormElement>) => {
                event.preventDefault();
                setStoreError(null);
                setStoreSuccess(null);

                if (
                  !storeDraft.name.trim() ||
                  !storeDraft.sellerAccountId.trim() ||
                  !storeDraft.channelNo.trim()
                ) {
                  setStoreError("스토어명, sellerAccountId, channelNo는 모두 필수입니다.");
                  return;
                }

                setIsSavingStore(true);
                try {
                  await readApiResponse(
                    await fetch(`/api/stores/${selectedStore.id}`, {
                      method: "PATCH",
                      headers: {
                        "Content-Type": "application/json",
                      },
                      body: JSON.stringify({
                        name: storeDraft.name.trim(),
                        sellerAccountId: storeDraft.sellerAccountId.trim(),
                        channelNo: storeDraft.channelNo.trim(),
                        memo: storeDraft.memo.trim() || null,
                        deliveryUnitCost: storeDraft.deliveryUnitCost,
                      }),
                    }),
                    "스토어 정보 저장에 실패했습니다.",
                  );

                  setStoreSuccess("스토어 정보를 저장했습니다.");
                  startRefresh(() => {
                    router.refresh();
                  });
                } catch (error) {
                  setStoreError(
                    error instanceof Error ? error.message : "스토어 저장 중 오류가 발생했습니다.",
                  );
                } finally {
                  setIsSavingStore(false);
                }
              }}
            >
              <div className="grid gap-4 sm:grid-cols-2">
                <label className="block sm:col-span-2">
                  <span className="mb-2 block text-sm font-medium text-ink">스토어명</span>
                  <input
                    className="input-shell"
                    value={storeDraft.name}
                    onChange={(event) =>
                      setStoreDraft((current) => ({ ...current, name: event.target.value }))
                    }
                  />
                </label>
                <label className="block">
                  <span className="mb-2 block text-sm font-medium text-ink">sellerAccountId</span>
                  <input
                    className="input-shell"
                    value={storeDraft.sellerAccountId}
                    onChange={(event) =>
                      setStoreDraft((current) => ({
                        ...current,
                        sellerAccountId: event.target.value,
                      }))
                    }
                  />
                </label>
                <label className="block">
                  <span className="mb-2 block text-sm font-medium text-ink">channelNo</span>
                  <input
                    className="input-shell"
                    value={storeDraft.channelNo}
                    onChange={(event) =>
                      setStoreDraft((current) => ({ ...current, channelNo: event.target.value }))
                    }
                  />
                </label>
                <label className="block sm:col-span-2">
                  <span className="mb-2 block text-sm font-medium text-ink">메모</span>
                  <textarea
                    className="input-shell min-h-28"
                    value={storeDraft.memo}
                    onChange={(event) =>
                      setStoreDraft((current) => ({ ...current, memo: event.target.value }))
                    }
                  />
                </label>
                <label className="block">
                  <span className="mb-2 block text-sm font-medium text-ink">배송 단가(원)</span>
                  <input
                    className="input-shell"
                    type="number"
                    min="0"
                    step="100"
                    placeholder={String(DEFAULT_DELIVERY_UNIT_COST)}
                    value={storeDraft.deliveryUnitCost}
                    onChange={(event) =>
                      setStoreDraft((current) => ({
                        ...current,
                        deliveryUnitCost: parseInt(event.target.value, 10) || DEFAULT_DELIVERY_UNIT_COST,
                      }))
                    }
                  />
                  <p className="mt-1 text-xs text-ink/55">
                    배송 단가를 설정하면 대시보드의 배송 마진이 자동으로 계산됩니다.
                  </p>
                </label>
              </div>

              {storeError ? (
                <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                  {storeError}
                </div>
              ) : null}

              {storeSuccess ? (
                <div className="rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
                  {storeSuccess}
                </div>
              ) : null}

              <div className="flex flex-wrap gap-3">
                <button
                  className="button-shell button-primary"
                  type="submit"
                  disabled={isBusy || !selectedStore.isActive}
                >
                  스토어 정보 저장
                </button>
                <button
                  className="button-shell button-secondary"
                  type="button"
                  disabled={isBusy || selectedStore.isPrimary}
                  onClick={async () => {
                    setStoreError(null);
                    setStoreSuccess(null);
                    setIsSavingStore(true);
                    try {
                      await readApiResponse(
                        await fetch(`/api/stores/${selectedStore.id}/set-primary`, {
                          method: "POST",
                        }),
                        "대표 스토어 지정에 실패했습니다.",
                      );
                      setStoreSuccess("대표 스토어로 지정했습니다.");
                      startRefresh(() => {
                        router.refresh();
                      });
                    } catch (error) {
                      setStoreError(
                        error instanceof Error
                          ? error.message
                          : "대표 스토어 지정 중 오류가 발생했습니다.",
                      );
                    } finally {
                      setIsSavingStore(false);
                    }
                  }}
                >
                  {selectedStore.isPrimary ? "대표 스토어" : "대표 스토어로 설정"}
                </button>
                <button
                  className="button-shell button-ghost"
                  type="button"
                  disabled={isBusy}
                  onClick={async () => {
                    setStoreError(null);
                    setStoreSuccess(null);
                    setIsSavingStore(true);
                    try {
                      await readApiResponse(
                        await fetch(
                          `/api/stores/${selectedStore.id}/${selectedStore.isActive ? "deactivate" : "activate"}`,
                          {
                            method: "POST",
                          },
                        ),
                        selectedStore.isActive
                          ? "스토어 비활성화에 실패했습니다."
                          : "스토어 활성화에 실패했습니다.",
                      );
                      setStoreSuccess(
                        selectedStore.isActive
                          ? "스토어를 비활성화했습니다."
                          : "스토어를 다시 활성화했습니다.",
                      );
                      startRefresh(() => {
                        router.refresh();
                      });
                    } catch (error) {
                      setStoreError(
                        error instanceof Error
                          ? error.message
                          : "스토어 상태 변경 중 오류가 발생했습니다.",
                      );
                    } finally {
                      setIsSavingStore(false);
                    }
                  }}
                >
                  {selectedStore.isActive ? "비활성화" : "재활성화"}
                </button>
              </div>
            </form>
          </Panel>

          <div className="space-y-6">
            <Panel
              title="커머스 API 인증"
              description="clientSecret은 다시 표시되지 않으므로 저장 시 새 값으로 입력합니다."
            >
              <form
                className="space-y-4"
                onSubmit={async (event: FormEvent<HTMLFormElement>) => {
                  event.preventDefault();
                  setCredentialError(null);
                  setCredentialSuccess(null);

                  if (!selectedStore) {
                    return;
                  }
                  if (!clientId.trim() || !clientSecret.trim()) {
                    setCredentialError("clientId와 clientSecret은 모두 필수입니다.");
                    return;
                  }

                  setIsSavingCredential(true);
                  try {
                    const credential = await readApiResponse<CredentialSummary>(
                      await fetch(`/api/stores/${selectedStore.id}/commerce-credentials`, {
                        method: "POST",
                        headers: {
                          "Content-Type": "application/json",
                        },
                        body: JSON.stringify({
                          clientId: clientId.trim(),
                          clientSecret: clientSecret.trim(),
                          accessType: "SELLER",
                        }),
                      }),
                      "인증 정보 저장에 실패했습니다.",
                    );

                    setCredentialSummary(credential);
                    setClientId("");
                    setClientSecret("");
                    setCredentialSuccess("인증 정보를 저장했습니다.");
                    startRefresh(() => {
                      router.refresh();
                    });
                  } catch (error) {
                    setCredentialError(
                      error instanceof Error
                        ? error.message
                        : "인증 정보 저장 중 오류가 발생했습니다.",
                    );
                  } finally {
                    setIsSavingCredential(false);
                  }
                }}
              >
                <label className="block">
                  <span className="mb-2 block text-sm font-medium text-ink">clientId</span>
                  <input
                    className="input-shell"
                    placeholder="새 clientId 입력"
                    value={clientId}
                    onChange={(event) => setClientId(event.target.value)}
                  />
                  <p className="mt-2 text-xs text-ink/55">
                    현재 저장값 {formatNullableText(credentialSummary?.maskedClientId)}
                  </p>
                </label>
                <label className="block">
                  <span className="mb-2 block text-sm font-medium text-ink">clientSecret</span>
                  <input
                    className="input-shell"
                    type="password"
                    placeholder="새 secret 입력"
                    value={clientSecret}
                    onChange={(event) => setClientSecret(event.target.value)}
                  />
                </label>

                {credentialError ? (
                  <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                    {credentialError}
                  </div>
                ) : null}

                {credentialSuccess ? (
                  <div className="rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
                    {credentialSuccess}
                  </div>
                ) : null}

                <div className="flex flex-wrap gap-3">
                  <button
                    className="button-shell button-primary"
                    type="submit"
                    disabled={isBusy || !selectedStore.isActive}
                  >
                    인증정보 저장
                  </button>
                  <button
                    className="button-shell button-secondary"
                    type="button"
                    disabled={isBusy || !selectedStore.isActive}
                    onClick={async () => {
                      setCredentialError(null);
                      setCredentialSuccess(null);
                      setIsTestingCredential(true);
                      try {
                        const result = await readApiResponse<CredentialTestResult>(
                          await fetch(`/api/stores/${selectedStore.id}/commerce-credentials/test`, {
                            method: "POST",
                          }),
                          "연결 테스트에 실패했습니다.",
                        );
                        setTestResult(result);
                        setCredentialSuccess("연결 테스트가 성공했습니다.");
                        startRefresh(() => {
                          router.refresh();
                        });
                      } catch (error) {
                        setCredentialError(
                          error instanceof Error
                            ? error.message
                            : "연결 테스트 중 오류가 발생했습니다.",
                        );
                      } finally {
                        setIsTestingCredential(false);
                      }
                    }}
                  >
                    연결 테스트
                  </button>
                </div>
              </form>
            </Panel>

            <Panel title="연결 상태 및 보안 안내">
              <div className="space-y-4 text-sm leading-6 text-ink/65">
                <div className="flex items-center gap-3">
                  <StatusBadge tone="success">
                    {selectedStore.credentialConnectionStatus}
                  </StatusBadge>
                  <span>최근 테스트 {formatDateTime(selectedStore.lastCredentialTestAt)}</span>
                </div>
                <p>현재 선택 스토어 메모: {formatNullableText(selectedStore.memo)}</p>
                <p>
                  저장된 clientId는 {formatNullableText(credentialSummary?.maskedClientId)} /
                  source {formatNullableText(credentialSummary?.credentialSource)}
                </p>
                <p>secret은 보안상 다시 표시되지 않습니다.</p>
                {isLoadingCredential ? <p>인증 정보를 불러오는 중입니다.</p> : null}
                {testResult ? (
                  <div className="rounded-2xl bg-white/70 px-4 py-4">
                    <p>credentialSource {testResult.credentialSource}</p>
                    <p>sellerAccountId {testResult.sellerAccountId}</p>
                    <p>channelNo {testResult.channelNo}</p>
                    <p>channelName {formatNullableText(testResult.channelName)}</p>
                    <p>testedAt {formatDateTime(testResult.testedAt)}</p>
                  </div>
                ) : null}
              </div>
            </Panel>
          </div>
        </div>
      ) : (
        <EmptyState
          title="선택된 스토어가 없습니다."
          description="스토어 목록에서 먼저 하나를 선택해 주세요."
        />
      )}
    </div>
  );
}
