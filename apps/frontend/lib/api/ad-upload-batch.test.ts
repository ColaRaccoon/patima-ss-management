import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { test } from "node:test";
import type { ExecutionContext } from "@nestjs/common";
import { FilesInterceptor } from "@nestjs/platform-express";
import { of } from "rxjs";
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
