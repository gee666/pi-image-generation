import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { type ExtensionAPI, type ExtensionContext, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { hasImageAuth, resolveImageAuth } from "../src/auth.ts";
import imageGeneration from "../src/index.ts";
import { loadImageSettings, SETTINGS_FILE } from "../src/settings.ts";

let root: string;
let cwd: string;
let agentDir: string;
const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
const access = `test.${Buffer.from(JSON.stringify({
  "https://api.openai.com/auth": { chatgpt_account_id: "alias-account" },
})).toString("base64url")}.signature`;
const credential = { type: "oauth", access, refresh: "refresh-secret", expires: Date.now() + 3600000 };
const configuredRegistry = { getProviderAuthStatus: () => ({ configured: true }) };

before(async () => {
  root = await mkdtemp(join(tmpdir(), "imagegen-settings-"));
  cwd = join(root, "project");
  agentDir = join(root, "global-agent");
  await mkdir(agentDir);
  await mkdir(join(cwd, ".pi", "agent"), { recursive: true });
  process.env.PI_CODING_AGENT_DIR = agentDir;
});
beforeEach(async () => {
  for (const path of [join(agentDir, SETTINGS_FILE), join(cwd, ".pi", SETTINGS_FILE), join(cwd, ".pi", "agent", SETTINGS_FILE), join(agentDir, "auth.json")]) {
    await rm(path, { force: true, recursive: true });
  }
});
after(async () => {
  if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
  await rm(root, { force: true, recursive: true });
});
const globalSettings = (value: unknown) => writeFile(join(agentDir, SETTINGS_FILE), JSON.stringify(value));
const auth = (value: unknown) => writeFile(join(agentDir, "auth.json"), JSON.stringify(value));

test("missing settings preserve default; local files replace global rather than merging credentials", async () => {
  assert.equal(await loadImageSettings(cwd, true), undefined);
  await globalSettings({ apiKey: "global-key" });
  assert.deepEqual(await loadImageSettings(cwd, true), { apiKey: "global-key" });
  await writeFile(join(cwd, ".pi", SETTINGS_FILE), JSON.stringify({ provider: " openai-dmitry " }));
  assert.deepEqual(await loadImageSettings(cwd, true), { provider: "openai-dmitry" });
  await writeFile(join(cwd, ".pi", "agent", SETTINGS_FILE), JSON.stringify({ apiKey: "local-key" }));
  assert.deepEqual(await loadImageSettings(cwd, true), { apiKey: "local-key" });
  assert.deepEqual(await loadImageSettings(cwd, false), { apiKey: "global-key" });
  // Settings are re-read rather than cached.
  await rm(join(cwd, ".pi", "agent", SETTINGS_FILE));
  assert.deepEqual(await loadImageSettings(cwd, true), { provider: "openai-dmitry" });
});

test("invalid settings fail closed and never echo secret values or parser excerpts", async () => {
  for (const value of [null, [], {}, { provider: "" }, { apiKey: "  " }, { provider: 1 },
    { provider: "openai-dmitry", apiKey: "SECRET" }, { api_key: "SECRET" }]) {
    await globalSettings(value);
    await assert.rejects(loadImageSettings(cwd, true), error => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /exactly one/);
      assert.doesNotMatch(error.message, /SECRET/);
      return true;
    });
  }
  await globalSettings({ provider: "openai-dmitry" });
  await writeFile(join(cwd, ".pi", SETTINGS_FILE), '{"apiKey":"SECRET');
  await assert.rejects(loadImageSettings(cwd, true), error => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /Invalid JSON/);
    assert.doesNotMatch(error.message, /SECRET/);
    return true;
  });
  await rm(join(cwd, ".pi", SETTINGS_FILE));
  await mkdir(join(cwd, ".pi", SETTINGS_FILE));
  await assert.rejects(loadImageSettings(cwd, true), /Cannot read/);
});

