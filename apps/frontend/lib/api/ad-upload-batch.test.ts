import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { test } from "node:test";
import type { ExecutionContext } from "@nestjs/common";
import { FilesInterceptor } from "@nestjs/platform-express";
import { of } from "rxjs";
import { parseAdUploadFileName } from "@patima/shared";
import { uploadAdFiles } from "./ad-upload-batch";
import { POST } from "../../app/api/ad-uploads/batch/route";
import { repairMojibakeText } from "../../../backend/src/helpers";

const makeFiles = (count: number) => Array.from({ length: count }, (_, index) =>
  new File([`file-${index}`], `file-${index}.xlsx`),
);
const successfulResults = (files: File[]) => files.map((file, index) => ({
  index, fileName: file.name, success: true, uploadId: `upload-${file.name}`,
}));

test("uploads send at most ten files per request and retain per-file failures", async (context) => {
  const files = makeFiles(23);
  const batches: string[][] = [];
  const progress: number[] = [];
  context.mock.method(globalThis, "fetch", async (input: string, init: RequestInit) => {
    assert.equal(input, "/api/ad-uploads/batch");
    const body = init.body as FormData;
    const batch = body.getAll("files") as File[];
    batches.push(batch.map((file) => file.name));
    assert.equal(body.get("storeId"), "store-a");
    assert.equal(body.get("reportDate"), "2026-11-10");
    const results = batch.map((file, index) => file === files[2] || file === files[21]
      ? { index, fileName: file.name, success: false, message: "요일 불일치" }
      : { index, fileName: file.name, success: true, uploadId: `upload-${file.name}` });
    return Response.json({ success: true, data: { results: results.reverse(), confirmedFileCount: results.filter((item) => item.success).length } });
  });

  const result = await uploadAdFiles({
    files, storeId: "store-a", reportDate: "2026-11-10",
    onProgress: (completed, total) => { progress.push(completed); assert.equal(total, files.length); },
  });
  assert.deepEqual(batches.map((batch) => batch.length), [10, 10, 3]);
  assert.deepEqual(batches.flat(), files.map((file) => file.name));
  assert.deepEqual(result.succeeded, files.filter((_, index) => index !== 2 && index !== 21));
  assert.deepEqual(result.failed.map(({ file }) => file), [files[2], files[21]]);
  assert.ok(result.failed.every(({ reason }) => reason === "요일 불일치"));
  assert.deepEqual(progress, [0, 10, 20, 23]);
});

test("network and HTTP batch failures do not prevent later batches from uploading", async (context) => {
  const files = makeFiles(21);
  const progress: number[] = [];
  let calls = 0;
  context.mock.method(globalThis, "fetch", async (_input: string, init: RequestInit) => {
    calls += 1;
    if (calls === 1) throw new TypeError("fetch failed");
    if (calls === 2) return Response.json({ success: false, message: "스토어 설정을 확인해 주세요." }, { status: 400 });
    const batch = (init.body as FormData).getAll("files") as File[];
    return Response.json({ success: true, data: { results: successfulResults(batch), confirmedFileCount: 1 } });
  });
  const result = await uploadAdFiles({
    files, storeId: "s", reportDate: "2026-11-10", onProgress: (completed) => progress.push(completed),
  });
  assert.equal(calls, 3);
  assert.deepEqual(result.succeeded, [files[20]]);
  assert.deepEqual(result.failed.map(({ file }) => file), files.slice(0, 20));
  assert.ok(result.failed.slice(0, 10).every(({ reason }) => /업로드 이력을 확인/.test(reason)));
  assert.ok(result.failed.slice(10).every(({ reason }) => reason === "스토어 설정을 확인해 주세요."));
  assert.deepEqual(progress, [0, 10, 20, 21]);
});

