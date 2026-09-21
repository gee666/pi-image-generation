import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { after, before, test } from "node:test";
import { PNG } from "pngjs";
import {
  createAgentSession, DefaultResourceLoader, ModelRegistry, ModelRuntime, SessionManager, SettingsManager,
  type ExtensionAPI, type ExtensionContext, type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import imageGeneration from "../src/index.ts";
import { hasSubscription, OFF_WARNING, resolveImageAuth } from "../src/auth.ts";
import { decodePng, requestImage } from "../src/backend.ts";
import { imagePath, loadReferences, prepareOutput, recentReferences, saveImage } from "../src/images.ts";
import { loadImageSettings, SETTINGS_FILE } from "../src/settings.ts";

const project = resolve(import.meta.dirname, "..");
let root: string;
const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
const oldOffline = process.env.PI_OFFLINE;
const jwt = (id: string) => `test.${Buffer.from(JSON.stringify({
  exp: Math.floor(Date.now() / 1000) + 3600,
  "https://api.openai.com/auth": { chatgpt_account_id: id },
})).toString("base64url")}.signature`;
const access = jwt("test-account");
const credential = { type: "oauth", access, refresh: "test-refresh", expires: Date.now() + 3600000, accountId: "test-account" };
const fixture = new PNG({ width: 1, height: 1 });
fixture.data = Buffer.from([0, 128, 255, 127]);
const png = PNG.sync.write(fixture);
const base64 = png.toString("base64");
const imageResponse = () => Response.json({ data: [{ b64_json: base64 }] });
const signal = () => AbortSignal.timeout(5000);

async function auth(value: unknown) {
  await writeFile(join(root, "auth.json"), JSON.stringify(value));
}

before(async () => {
  await mkdir(join(project, "tmp"), { recursive: true });
  root = await mkdtemp(join(project, "tmp", "test-"));
  process.env.PI_CODING_AGENT_DIR = root;
  process.env.PI_OFFLINE = "1";
});
after(async () => {
  if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
  if (oldOffline === undefined) delete process.env.PI_OFFLINE;
  else process.env.PI_OFFLINE = oldOffline;
  await rm(root, { recursive: true, force: true });
});

async function capture(overrides: Record<string, unknown> = {}) {
  const tools: ToolDefinition[] = [];
  const handlers = new Map<string, (event: any, ctx: any) => any>();
  const api = {
    registerTool: (tool: ToolDefinition) => tools.push(tool),
    on: (event: string, handler: (event: any, ctx: any) => any) => {
      handlers.set(event, handler);
      return () => handlers.delete(event);
    },
  } as unknown as ExtensionAPI;
  imageGeneration(api);
  const warnings: string[] = [];
  const ctx = {
    cwd: root, isProjectTrusted: () => true, hasUI: true,
    modelRegistry: { getProviderAuthStatus: () => ({ configured: false }) },
    ui: { notify: (message: string, level: string) => {
      assert.equal(level, "warning"); warnings.push(message);
    } },
    ...overrides,
  };
  await handlers.get("session_start")!({}, ctx);
  return { tools, handlers, warnings, ctx };
}

test("missing, malformed and API-key credentials register neither tool nor skill", async () => {
  for (const config of [{}, { anthropic: { type: "api_key", key: "fake" } },
    { "openai-codex": { type: "api_key", key: "fake" } }, { "openai-codex": { type: "oauth" } }]) {
    await auth(config);
    assert.equal(hasSubscription(), false);
    const { tools, handlers, warnings, ctx } = await capture();
    assert.equal(tools.length, 0);
    assert.deepEqual(await handlers.get("resources_discover")!({}, ctx), { skillPaths: [] });
    assert.deepEqual(warnings, [OFF_WARNING]);
  }
  await writeFile(join(root, "auth.json"), "broken json");
  assert.equal((await capture()).tools.length, 0);
});

test("OAuth registers tool and dynamically discovers skill independently of the active model", async () => {
  await auth({ "openai-codex": credential });
  const { tools, handlers, ctx } = await capture();
  assert.equal(tools[0].name, "image_gen");
  for (const provider of ["anthropic", "google", "openai-codex"]) {
    const resources = await handlers.get("resources_discover")!({}, { ...ctx, model: { provider } });
    assert.match(resources.skillPaths[0], /resources[/\\]imagegen[/\\]SKILL.md$/);
    assert.match(await readFile(resources.skillPaths[0], "utf8"), /name: imagegen/);
  }
  await auth({});
  assert.deepEqual(await handlers.get("resources_discover")!({}, ctx), { skillPaths: [] });
});

test("host refresh supplies auth and persists it; extension rejects other credentials", async () => {
  await auth({ "openai-codex": credential });
  const updated = jwt("refreshed-account");
  const result = await resolveImageAuth({ getProviderAuth: async provider => {
    assert.equal(provider, "openai-codex");
    await auth({ "openai-codex": { ...credential, access: updated } });
    return { auth: { apiKey: updated } };
  } });
  assert.deepEqual(result, { accessToken: updated, accountId: "refreshed-account" });
  await assert.rejects(resolveImageAuth({ getProviderAuth: async () => ({ auth: { apiKey: "paid-key" } }) }), /not an API key/);
  await assert.rejects(resolveImageAuth({ getProviderAuth: async () => { throw new Error("SECRET token"); } }), error => {
    assert.ok(error instanceof Error);
    assert.doesNotMatch(error.message, /SECRET/);
    return true;
  });
  await auth({});
  await assert.rejects(resolveImageAuth({ getProviderAuth: async () => { throw new Error("must not run"); } }), /image generation is off/);
});

test("backend makes exactly one subscription request for generation or editing", async () => {
  for (const images of [undefined, [`data:image/png;base64,${base64}`]]) {
    let calls = 0;
    const output = await requestImage({ accessToken: "secret", accountId: "account" }, { prompt: "test", images }, signal(), async (url, init) => {
      calls++;
      assert.equal(url, `https://chatgpt.com/backend-api/codex/images/${images ? "edits" : "generations"}`);
      assert.equal(init?.redirect, "error");
      assert.equal(init?.method, "POST");
      const headers = new Headers(init?.headers);
      assert.equal(headers.get("Authorization"), "Bearer secret");
      assert.equal(headers.get("ChatGPT-Account-ID"), "account");
      const body = JSON.parse(String(init?.body));
      assert.equal(body.model, "gpt-image-2");
      assert.equal(body.background, "auto");
      assert.deepEqual(body.images, images?.map(image_url => ({ image_url })));
      return imageResponse();
    });
    assert.equal(calls, 1);
    assert.deepEqual(output.bytes, png);
    assert.equal(PNG.sync.read(output.bytes).data[3], 127);
  }
});

test("backend failures never echo secrets or retry", async () => {
  for (const status of [400, 401, 403, 404, 429, 500]) {
    let calls = 0;
    await assert.rejects(requestImage({ accessToken: "SECRET", accountId: "ACCOUNT" }, { prompt: "test" }, signal(), async () => {
      calls++;
      return new Response("SECRET ACCOUNT sensitive prompt", { status });
    }), error => {
      assert.ok(error instanceof Error);
      assert.match(error.message, new RegExp(`HTTP ${status}`));
      assert.doesNotMatch(error.message, /SECRET|ACCOUNT|sensitive prompt/);
      return true;
    });
    assert.equal(calls, 1);
  }
  await assert.rejects(requestImage({ accessToken: "secret", accountId: "id" }, { prompt: "test" }, signal(), async () => {
    throw new Error("secret in transport");
  }), /connection failed/);
});

test("cancellation, oversized bodies and invalid image payloads fail safely", async () => {
  const stopped = AbortSignal.abort();
  await assert.rejects(requestImage({ accessToken: "x", accountId: "y" }, { prompt: "test" }, stopped, async () => {
    assert.fail("fetch must not run");
  }), /abort/i);
  const controller = new AbortController();
  const pending = requestImage({ accessToken: "x", accountId: "y" }, { prompt: "test" }, controller.signal, async (_url, init) => {
    return new Promise((_, reject) => init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason)));
  });
  controller.abort();
  await assert.rejects(pending, /abort/i);
  for (const response of [
    Response.json({ data: [] }),
    Response.json({ data: [{ b64_json: "invalid" }] }),
    new Response("{}", { headers: { "content-length": String(100 * 1024 * 1024) } }),
  ]) {
    await assert.rejects(requestImage({ accessToken: "x", accountId: "y" }, { prompt: "test" }, signal(), async () => response));
  }
  const corrupt = Buffer.alloc(24);
  png.copy(corrupt, 0, 0, 24);
  assert.throws(() => decodePng(corrupt.toString("base64")), /corrupt PNG/);
});

