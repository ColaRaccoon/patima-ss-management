type SearchParams = Record<string, string | string[] | undefined>;

const normalizeSearchParams = (params: SearchParams) =>
  Object.entries(params)
    .sort(([left], [right]) => left.localeCompare(right, "ko"))
    .map(([key, value]) => ({
      key,
      value: Array.isArray(value) ? value.join(", ") : (value ?? ""),
    }));

const looksLikeJwt = (value: string) => value.split(".").length === 3;

const decodeBase64Url = (value: string) => {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  return Buffer.from(padded, "base64").toString("utf8");
};

const decodeJwtPayload = (token: string) => {
  try {
    const [, payload] = token.split(".");
    if (!payload) {
      return null;
    }
    return JSON.parse(decodeBase64Url(payload)) as Record<string, unknown>;
  } catch {
    return null;
  }
};

const findJwtCandidate = (params: Array<{ key: string; value: string }>) =>
  params.find((entry) => looksLikeJwt(entry.value)) ?? null;

export default async function NaverCallbackPage({
  searchParams,
}: {
  searchParams?: Promise<SearchParams>;
}) {
  const resolvedSearchParams = (await searchParams) ?? {};
  const entries = normalizeSearchParams(resolvedSearchParams);
  const jwtCandidate = findJwtCandidate(entries);
  const payload = jwtCandidate ? decodeJwtPayload(jwtCandidate.value) : null;

  return (
    <main className="mx-auto min-h-screen max-w-6xl px-4 py-10 sm:px-6 lg:px-8">
      <section className="glass-panel rounded-[34px] p-6 sm:p-8">
        <div className="max-w-3xl">
          <p className="text-sm font-semibold uppercase tracking-[0.24em] text-[var(--accent)]">
            Naver Callback
          </p>
          <h1 className="mt-3 text-3xl font-semibold tracking-tight text-[var(--text)] sm:text-4xl">
            네이버 커머스 JWT 수신 확인
          </h1>
          <p className="mt-4 text-sm leading-7 text-[var(--muted)] sm:text-base">
            이 페이지는 네이버 커머스솔루션에서 전달한 쿼리스트링과 JWT payload를
            바로 읽어보는 진단용 화면입니다. 여기에서 보이는 payload는 서명 검증
            전 임시 해석값이므로, 실제 운영에서는 솔루션 공개키로 검증한 뒤
            사용해야 합니다.
          </p>
        </div>

        <div className="mt-8 grid gap-6 xl:grid-cols-[minmax(0,0.85fr)_minmax(320px,0.65fr)]">
          <section className="glass-panel rounded-[28px] border border-[var(--line)]/70 p-5 sm:p-6">
            <div className="mb-4">
              <h2 className="text-xl font-semibold text-[var(--text)]">
                수신된 쿼리 파라미터
              </h2>
              <p className="mt-2 text-sm leading-6 text-[var(--muted)]">
                네이버가 실제로 어떤 이름의 파라미터로 값을 붙였는지 여기서
                확인할 수 있습니다.
              </p>
            </div>

            {entries.length === 0 ? (
              <div className="rounded-[22px] border border-dashed border-[var(--line-strong)] bg-white/55 p-5 text-sm leading-6 text-[var(--muted)]">
                아직 전달된 쿼리 파라미터가 없습니다. 네이버 솔루션 설정에서
                이 URL로 이동되도록 저장한 뒤, 판매자 계정으로 실제
                <span className="font-semibold text-[var(--text)]"> 사용하기 </span>
                또는
                <span className="font-semibold text-[var(--text)]"> 신청하기 </span>
                를 눌러 다시 들어오면 됩니다.
              </div>
            ) : (
              <div className="overflow-hidden rounded-[22px] border border-[var(--line)] bg-white/72">
                <table className="min-w-full divide-y divide-[var(--line)] text-sm">
                  <thead className="bg-[var(--bg-strong)]/60">
                    <tr>
                      <th className="px-4 py-3 text-left font-semibold text-[var(--text)]">
                        Key
                      </th>
                      <th className="px-4 py-3 text-left font-semibold text-[var(--text)]">
                        Value
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[var(--line)]">
                    {entries.map((entry) => (
                      <tr key={entry.key}>
                        <td className="px-4 py-3 align-top font-mono text-xs text-[var(--text)]">
                          {entry.key}
                        </td>
                        <td className="px-4 py-3 align-top break-all font-mono text-xs text-[var(--muted)]">
                          {entry.value || "(empty)"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className="glass-panel rounded-[28px] border border-[var(--line)]/70 p-5 sm:p-6">
            <div className="mb-4">
              <h2 className="text-xl font-semibold text-[var(--text)]">
                JWT 요약
              </h2>
              <p className="mt-2 text-sm leading-6 text-[var(--muted)]">
                보통 여기서
                <span className="font-semibold text-[var(--text)]"> accountUid </span>
                와
                <span className="font-semibold text-[var(--text)]"> defaultChannelNo </span>
                를 확인하면 됩니다.
              </p>
            </div>

            {payload ? (
              <div className="space-y-4">
                <div className="rounded-[22px] border border-[var(--line)] bg-white/72 p-4">
                  <p className="text-xs uppercase tracking-[0.18em] text-[var(--muted)]">
                    주요 값
                  </p>
                  <dl className="mt-3 space-y-3 text-sm">
                    <div>
                      <dt className="font-semibold text-[var(--text)]">accountUid</dt>
                      <dd className="mt-1 break-all font-mono text-xs text-[var(--muted)]">
                        {String(payload.accountUid ?? "(없음)")}
                      </dd>
                    </div>
                    <div>
                      <dt className="font-semibold text-[var(--text)]">defaultChannelNo</dt>
                      <dd className="mt-1 break-all font-mono text-xs text-[var(--muted)]">
                        {String(payload.defaultChannelNo ?? "(없음)")}
                      </dd>
                    </div>
                    <div>
                      <dt className="font-semibold text-[var(--text)]">channelName</dt>
                      <dd className="mt-1 break-all font-mono text-xs text-[var(--muted)]">
                        {String(payload.channelName ?? "(없음)")}
                      </dd>
                    </div>
                    <div>
                      <dt className="font-semibold text-[var(--text)]">solutionId</dt>
                      <dd className="mt-1 break-all font-mono text-xs text-[var(--muted)]">
                        {String(payload.solutionId ?? "(없음)")}
                      </dd>
                    </div>
                  </dl>
                </div>

                <div className="rounded-[22px] border border-[var(--line)] bg-[#111826] p-4 text-xs text-white">
                  <p className="mb-3 uppercase tracking-[0.18em] text-white/60">
                    Decoded Payload
                  </p>
                  <pre className="overflow-x-auto whitespace-pre-wrap break-all leading-6">
                    {JSON.stringify(payload, null, 2)}
                  </pre>
                </div>
              </div>
            ) : (
              <div className="rounded-[22px] border border-dashed border-[var(--line-strong)] bg-white/55 p-5 text-sm leading-6 text-[var(--muted)]">
                현재 쿼리값 중 JWT 형태로 보이는 값이 없습니다. 네이버에서
                이동된 뒤 다시 이 화면을 열어 주세요. JWT는 보통 점(`.`) 2개가
                포함된 긴 문자열입니다.
              </div>
            )}

            <div className="mt-5 rounded-[22px] border border-[var(--line)] bg-[var(--accent-soft)] p-4 text-sm leading-6 text-[var(--text)]">
              <p className="font-semibold">테스트용 URL</p>
              <p className="mt-2 break-all font-mono text-xs">
                http://localhost:3000/naver/callback
              </p>
            </div>
          </section>
        </div>
      </section>
    </main>
  );
}