test("missing, duplicate and invalid indexes cannot count unconfirmed files as successful", async (context) => {
  const files = makeFiles(7);
  const valid = successfulResults(files);
  context.mock.method(globalThis, "fetch", async () => Response.json({
    success: true,
    data: {
      confirmedFileCount: 7,
      results: [
        valid[0], valid[1], { ...valid[1], uploadId: "duplicate" },
        { ...valid[2], index: "2" },
        { ...valid[3], index: -1 },
        { ...valid[4], uploadId: "" },
        { index: 5, fileName: files[5].name, success: false, message: "파일 검증 실패" },
        { ...valid[6], fileName: "wrong-file.xlsx" },
        { index: 99, fileName: "outside.xlsx", success: true, uploadId: "outside" },
        null,
      ],
    },
  }));
  const result = await uploadAdFiles({ files, storeId: "s", reportDate: "2026-11-10" });
  assert.deepEqual(result.succeeded, [files[0]]);
  assert.deepEqual(result.failed.map(({ file }) => file), files.slice(1));
  assert.equal(result.failed.find(({ file }) => file === files[5])?.reason, "파일 검증 실패");
  assert.ok(result.failed.filter(({ file }) => file !== files[5]).every(({ reason }) => /업로드 이력을 확인/.test(reason)));
});

test("files with the same name are matched by their batch index", async (context) => {
  const files = [new File(["a"], "같은이름.xlsx"), new File(["b"], "같은이름.xlsx")];
  context.mock.method(globalThis, "fetch", async () => Response.json({ success: true, data: {
    results: [
      { index: 1, fileName: files[1].name, success: false, message: "중복 캠페인" },
      { index: 0, fileName: files[0].name, success: true, uploadId: "first" },
    ], confirmedFileCount: 1,
  } }));
  const result = await uploadAdFiles({ files, storeId: "s", reportDate: "2026-11-10" });
  assert.deepEqual(result.succeeded, [files[0]]);
  assert.deepEqual(result.failed.map(({ file }) => file), [files[1]]);
});

test("failed and malformed successful responses retain every file for review", async (context) => {
  for (const [label, response] of [
    ["failed envelope", Response.json({ success: false, message: "검증 실패" })],
    ["invalid JSON", new Response("invalid JSON")],
    ["missing results", Response.json({ success: true, data: {} })],
  ] as const) {
    await context.test(label, async (subcontext) => {
      subcontext.mock.method(globalThis, "fetch", async () => response);
      const files = makeFiles(2);
      const result = await uploadAdFiles({ files, storeId: "s", reportDate: "2026-11-10" });
      assert.equal(result.succeeded.length, 0);
      assert.deepEqual(result.failed.map(({ file }) => file), files);
      if (label === "failed envelope") assert.equal(result.failed[0].reason, "검증 실패");
      else assert.match(result.failed[0].reason, /업로드 이력을 확인/);
    });
  }
});

test("empty selection sends no request", async (context) => {
  const fetch = context.mock.method(globalThis, "fetch", async () => { throw new Error("Unexpected request"); });
  assert.deepEqual(await uploadAdFiles({ files: [], storeId: "s", reportDate: "2026-11-10" }), { succeeded: [], failed: [] });
  assert.equal(fetch.mock.callCount(), 0);
});

function makeRequest(files: Array<File | string>, storeId = "store-a", reportDate = "2026-11-10") {
  const body = new FormData();
  body.append("storeId", storeId);
  body.append("reportDate", reportDate);
  for (const file of files) body.append("files", file);
  return new Request("http://localhost/api/ad-uploads/batch", { method: "POST", body });
}

test("batch proxy forwards every file and preserves individual backend results", async (context) => {
  const expected = { success: true, data: { results: [
    { index: 0, fileName: "광고.xlsx", success: true, uploadId: "u" },
    { index: 1, fileName: "empty.xlsx", success: false, message: "빈 파일" },
  ], confirmedFileCount: 1 } };
  context.mock.method(globalThis, "fetch", async (input: string, init: RequestInit) => {
    assert.ok(input.endsWith("/api/v1/ad-uploads/batch"));
    assert.equal(init.method, "POST");
    const body = init.body as FormData;
    assert.equal(body.get("storeId"), "store-a");
    assert.equal(body.get("reportDate"), "2026-11-10");
    const files = body.getAll("files") as File[];
    assert.deepEqual(files.map((file) => file.name), ["광고.xlsx", "empty.xlsx"]);
    assert.equal(await files[0].text(), "contents");
    assert.equal(files[1].size, 0);
    return Response.json(expected);
  });
  const response = await POST(makeRequest([new File(["contents"], "광고.xlsx"), new File([], "empty.xlsx")]));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), expected);
});

