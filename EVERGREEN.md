## Summary
- Generate and reference-edit raster artwork inside Pi, saving original PNGs and returning previews.
- Default to the Codex subscription; explicit settings select an OpenAI provider or paid API key without fallback.
- Gate `image_gen` and the `imagegen` skill on credentials and trusted-project settings.
- Use Pi lifecycle, tool, credential, branch-history, image-resize, and file-mutation APIs.
- No internal Pi imports; low-level exported helpers and session/tool-result shapes remain compatibility risks.
- The undocumented ChatGPT image backend, provider auth changes, and live model behavior are the main weak points.

## Intent
Keep image creation and iterative edits in the current conversation, regardless of
its model provider. Reuse originals (not previews), preserve PNG alpha, and never
overwrite an existing artifact. Do not silently switch accounts, retry billable
requests, or substitute SVG/code for requested raster artwork.
History: initial subscription tool/skill (629324c), configurable credentials and
trust-aware whole-file overrides (3e2d6b9), host peer dependencies (68d2aed).

## Pi integration (public APIs)
The package manifest loads `src/index.ts`; the skill is discovered dynamically.
`session_start`, `registerTool`, and `resources_discover` control availability.
Tool schemas use TypeBox. Context supplies cwd, project trust, warnings,
`modelRegistry.getProviderAuthStatus/getProviderAuth/getProvider`, and
`sessionManager.getBranch()`. Pi owns OAuth refresh, locking, and persistence.
Root exports `readStoredCredential`, `getAgentDir`, `CONFIG_DIR_NAME`,
`resizeImage`, and `withFileMutationQueue` support auth, settings, previews,
and exclusive output writes. `/reload` refreshes tool/skill availability.

## Internal Pi APIs
No private/deep imports or undocumented internal Pi APIs are used by runtime code.
Some root-exported helpers above have little narrative documentation; track their
signatures and behavior. Recent-image selection relies on session entry shapes
and this extension's `toolResult.details.savedPath` convention.
Tests additionally use exported SDK loaders, sessions, runtimes, and runners.

## Weak points
ChatGPT `/backend-api/codex/images/*` is an undocumented external backend, not a
Pi internal API. JWT routing claims and provider origin/auth resolution can change.
Paid requests use fixed OpenAI Images endpoints; there is no service fallback.
Compaction may remove recent references; explicit artifact paths are safer.
Timeouts or transport failures can still consume allowance. Preview availability
depends on Pi resizing; the original file is the durable deliverable.

## Tests
`npm run test:evergreen` runs latest-Pi installation/typecheck, unit and integration
tests (`npm test`), then real-CLI e2e (`npm run test:e2e`). No lint is configured.
Existing tests protect credential isolation, trust, dynamic skill discovery,
request limits, branch selection, non-overwrite behavior, PNG bytes, and alpha.
`test/workflow.integration.test.ts` exercises real Pi loading and tool dispatch:
generate → recent-original edit, previews, retained originals, and fail-closed
settings changes/collisions before another upload.
`test/e2e/cli.test.ts` runs `$EVERGREEN_PI_BIN` (or `pi` on PATH), stdin ignored,
with `$EVERGREEN_E2E_MODEL`. It checks skill reading before tool use, generation,
recent-image editing, saved PNGs, and alpha. Model credentials/catalog are copied
to a disposable agent directory; model calls are live and sessions are retained
until cleanup. Only image responses are mocked: no image charges or quality test.

## Relevant changelog topics
Watch tool registration/dispatch and lifecycle ordering, resource discovery and
skill commands, project trust/config paths, provider credential resolution and
OAuth refresh, session branch/message formats, resizeImage, file mutation queues,
and CLI JSON events/model selection. Tested against Pi 1.4.0.
