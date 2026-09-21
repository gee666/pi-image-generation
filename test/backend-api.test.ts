import assert from "node:assert/strict";
import { test } from "node:test";
import { PNG } from "pngjs";
import { requestImage } from "../src/backend.ts";

const auth = { apiKey: "sk-SECRET-API-KEY" };
const prompt = "PRIVATE image prompt";
const fixture = new PNG({ width: 1, height: 1 });
fixture.data = Buffer.from([0, 128, 255, 127]);
const png = PNG.sync.write(fixture);
const imageResponse = () => Response.json({ data: [{ b64_json: png.toString("base64"), generation_id: "generation-1" }] });
const signal = () => new AbortController().signal;
const fields = { model: "gpt-image-2", prompt, background: "auto", quality: "auto", size: "auto", output_format: "png" };
const secretPattern = /sk-SECRET-API-KEY|PRIVATE image prompt|UPSTREAM-SECRET/;

function safeError(error: unknown): error is Error {
  assert.ok(error instanceof Error);
  assert.doesNotMatch(error.stack ?? error.message, secretPattern);
  assert.equal(error.cause, undefined);
  return true;
}

test("API-key generations use only the OpenAI endpoint and bearer/JSON headers, preserving PNG bytes and alpha", async () => {
  for (const images of [undefined, []]) {
    let calls = 0;
    let sent: RequestInit | undefined;
    let target: unknown;
    const abortSignal = signal();
    const output = await requestImage(auth, { prompt, images }, abortSignal, async (url, init) => {
      calls++;
      target = url;
      sent = init;
      return imageResponse();
    });
    assert.equal(calls, 1);
    assert.equal(target, "https://api.openai.com/v1/images/generations");
    assert.equal(sent?.method, "POST");
    assert.equal(sent?.redirect, "error");
    assert.equal(sent?.signal, abortSignal);
    assert.deepEqual(Object.fromEntries(new Headers(sent?.headers)), {
      authorization: `Bearer ${auth.apiKey}`,
      "content-type": "application/json",
    });
    assert.equal(typeof sent?.body, "string");
    assert.deepEqual(JSON.parse(sent!.body as string), fields);
    assert.deepEqual(output.bytes, png);
    assert.equal(PNG.sync.read(output.bytes).data[3], 127);
    assert.equal(output.generationId, "generation-1");
  }
});

test("API-key edits upload ordered PNG/JPEG/WebP blobs with MIME types, extensions and automatic multipart boundaries", async () => {
  // Data URLs have the same canonical format emitted by loadReferences; bytes must not be re-encoded.
  const references = [
    { mime: "image/png", extension: "png", bytes: png },
    { mime: "image/jpeg", extension: "jpg", bytes: Buffer.from("ffd8ffe000104a4649460001ffd9", "hex") },
    { mime: "image/webp", extension: "webp", bytes: Buffer.from("524946460400000057454250", "hex") },
  ];
  let calls = 0;
  let sent: RequestInit | undefined;
  let target: unknown;
  const abortSignal = signal();
  const output = await requestImage(auth, {
    prompt,
    images: references.map(({ mime, bytes }) => `data:${mime};base64,${bytes.toString("base64")}`),
  }, abortSignal, async (url, init) => {
    calls++;
    target = url;
    sent = init;
    return imageResponse();
  });
  assert.equal(calls, 1);
  assert.equal(target, "https://api.openai.com/v1/images/edits");
  assert.equal(sent?.method, "POST");
  assert.equal(sent?.redirect, "error");
  assert.equal(sent?.signal, abortSignal);
  assert.deepEqual(Object.fromEntries(new Headers(sent?.headers)), { authorization: `Bearer ${auth.apiKey}` });
  assert.ok(sent?.body instanceof FormData);
  const form = sent.body;
  assert.deepEqual([...form.keys()], [...Object.keys(fields), "image[]", "image[]", "image[]"]);
  for (const [name, value] of Object.entries(fields)) assert.equal(form.get(name), value);
  const files = form.getAll("image[]");
  for (const [index, reference] of references.entries()) {
    const file = files[index];
    assert.ok(file instanceof File);
    assert.equal(file.type, reference.mime);
    assert.equal(file.name, `reference-${index + 1}.${reference.extension}`);
    assert.deepEqual(Buffer.from(await file.arrayBuffer()), reference.bytes);
  }
  const encoded = new Request(String(target), sent);
  assert.match(encoded.headers.get("content-type")!, /^multipart\/form-data; boundary=/);
  assert.equal((await encoded.formData()).getAll("image[]").length, 3);
  assert.deepEqual(output.bytes, png);
  assert.equal(PNG.sync.read(output.bytes).data[3], 127);
});