test("references preserve order, use original generated files and exclude abandoned branches", async () => {
  const path = join(root, "reference.png");
  await writeFile(path, png);
  const sm = SessionManager.inMemory(root);
  const first = sm.appendMessage({ role: "user", content: [{ type: "image", data: base64, mimeType: "image/png" }], timestamp: 1 });
  sm.appendMessage({ role: "user", content: [{ type: "image", data: "abandoned", mimeType: "image/png" }], timestamp: 2 });
  sm.branch(first);
  sm.appendMessage({ role: "toolResult", toolCallId: "id", toolName: "image_gen", isError: false,
    content: [{ type: "image", data: "preview-not-original", mimeType: "image/png" }], details: { savedPath: path }, timestamp: 3 });
  assert.deepEqual(recentReferences(sm.getBranch(), 2), [{ base64 }, { path }]);
  const images = await loadReferences(undefined, 2, sm.getBranch(), root, signal());
  assert.deepEqual(images, [`data:image/png;base64,${base64}`, `data:image/png;base64,${base64}`]);
  assert.equal((await loadReferences(["@reference.png"], undefined, [], root, signal())).length, 1);
  assert.equal(imagePath("@reference.png", root), path);
  await assert.rejects(loadReferences([path], 1, [], root, signal()), /not both/);
  await assert.rejects(loadReferences([], undefined, [], root, signal()), /between 1 and 5/);
  await assert.rejects(loadReferences(undefined, 6, [], root, signal()), /between 1 and 5/);
  assert.throws(() => recentReferences(sm.getBranch(), 3), /only 2/);
  const textPath = join(root, "not-image.png");
  await writeFile(textPath, "hello");
  await assert.rejects(loadReferences([textPath], undefined, [], root, signal()), /PNG, JPEG, or WebP/);
});

