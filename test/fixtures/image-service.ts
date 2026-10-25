import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { PNG } from "pngjs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Only the image service is faked. Pi's model transport and tool execution stay real.
export default function imageService(pi: ExtensionAPI): void {
  const originalFetch = globalThis.fetch;
  const fixture = new PNG({ width: 2, height: 1 });
  fixture.data = Buffer.from([0, 128, 255, 127, 255, 0, 0, 0]);
  const png = PNG.sync.write(fixture);
  pi.on("session_start", (_event, ctx) => {
    globalThis.fetch = async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (!url.includes("/images/")) return originalFetch(input, init);
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer evergreen-fake-image-key");
      assert.equal(init?.redirect, "error");
      let prompt: unknown;
      if (url === "https://api.openai.com/v1/images/generations") {
        prompt = JSON.parse(String(init?.body)).prompt;
      } else {
        assert.equal(url, "https://api.openai.com/v1/images/edits");
        assert.ok(init?.body instanceof FormData);
        const references = init.body.getAll("image[]");
        assert.equal(references.length, 1);
        const reference = references[0];
        assert.ok(reference instanceof File);
        assert.deepEqual(Buffer.from(await reference.arrayBuffer()), png);
        prompt = init.body.get("prompt");
      }
      appendFileSync(join(ctx.cwd, "image-requests.jsonl"), JSON.stringify({ url, prompt }) + "\n");
      return Response.json({ data: [{ b64_json: png.toString("base64") }] });
    };
  });
  pi.on("session_shutdown", () => { globalThis.fetch = originalFetch; });
}
