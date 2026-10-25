import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { PNG } from "pngjs";

const project = resolve(import.meta.dirname, "../..");

test("installed Pi reads the skill, generates raster artwork, then edits its original on the conversation branch", { timeout: 240_000 }, async () => {
  const model = process.env.EVERGREEN_E2E_MODEL;
  assert.ok(model, "Set EVERGREEN_E2E_MODEL to a configured Pi model (live model calls are required).");
  const root = await mkdtemp(join(tmpdir(), "imagegen-e2e-"));
  const agentDir = join(root, "agent");
  const cwd = join(root, "project");
  try {
    await mkdir(agentDir);
    await mkdir(cwd);
    // Isolate settings/resources/sessions, but retain the operator's model login and catalog.
    // Never print credential files; Pi may refresh this disposable copy.
    for (const name of ["auth.json", "models.json", "models-store.json"]) {
      try { await copyFile(join(getAgentDir(), name), join(agentDir, name)); }
      catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
    }
    await writeFile(join(agentDir, "pi-image-generation-settings.json"), JSON.stringify({ apiKey: "evergreen-fake-image-key" }));
    const result = spawnSync(process.env.EVERGREEN_PI_BIN || "pi", [
      "--print", "--mode", "json", "--model", model,
      "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-mcp",
      "--extension", join(project, "test/fixtures/image-service.ts"),
      "--extension", project, "--tools", "read,image_gen", "--session-dir", join(root, "sessions"),
      "Generate a raster illustration of a ceramic robot watering a fern, with transparency. " +
      "First read the imagegen skill. Use image_gen to save robot.png. " +
      "Then make exactly one edit with image_gen: change only the watering can to blue, " +
      "preserving the robot, fern, pose, composition and transparency. Use num_last_images_to_include: 1 " +
      "and save robot-v2.png. This is a tool integration test; image responses are tiny fixtures, " +
      "so do not retry or attempt to improve them. Report both saved paths. Do not use SVG or code substitutes.",
    ], { cwd, env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1" },
      stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", timeout: 210_000, maxBuffer: 8 * 1024 * 1024 });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr + result.stdout);
    const events: unknown[] = result.stdout.trim().split("\n").map(line => JSON.parse(line));
    const records = events.filter((event): event is Record<string, unknown> => event !== null && typeof event === "object");
    const starts = records.filter(event => event.type === "tool_execution_start");
    const calls = starts.filter(event => event.toolName === "image_gen");
    assert.equal(calls.length, 2, result.stdout);
    const readSkill = starts.findIndex(event => event.toolName === "read" && /imagegen[/\\]SKILL\.md/.test(JSON.stringify(event.args)));
    assert.ok(readSkill >= 0 && readSkill < starts.indexOf(calls[0]), "skill must be read before generation");
    assert.ok(records.filter(event => event.type === "tool_execution_end" && event.toolName === "image_gen")
      .every(event => event.isError === false), result.stdout);
    const requests = (await readFile(join(cwd, "image-requests.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
    assert.deepEqual(requests.map(request => request.url), [
      "https://api.openai.com/v1/images/generations", "https://api.openai.com/v1/images/edits",
    ]);
    assert.match(JSON.stringify(calls[1].args), /"num_last_images_to_include":1/);
    const original = await readFile(join(cwd, "robot.png"));
    assert.deepEqual(await readFile(join(cwd, "robot-v2.png")), original);
    assert.equal(PNG.sync.read(original).data[3], 127);
    assert.doesNotMatch(result.stdout + result.stderr, /evergreen-fake-image-key/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
