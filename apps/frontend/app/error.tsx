"use client";

export default function ErrorPage() {
  return (
    <main className="mx-auto max-w-2xl px-6 py-16" role="alert">
      <div className="glass-panel rounded-[28px] px-6 py-10 text-center">
        <h1 className="text-2xl font-semibold text-ink">데이터를 불러오지 못했습니다</h1>
        <p className="mt-3 text-sm leading-6 text-ink/70">
          서버가 시작 중이거나 연결이 끊겼을 수 있습니다. 잠시 후 다시 시도해 주세요.
        </p>
        <button className="button-shell button-primary mt-6" onClick={() => window.location.reload()}>
          다시 시도
        </button>
      </div>
    </main>
  );
}