test("named subscription uses only the selected provider and delegates refresh to pi", async () => {
  await auth({ "openai-dmitry": credential });
  const settings = { provider: "openai-dmitry" };
  assert.equal(hasImageAuth(settings, configuredRegistry), true);
  const refreshed = access + "-refreshed";
  const result = await resolveImageAuth({ getProviderAuth: async provider => {
    assert.equal(provider, "openai-dmitry");
    await auth({ "openai-dmitry": { ...credential, access: refreshed } });
    return { auth: { apiKey: refreshed, baseUrl: "https://chatgpt.com/backend-api" } };
  } }, settings);
  assert.deepEqual(result, { accessToken: refreshed, accountId: "alias-account" });
  await assert.rejects(resolveImageAuth({ getProviderAuth: async () => ({ auth: { apiKey: "OTHER-KEY", baseUrl: "https://chatgpt.com/backend-api" } }) }, settings), /not an API key or override/);
  await assert.rejects(resolveImageAuth({ getProviderAuth: async () => { throw new Error("SECRET"); } }, settings), error => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /openai-dmitry/);
    assert.doesNotMatch(error.message, /SECRET|openai-codex/);
    return true;
  });
});

test("explicit API key bypasses registry and named API provider uses pi auth resolution", async () => {
  await auth({ "openai-codex": credential });
  assert.deepEqual(await resolveImageAuth({ getProviderAuth: async () => assert.fail("must not resolve provider") }, { apiKey: "paid-key" }), { apiKey: "paid-key" });
  assert.equal(hasImageAuth({ apiKey: "paid-key" }, configuredRegistry), true);
  assert.deepEqual(await resolveImageAuth({ getProviderAuth: async provider => {
    assert.equal(provider, "openai");
    return { auth: { apiKey: "provider-key", baseUrl: "https://api.openai.com/v1" } };
  } }, { provider: "openai" }), { apiKey: "provider-key" });
  await assert.rejects(resolveImageAuth({ getProviderAuth: async provider => {
    assert.equal(provider, "missing");
    return undefined;
  } }, { provider: "missing" }), /no missing provider/);
});

test("named providers cannot leak non-OpenAI credentials to fixed image endpoints", async () => {
  for (const baseUrl of [undefined, "https://api.anthropic.com", "https://api.openai.com.evil.test/v1", "http://api.openai.com/v1"]) {
    await assert.rejects(resolveImageAuth({ getProviderAuth: async () => ({ auth: { apiKey: "SECRET", baseUrl } }) },
      { provider: "other-provider" }), error => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /not configured for a supported OpenAI endpoint/);
      assert.doesNotMatch(error.message, /SECRET/);
      return true;
    });
  }
});

async function capture(trusted = true) {
  const tools: ToolDefinition[] = [];
  const handlers = new Map<string, (event: any, ctx: any) => any>();
  const warnings: string[] = [];
  imageGeneration({
    registerTool: (tool: ToolDefinition) => tools.push(tool),
    on: (event: string, handler: (event: any, ctx: any) => any) => handlers.set(event, handler),
  } as unknown as ExtensionAPI);
  const ctx = {
    cwd, isProjectTrusted: () => trusted, hasUI: true,
    ui: { notify: (message: string) => warnings.push(message) },
    modelRegistry: { getProviderAuthStatus: () => ({ configured: false }) },
  } as unknown as ExtensionContext;
  await handlers.get("session_start")!({}, ctx);
  return { tools, warnings, resources: await handlers.get("resources_discover")!({}, ctx) };
}

test("registration honors global alias, API key, project-only settings, and trust", async () => {
  await auth({ "openai-dmitry": credential });
  await globalSettings({ provider: "openai-dmitry" });
  let result = await capture();
  assert.equal(result.tools.length, 1);
  assert.equal(result.resources.skillPaths.length, 1);
  assert.deepEqual(result.warnings, []);
  await globalSettings({ apiKey: "paid-key" });
  await auth({});
  assert.equal((await capture()).tools.length, 1);
  await rm(join(agentDir, SETTINGS_FILE));
  await writeFile(join(cwd, ".pi", SETTINGS_FILE), JSON.stringify({ apiKey: "local-key" }));
  assert.equal((await capture()).tools.length, 1);
  assert.equal((await capture(false)).tools.length, 0);
  await writeFile(join(cwd, ".pi", SETTINGS_FILE), '{"apiKey":"SECRET');
  result = await capture();
  assert.equal(result.tools.length, 0);
  assert.deepEqual(result.resources.skillPaths, []);
  assert.match(result.warnings[0], /Invalid JSON/);
  assert.doesNotMatch(result.warnings[0], /SECRET/);
});
