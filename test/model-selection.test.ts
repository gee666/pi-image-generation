import assert from "node:assert/strict";
import { test } from "node:test";
import { PNG } from "pngjs";
import { IMAGE_MODELS, requestImage, resolveImageModel } from "../src/backend.ts";

const png = PNG.sync.write(new PNG({ width: 1, height: 1 }));

test("model selection defaults to Sunburst and rejects aliases and unsupported values", () => {
  assert.equal(resolveImageModel(undefined), "gpt-image-2.6-sunburst");
  for (const model of IMAGE_MODELS) assert.equal(resolveImageModel(model), model);
  for (const value of [null, "", "flare", "sunburst", "gpt-image-2.6", "other-model", 1, {}]) {
    assert.throws(() => resolveImageModel(value), /Image model must be/);
  }
});

test("both models reach generation and edit requests on both backends without fallback", async () => {
  for (const auth of [{ apiKey: "test-key" }, { accessToken: "test-token", accountId: "test-account" }]) {
    for (const model of IMAGE_MODELS) {
      for (const images of [undefined, [`data:image/png;base64,${png.toString("base64")}`]]) {
        let calls = 0;
        const result = await requestImage(auth, { prompt: "A circle", model, images }, AbortSignal.timeout(5000), async (url, init) => {
          calls++;
          assert.ok(String(url).endsWith(images ? "/images/edits" : "/images/generations"));
          if (init?.body instanceof FormData) assert.equal(init.body.get("model"), model);
          else assert.equal(JSON.parse(String(init?.body)).model, model);
          return Response.json({ data: [{ b64_json: png.toString("base64") }] });
        });
        assert.equal(calls, 1);
        assert.deepEqual(result.bytes, png);
        calls = 0;
        await assert.rejects(requestImage(auth, { prompt: "A circle", model, images }, AbortSignal.timeout(5000), async () => {
          calls++;
          return new Response(null, { status: 400 });
        }), /HTTP 400/);
        assert.equal(calls, 1, "model failures must not trigger fallback");
      }
    }
  }
});