test("FIFO references are rejected without blocking", { skip: process.platform === "win32", timeout: 3000 }, async () => {
  const fifo = join(root, "fifo.png");
  execFileSync("mkfifo", [fifo], { timeout: 1000 });
  await assert.rejects(loadReferences([fifo], undefined, [], root, signal()), /regular files/);
});

test("output is exclusive, PNG-only and race-safe", async () => {
  const path = await prepareOutput(root, "nested/output.png");
  const results = await Promise.allSettled([saveImage(path, png), saveImage(path, png)]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  assert.deepEqual(await readFile(path), png);
  await assert.rejects(prepareOutput(root, "nested/output.png"), /already exists/);
  await assert.rejects(prepareOutput(root, "output.jpg"), /end in .png/);
});

test("tool executes with an Anthropic context, persists the PNG and returns an image preview", async () => {
  await auth({ "openai-codex": credential });
  const tool = (await capture()).tools[0];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => imageResponse();
  try {
    const ctx = {
      cwd: root,
      isProjectTrusted: () => true,
      model: { provider: "anthropic" },
      sessionManager: SessionManager.inMemory(root),
      modelRegistry: { getProviderAuth: async (provider: string) => {
        assert.equal(provider, "openai-codex");
        return { auth: { apiKey: access } };
      } },
    } as unknown as ExtensionContext;
    const result = await tool.execute("test", { prompt: "A robot", output_path: "tool-output.png" }, undefined, undefined, ctx);
    assert.deepEqual(await readFile(join(root, "tool-output.png")), png);
    assert.ok(result.content.some(block => block.type === "image"));
    assert.doesNotMatch(JSON.stringify(result), /test-refresh|test-account|signature/);
    await auth({});
    await assert.rejects(tool.execute("test", { prompt: "A robot" }, undefined, undefined, ctx), /image generation is off/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("real pi package loader gates tool and skill and registers the skill command", async () => {
  for (const scenario of ["disabled", "default", "alias", "project-key"] as const) {
    const enabled = scenario !== "disabled";
    await auth(scenario === "default" ? { "openai-codex": credential }
      : scenario === "alias" ? { "openai-dmitry": credential } : {});
    if (scenario === "alias") await writeFile(join(root, SETTINGS_FILE), JSON.stringify({ provider: "openai-dmitry" }));
    if (scenario === "project-key") {
      await mkdir(join(root, ".pi"), { recursive: true });
      await writeFile(join(root, ".pi", SETTINGS_FILE), JSON.stringify({ apiKey: "project-key" }));
    }
    const settings = SettingsManager.inMemory({ packages: [project], defaultProvider: "anthropic" });
    let commands: () => { name: string }[] = () => [];
    const loader = new DefaultResourceLoader({ cwd: root, agentDir: root, settingsManager: settings,
      extensionFactories: [pi => {
        commands = () => pi.getCommands();
        pi.registerProvider("openai-dmitry", {
          baseUrl: "https://chatgpt.com/backend-api",
          api: "openai-codex-responses",
          models: [],
          oauth: {
            name: "Test Codex alias",
            login: async () => credential,
            refreshToken: async value => value,
            getApiKey: value => value.access,
          },
        });
      }] });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    assert.equal(loader.getSkills().skills.some(skill => skill.name === "imagegen"), false, "no static skill loading");
    const runtime = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null,
      modelsStorePath: join(root, "models-store.json"), allowModelNetwork: false });
    const { session } = await createAgentSession({ cwd: root, agentDir: root, resourceLoader: loader,
      settingsManager: settings, modelRuntime: runtime, sessionManager: SessionManager.inMemory(root) });
    try {
      await session.bindExtensions({});
      assert.equal(session.getAllTools().some(tool => tool.name === "image_gen"), enabled);
      assert.equal(loader.getSkills().skills.some(skill => skill.name === "imagegen"), enabled);
      assert.equal(commands().some(command => command.name === "skill:imagegen"), enabled);
      if (scenario === "alias" || scenario === "project-key") {
        const imageAuth = await resolveImageAuth(new ModelRegistry(runtime), await loadImageSettings(root, true));
        assert.deepEqual(imageAuth, scenario === "alias"
          ? { accessToken: access, accountId: "test-account" } : { apiKey: "project-key" });
      }
    } finally {
      session.dispose();
      await rm(join(root, SETTINGS_FILE), { force: true });
      await rm(join(root, ".pi", SETTINGS_FILE), { force: true });
    }
  }
});

test("package metadata and README document installation and settings", async () => {
  const manifest = JSON.parse(await readFile(join(project, "package.json"), "utf8"));
  assert.equal(manifest.name, "oira666_pi-image-generation");
  assert.equal(manifest.version, "0.0.2");
  assert.deepEqual(manifest.pi.skills, []);
  const readme = await readFile(join(project, "README.md"), "utf8");
  assert.match(readme, /pi install npm:oira666_pi-image-generation/);
  assert.match(readme, /pi-image-generation-settings\.json/);
});