test("batch proxy rejects malformed requests before contacting the backend", async (context) => {
  const fetch = context.mock.method(globalThis, "fetch", async () => { throw new Error("Unexpected request"); });
  const requests = [
    makeRequest([]), makeRequest(makeFiles(11)), makeRequest(["not a file"]),
    makeRequest(makeFiles(1), " "), makeRequest(makeFiles(1), "s", "2026-02-30"),
    new Request("http://localhost/api/ad-uploads/batch", { method: "POST", body: "invalid" }),
  ];
  for (const request of requests) assert.equal((await POST(request)).status, 400);
  assert.equal(fetch.mock.callCount(), 0);
});

test("batch proxy reports an ambiguous upstream failure with a history-check message", async (context) => {
  context.mock.method(globalThis, "fetch", async () => { throw new TypeError("fetch failed"); });
  const response = await POST(makeRequest(makeFiles(1)));
  assert.equal(response.status, 502);
  assert.match((await response.json()).message, /업로드 이력을 확인/);
});

test("Korean filenames survive helper, Next proxy and Nest multipart parsing with per-file failures", async (context) => {
  const files = [
    new File(["first"], "같은 광고 이름.xlsx"),
    new File([], "같은 광고 이름.xlsx"),
    new File(["invalid extension"], "광고 파일.txt"),
    ...Array.from({ length: 9 }, (_, index) => new File([`contents-${index}`], `광고 성과 ${index} 📊.xlsx`)),
  ];
  const receivedBatches: Array<{ names: string[]; buffers: string[] }> = [];
  const progress: number[] = [];
  const MultipartInterceptor = FilesInterceptor("files", 10);

  context.mock.method(globalThis, "fetch", async (input: string, init: RequestInit) => {
    if (input === "/api/ad-uploads/batch") {
      return POST(new Request("http://localhost/api/ad-uploads/batch", init));
    }
    assert.ok(input.endsWith("/api/v1/ad-uploads/batch"));
    const forwarded = new Request("http://localhost/api/v1/ad-uploads/batch", init);
    const buffer = Buffer.from(await forwarded.arrayBuffer());
    const request = Object.assign(Readable.from([buffer]), {
      headers: { ...Object.fromEntries(forwarded.headers), "content-length": String(buffer.length) },
      method: "POST",
      body: undefined as Record<string, string> | undefined,
      files: undefined as Express.Multer.File[] | undefined,
    });
    // Use the production Nest multipart interceptor without opening a server or
    // loading the application/database. The response below stands in for the
    // service's per-file validation after transport has parsed the real bytes.
    const executionContext = {
      switchToHttp: () => ({ getRequest: () => request, getResponse: () => ({}) }),
    } as unknown as ExecutionContext;
    await new MultipartInterceptor().intercept(executionContext, { handle: () => of(null) });

    assert.equal(request.body?.storeId, "스토어-a");
    assert.equal(request.body?.reportDate, "2024-02-29");
    const parsedFiles = request.files!;
    assert.ok(parsedFiles.every((file) => file.fieldname === "files"));
    receivedBatches.push({
      names: parsedFiles.map((file) => repairMojibakeText(file.originalname)),
      buffers: parsedFiles.map((file) => file.buffer.toString()),
    });
    const results = parsedFiles.map((file, index) => {
      const fileName = repairMojibakeText(file.originalname);
      if (file.size === 0) return { index, fileName, success: false, message: "빈 파일입니다." };
      if (!fileName.endsWith(".xlsx")) return { index, fileName, success: false, message: "엑셀 파일만 업로드해 주세요." };
      return { index, fileName, success: true, uploadId: `upload-${receivedBatches.length}-${index}` };
    });
    return Response.json({ success: true, data: {
      results, confirmedFileCount: results.filter((result) => result.success).length,
    } });
  });

  const result = await uploadAdFiles({
    files, storeId: "스토어-a", reportDate: "2024-02-29",
    onProgress: (completed, total) => { progress.push(completed); assert.equal(total, 12); },
  });
  assert.deepEqual(receivedBatches.map(({ names }) => names.length), [10, 2]);
  assert.deepEqual(receivedBatches.flatMap(({ names }) => names), files.map((file) => file.name));
  assert.deepEqual(receivedBatches.flatMap(({ buffers }) => buffers), await Promise.all(files.map((file) => file.text())));
  assert.deepEqual(result.succeeded, files.filter((_, index) => index !== 1 && index !== 2));
  assert.deepEqual(result.failed, [
    { file: files[1], reason: "빈 파일입니다." },
    { file: files[2], reason: "엑셀 파일만 업로드해 주세요." },
  ]);
  assert.deepEqual(progress, [0, 10, 12]);
});

