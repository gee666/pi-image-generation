import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { PNG } from "pngjs";
import {
  createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
} from "@earendil-works/pi-coding-agent";

const project = resolve(import.meta.dirname, "..");

test("Pi dispatch preserves a generated original across recent-image edits and credential changes", async () => {
  const root = await mkdtemp(join(tmpdir(), "imagegen-workflow-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const originalFetch = globalThis.fetch;
  process.env.PI_CODING_AGENT_DIR = root;
  const settingsPath = join(root, "pi-image-generation-settings.json");
  const fixture = new PNG({ width: 2, height: 1 });
  fixture.data = Buffer.from([0, 128, 255, 127, 255, 0, 0, 0]);
  const png = PNG.sync.write(fixture);
  let calls = 0;
  globalThis.fetch = async (url, init) => {
    calls++;
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer test-workflow-key");
    if (calls === 1) {
      assert.equal(url, "https://api.openai.com/v1/images/generations");
      assert.equal(JSON.parse(String(init?.body)).prompt, "A transparent robot");
    } else {
      assert.equal(calls, 2, "no retries or fallback requests");
      assert.equal(url, "https://api.openai.com/v1/images/edits");
      assert.ok(init?.body instanceof FormData);
      const reference = init.body.get("image[]");
      assert.ok(reference instanceof File);
      assert.deepEqual(Buffer.from(await reference.arrayBuffer()), png);
      assert.equal(init.body.get("prompt"), "Change only the watering can to blue");
    }
    return Response.json({ data: [{ b64_json: png.toString("base64") }] });
  };
  try {
    await writeFile(settingsPath, JSON.stringify({ apiKey: "test-workflow-key" }));
    const settingsManager = SettingsManager.inMemory({ packages: [project] });
    const resourceLoader = new DefaultResourceLoader({ cwd: root, agentDir: root, settingsManager });
    await resourceLoader.reload();
    assert.deepEqual(resourceLoader.getExtensions().errors, []);
    const modelRuntime = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null,
      modelsStorePath: join(root, "models-store.json"), allowModelNetwork: false });
    const sessionManager = SessionManager.inMemory(root);
    // A nested tool dispatch belongs to an assistant-issued parent call.
    sessionManager.appendMessage({ role: "assistant", api: "openai-responses", provider: "openai", model: "test",
      content: [{ type: "toolCall", id: "workflow", name: "workflow", arguments: {} }], stopReason: "toolUse", timestamp: 0,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
    const { session } = await createAgentSession({ cwd: root, agentDir: root, settingsManager,
      resourceLoader, modelRuntime, sessionManager });
    try {
      await session.bindExtensions({});
      assert.ok(resourceLoader.getSkills().skills.some(skill => skill.name === "imagegen"));
      const ctx = session.extensionRunner.createToolContext("workflow", undefined);
      const first = await ctx.executeTool("image_gen", { prompt: "A transparent robot", output_path: "robot.png" });
      assert.equal(first.isError, false, JSON.stringify(first.result));
      assert.ok(first.result.content.some(block => block.type === "image"));
      assert.deepEqual(await readFile(join(root, "robot.png")), png);
      sessionManager.appendMessage({ role: "toolResult", toolCallId: "first", toolName: "image_gen", isError: false,
        content: [{ type: "image", data: "not-the-original", mimeType: "image/png" }], details: first.result.details, timestamp: 1 });
      const edited = await ctx.executeTool("image_gen", { prompt: "Change only the watering can to blue",
        num_last_images_to_include: 1, output_path: "robot-v2.png" });
      assert.equal(edited.isError, false, JSON.stringify(edited.result));
      assert.deepEqual(await readFile(join(root, "robot-v2.png")), png);
      assert.deepEqual(await readFile(join(root, "robot.png")), png);
      const collision = await ctx.executeTool("image_gen", { prompt: "Another robot", output_path: "robot.png" });
      assert.equal(collision.isError, true);
      await writeFile(settingsPath, '{"apiKey":"SECRET');
      const disabled = await ctx.executeTool("image_gen", { prompt: "Another robot" });
      assert.equal(disabled.isError, true);
      assert.doesNotMatch(JSON.stringify(disabled), /SECRET|test-workflow-key/);
      assert.equal(calls, 2, "invalid settings and existing destinations must fail before upload");
    } finally {
      session.dispose();
    }
  } finally {
    globalThis.fetch = originalFetch;
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(root, { recursive: true, force: true });
  }
});
