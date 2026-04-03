import { StatusBadge } from "@/components/shared/status-badge";
import type { SourceState } from "@/lib/api/types";

interface SourceBannerProps {
  sources: SourceState[];
}

export function SourceBanner({ sources }: SourceBannerProps) {
  if (sources.length === 0) {
    return null;
  }

  const mockSources = sources.filter((source) => source.source === "mock");
  const liveSources = sources.filter((source) => source.source === "live");

  const tone = mockSources.length > 0 ? "warning" : "success";
  const title =
    mockSources.length > 0
      ? "일부 섹션이 mock 데이터로 렌더링되었습니다."
      : "모든 섹션이 백엔드 응답으로 렌더링되었습니다.";
  const details =
    mockSources.length > 0
      ? mockSources
          .map((source) => `${source.label}: ${source.error ?? "요청 실패"}`)
          .join(" / ")
      : liveSources.map((source) => source.label).join(", ");

  return (
    <div className="mb-6 flex flex-col gap-3 rounded-[26px] border border-ink/10 bg-white/65 px-4 py-4 sm:flex-row sm:items-center sm:justify-between">
      <div>
        <p className="text-sm font-semibold text-ink">{title}</p>
        <p className="mt-1 text-sm leading-6 text-ink/62">{details}</p>
      </div>
      <StatusBadge tone={tone}>
        {mockSources.length > 0
          ? `Mock ${mockSources.length} / Live ${liveSources.length}`
          : "All Live"}
      </StatusBadge>
    </div>
  );
}