test("API failures suppress upstream bodies and secrets, do not retry, and give provider-neutral auth advice", async () => {
  for (const images of [undefined, [`data:image/png;base64,${png.toString("base64")}`]]) {
    for (const status of [302, 400, 401, 403, 404, 429, 500]) {
      let calls = 0;
      let cancelled = false;
      await assert.rejects(requestImage(auth, { prompt, images }, signal(), async () => {
        calls++;
        return new Response(new ReadableStream({
          start(controller) { controller.enqueue(new TextEncoder().encode(`${auth.apiKey} ${prompt} UPSTREAM-SECRET`)); },
          cancel() { cancelled = true; },
        }), { status, headers: { location: "https://example.invalid/UPSTREAM-SECRET" } });
      }), error => {
        assert.ok(safeError(error));
        assert.match(error.message, new RegExp(`HTTP ${status}`));
        assert.doesNotMatch(error.message, /openai-codex|subscription/);
        if (status === 401) assert.match(error.message, /login or API-key settings/);
        return true;
      });
      assert.equal(calls, 1);
      assert.equal(cancelled, true);
    }
    let calls = 0;
    await assert.rejects(requestImage(auth, { prompt, images }, signal(), async () => {
      calls++;
      throw new Error(`${auth.apiKey} ${prompt} UPSTREAM-SECRET`);
    }), error => {
      assert.ok(safeError(error));
      assert.match(error.message, /connection failed.*No automatic retry/);
      return true;
    });
    assert.equal(calls, 1);
  }
});

test("API error-body cancellation failures cannot leak transport secrets", async () => {
  await assert.rejects(requestImage(auth, { prompt }, signal(), async () => new Response(new ReadableStream({
    cancel() { throw new Error(`UPSTREAM-SECRET ${auth.apiKey}`); },
  }), { status: 401 })), error => {
    assert.ok(safeError(error));
    assert.match(error.message, /HTTP 401/);
    return true;
  });
});

test("API streaming responses are bounded even without Content-Length", async () => {
  let cancelled = false;
  let calls = 0;
  const chunk = new Uint8Array(1024 * 1024);
  await assert.rejects(requestImage(auth, { prompt }, signal(), async () => {
    calls++;
    return new Response(new ReadableStream({
      pull(controller) { controller.enqueue(chunk); },
      cancel() { cancelled = true; },
    }));
  }), error => {
    assert.ok(safeError(error));
    assert.match(error.message, /oversized response/);
    return true;
  });
  assert.equal(calls, 1);
  assert.equal(cancelled, true);
});

test("API-key cancellation and response validation retain existing safeguards", async () => {
  await assert.rejects(requestImage(auth, { prompt }, AbortSignal.abort(), async () => {
    assert.fail("pre-aborted request must not fetch");
  }), /abort/i);
  const controller = new AbortController();
  let calls = 0;
  const pending = requestImage(auth, { prompt }, controller.signal, async (_url, init) => {
    calls++;
    return new Promise((_, reject) => init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason)));
  });
  controller.abort();
  await assert.rejects(pending, /abort/i);
  assert.equal(calls, 1);

  const corrupt = png.subarray(0, 24).toString("base64");
  for (const response of [
    new Response(`UPSTREAM-SECRET ${auth.apiKey} ${prompt}`),
    new Response("{}", { headers: { "content-length": String(100 * 1024 * 1024) } }),
    Response.json({ data: [] }),
    Response.json({ data: [{ b64_json: png.toString("base64") }, { b64_json: png.toString("base64") }] }),
    Response.json({ data: [{ b64_json: "UPSTREAM-SECRET" }] }),
    Response.json({ data: [{ b64_json: corrupt }] }),
  ]) {
    calls = 0;
    await assert.rejects(requestImage(auth, { prompt }, signal(), async () => {
      calls++;
      return response;
    }), safeError);
    assert.equal(calls, 1);
  }
});

test("API-key edits never fetch external or malformed reference URLs", async () => {
  for (const image of ["https://example.invalid/UPSTREAM-SECRET", "data:image/gif;base64,R0lGODlh", "data:image/png;base64,UPSTREAM-SECRET"]) {
    await assert.rejects(requestImage(auth, { prompt, images: [image] }, signal(), async () => {
      assert.fail("invalid references must not fetch");
    }), error => {
      assert.ok(safeError(error));
      assert.match(error.message, /data URLs/);
      return true;
    });
  }
});