function makeAutomaticFiles(count: number) {
  return Array.from({ length: count }, (_, index) => {
    const date = new Date(Date.UTC(2026, 0, index + 1)).toISOString().slice(2, 10).replaceAll("-", "");
    return new File([`data-${index}`], `${date}_${index % 2 ? "파티마서브" : "인피니티메인"}.xlsx`);
  });
}

function automaticPayload(files: File[]) {
  const items = files.map((file, index) => ({
    originalFileName: file.name,
    ...parseAdUploadFileName(file.name)!,
    uploadId: `auto-upload-${index}`,
    confirmedRowCount: index + 1,
    summaryStatus: index === 0 ? "WARNING" : "SUCCEEDED",
  }));
  return { items, fileCount: items.length, confirmedRowCount: items.reduce((sum, item) => sum + item.confirmedRowCount, 0) };
}

function automaticRequest(files: File[]) {
  const body = new FormData();
  for (const file of files) body.append("files", file);
  return new Request("http://localhost/api/ad-uploads/batch", { method: "POST", body });
}

test("automatic uploads keep mixed stores and dates in one atomic request with result details", async (context) => {
  const files = makeAutomaticFiles(12);
  const progress: number[] = [];
  const expected = automaticPayload(files);
  const fetch = context.mock.method(globalThis, "fetch", async (_input: string, init: RequestInit) => {
    const body = init.body as FormData;
    assert.equal(body.has("storeId"), false);
    assert.equal(body.has("reportDate"), false);
    assert.deepEqual(body.getAll("files"), files);
    return Response.json({ success: true, data: { ...expected, items: [...expected.items].reverse() } });
  });
  const result = await uploadAdFiles({ files, onProgress: (completed) => progress.push(completed) });
  assert.equal(fetch.mock.callCount(), 1, "never split an atomic upload at the manual chunk boundary");
  assert.deepEqual(result.succeeded, files);
  assert.deepEqual(result.failed, []);
  assert.deepEqual(result.details, expected.items);
  assert.equal(result.details?.[0].summaryStatus, "WARNING");
  assert.equal(new Set(result.details?.map((item) => item.storeName)).size, 2);
  assert.deepEqual(progress, [0, 12]);
});

test("automatic upload supports 100 files and rejects 101 without splitting or sending", async (context) => {
  const files = makeAutomaticFiles(100);
  const fetch = context.mock.method(globalThis, "fetch", async () => Response.json({ success: true, data: automaticPayload(files) }));
  assert.equal((await uploadAdFiles({ mode: "auto", files })).succeeded.length, 100);
  const tooMany = makeAutomaticFiles(101);
  const rejected = await uploadAdFiles({ mode: "auto", files: tooMany });
  assert.deepEqual(rejected.succeeded, []);
  assert.deepEqual(rejected.failed.map(({ file }) => file), tooMany);
  assert.match(rejected.failed[0].reason, /최대 100개/);
  assert.equal(fetch.mock.callCount(), 1);
});

test("automatic mode retains all files when a filename, date or size is invalid", async (context) => {
  const fetch = context.mock.method(globalThis, "fetch", async () => { throw new Error("Unexpected request"); });
  const invalidFiles = [
    new File(["data"], "manual-name.xlsx"),
    new File(["data"], "260230_파티마.xlsx"),
    new File([], "260101_파티마.xlsx"),
    new File([new Uint8Array(10 * 1024 * 1024 + 1)], "260101_파티마.xlsx"),
  ];
  for (const invalid of invalidFiles) {
    const files = [...makeAutomaticFiles(1), invalid];
    const result = await uploadAdFiles({ mode: "auto", files });
    assert.deepEqual(result.succeeded, []);
    assert.deepEqual(result.failed.map(({ file }) => file), files);
    assert.match(result.failed[0].reason, /모두 반영되지 않았습니다/);
  }
  assert.equal(fetch.mock.callCount(), 0);
});

test("automatic server rejection and lost responses retain the entire selection", async (context) => {
  for (const scenario of ["validation", "network"] as const) {
    await context.test(scenario, async (subcontext) => {
      const files = makeAutomaticFiles(12);
      const fetch = subcontext.mock.method(globalThis, "fetch", async () => {
        if (scenario === "network") throw new TypeError("fetch failed");
        return Response.json({ message: "중복 캠페인", fileName: files[1].name }, { status: 400 });
      });
      const result = await uploadAdFiles({ files, mode: "auto" });
      assert.deepEqual(result.succeeded, []);
      assert.deepEqual(result.failed.map(({ file }) => file), files);
      assert.equal(fetch.mock.callCount(), 1);
      if (scenario === "validation") {
        assert.ok(result.failed[0].reason.includes(files[1].name));
        assert.match(result.failed[0].reason, /모두 반영되지 않았습니다/);
      } else assert.match(result.failed[0].reason, /업로드 이력을 확인/);
    });
  }
});

test("automatic success requires complete and matching filenames, targets, IDs and counts", async (context) => {
  const files = makeAutomaticFiles(2);
  for (const scenario of ["missing file", "duplicate ID", "wrong filename", "wrong target", "wrong count", "wrong summary"] as const) {
    await context.test(scenario, async (subcontext) => {
      const data = automaticPayload(files);
      if (scenario === "missing file") data.items.pop();
      if (scenario === "duplicate ID") data.items[1].uploadId = data.items[0].uploadId;
      if (scenario === "wrong filename") data.items[1].originalFileName = data.items[0].originalFileName;
      if (scenario === "wrong target") data.items[1].reportDate = data.items[0].reportDate;
      if (scenario === "wrong count") data.confirmedRowCount += 1;
      if (scenario === "wrong summary") data.items[0].summaryStatus = "UNKNOWN";
      subcontext.mock.method(globalThis, "fetch", async () => Response.json({ success: true, data }));
      const result = await uploadAdFiles({ files, mode: "auto" });
      assert.deepEqual(result.succeeded, []);
      assert.deepEqual(result.failed.map(({ file }) => file), files);
      assert.match(result.failed[0].reason, /업로드 이력을 확인/);
    });
  }
});

test("manual mode rejects an oversized file while still uploading the other files", async (context) => {
  const oversized = new File([new Uint8Array(10 * 1024 * 1024 + 1)], "oversized.xlsx");
  const files = [oversized, ...makeFiles(1)];
  context.mock.method(globalThis, "fetch", async (_input: string, init: RequestInit) => {
    const uploaded = (init.body as FormData).getAll("files") as File[];
    assert.deepEqual(uploaded, [files[1]]);
    return Response.json({ success: true, data: { results: successfulResults(uploaded), confirmedFileCount: 1 } });
  });
  const result = await uploadAdFiles({ mode: "manual", files, storeId: "s", reportDate: "2026-01-01" });
  assert.deepEqual(result.succeeded, [files[1]]);
  assert.deepEqual(result.failed.map(({ file }) => file), [oversized]);
});

test("proxy accepts automatic 100-file batches and rejects partial manual targeting", async (context) => {
  const files = makeAutomaticFiles(100);
  const fetch = context.mock.method(globalThis, "fetch", async (_input: string, init: RequestInit) => {
    const body = init.body as FormData;
    assert.equal(body.has("storeId"), false);
    assert.equal(body.has("reportDate"), false);
    assert.equal(body.getAll("files").length, 100);
    return Response.json({ success: true, data: automaticPayload(files) }, { status: 201 });
  });
  assert.equal((await POST(automaticRequest(files))).status, 201);
  assert.equal((await POST(automaticRequest(makeAutomaticFiles(101)))).status, 400);
  for (const field of ["storeId", "reportDate"]) {
    const body = new FormData();
    body.append("files", files[0]);
    body.append(field, field === "storeId" ? "store-a" : "2026-01-01");
    assert.equal((await POST(new Request("http://localhost/api/ad-uploads/batch", { method: "POST", body }))).status, 400);
  }
  assert.equal(fetch.mock.callCount(), 1);
});

test("automatic proxy preserves upstream validation errors and rejects empty or oversized files", async (context) => {
  const error = { message: "파일명 확인", fileName: "invalid.xlsx" };
  const fetch = context.mock.method(globalThis, "fetch", async () => Response.json(error, { status: 400 }));
  const response = await POST(automaticRequest(makeAutomaticFiles(1)));
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), error);
  assert.equal((await POST(automaticRequest([new File([], "260101_파티마.xlsx")]))).status, 400);
  const oversized = new File([new Uint8Array(10 * 1024 * 1024 + 1)], "260101_파티마.xlsx");
  assert.equal((await POST(automaticRequest([oversized]))).status, 400);
  assert.equal(fetch.mock.callCount(), 1);
});
