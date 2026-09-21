---
name: imagegen
description: Generate and edit raster images with image_gen, including photos, illustrations, textures, sprites, product shots, mockups, and consistent visual variants. Use reference images to preserve identity, style, composition, or objects across edits. Prefer native edits instead when extending existing SVG, vector, HTML, CSS, or canvas assets.
---

# Image generation

Use `image_gen` for new raster artwork, image edits, and variations. The tool is available to the current pi model regardless of its provider. It uses the OpenAI provider or API key selected in `pi-image-generation-settings.json`, defaulting to the Codex subscription. Do not launch another Codex agent, request secrets in chat, or switch accounts or services as a fallback.

## Choose the right operation

- New image without references: supply `prompt`.
- New image guided by existing images: supply `prompt` and reference images. Describe each reference as a style, identity, composition, or mood guide. The tool uses its image-edit endpoint for any request with references, even when the creative intent is a new scene.
- Edit an existing image: supply references and specify exactly what changes and what stays fixed.
- Several assets: make one call per asset. For a coherent series, establish an approved reference first and reuse it. Avoid generating every asset independently when consistency matters.
- Existing vector icon sets, logos, simple diagrams, or code-native visuals: edit their native files when that better fits the task. Do not replace requested raster art with SVG placeholders.

## Tool arguments

- `prompt`: a complete brief, up to 16,000 characters. Include exact text, reference roles, required details, and exclusions.
- `referenced_image_paths`: one to five local PNG, JPEG, or WebP paths, in the same order used by the prompt. Relative paths use the project directory. These are uploaded to the image service for the requested edit.
- `num_last_images_to_include`: one to five recent images from the current conversation branch. The selected images are supplied oldest first. This includes user attachments, images read by tools, and generated images. Unrelated recent images can enter this window, so explicit paths are safer for long workflows.
- `output_path`: an optional new `.png` file path. Otherwise a unique file is saved under `output/imagegen/` in the current project.

Choose either `referenced_image_paths` or `num_last_images_to_include`, never both. Do not pass an empty reference list. References must be at most 32 MiB each and 50 MiB combined. The tool accepts local paths, not arbitrary remote URLs.

There are no separate model, size, quality, seed, mask, or batch arguments. Put framing, proportions, detail, and transparency requirements in the prompt. Do not promise exact dimensions, reproducible seeds, or pixel-perfect preservation. The backend decides the output dimensions and quality.

## Workflow

1. Identify whether this is new artwork, reference-guided generation, or an edit. Determine the intended use and destination.
2. Collect the brief, literal text, must-keep details, and any references. Ask only when a missing detail blocks the task.
3. Inspect local references with `read` before composing an edit. Label them by index and role in the prompt, such as `Image 1: edit target; Image 2: character identity reference`.
4. Preserve detailed user instructions. For a vague brief, add useful framing, materials, or lighting, but do not invent brands, characters, props, slogans, or story requirements.
5. Make an `image_gen` call. Prefer meaningful output filenames. Never overwrite a source image or an existing deliverable; choose a sibling filename such as `hero-v2.png`.
6. Inspect the returned preview against the request. If necessary, use `read` to inspect the saved file. Check the subject, composition, text, identity, and constraints. A model without vision must not claim it visually inspected the output; ask the user to assess it instead.
7. If correction is needed, use the output as an edit reference and request one specific change. Repeat the must-keep constraints. Do not generate excessive variants or retry failed requests automatically; each call can consume image allowance.
8. Keep the final asset in the project, update consuming code when requested, and report the saved path and final prompt. A failed custom save can fall back to `output/imagegen/`; use the path actually returned by the tool.

## Keeping images consistent

Consistency comes from explicit visual references and a repeated brief, not hidden memory between image requests. The pi model plans the request, inspects outputs, and chooses the next edit. The image service receives only the prompt and selected references, not the whole pi conversation.

For a character, product, or illustration series:

1. Establish an anchor image and retain its saved path.
2. Write a short visual specification covering the important proportions, features, materials, palette, and drawing style.
3. Include the anchor in later requests. For a local correction, include the latest version as the edit target and optionally the anchor as the identity/style reference.
4. Give each image a distinct role. For example, `Image 1: current scene to edit. Image 2: approved robot design; preserve its head shape, eye spacing, ceramic finish, and joint proportions`.
5. Explicitly separate allowed changes from invariants. For example, `Change only the watering can to blue. Keep the robot, pose, fern, lighting, framing, and watercolor texture unchanged`.
6. Compare each result with the anchor. If repeated edits drift, return to the anchor and describe the desired scene again.

Full-resolution generated files are reused for recent-image edits, rather than the resized preview. The current branch controls which recent images are eligible, so abandoned forks are not used. Explicit paths are useful after compaction or when the recent-image order is ambiguous.

Reference-guided generation improves continuity but cannot guarantee identical geometry, faces, typography, or individual pixels.

## Prompt structure

Use only the lines that clarify the request:

```text
Intended use: product photo, website hero, story illustration, sprite, etc.
Primary request: the user's desired image or edit
Input images: Image 1 and its role; Image 2 and its role
Scene and subject: environment, subject, important details
Style and materials: photo, watercolor, clay render, surface textures
Composition: viewpoint, framing, proportions, useful negative space
Lighting and palette: requested light and color constraints
Text, verbatim: "Exact words"
Change only: allowed changes for an edit
Keep unchanged: identity, layout, objects, pose, typography, and other invariants
Avoid: unwanted elements
```

For photos, state photorealism and relevant real-world materials or textures. For text, quote the exact wording and describe placement and typography. Verify the result instead of assuming text rendered correctly. For diagrams or educational visuals, provide the actual labels and relationships; do not invent data.

## Transparency

Ask for a genuinely transparent background, not a checkerboard painted into an opaque image. Keep the saved PNG intact so any alpha channel is preserved. Visual appearance alone does not prove transparency; check the file's alpha if transparency is required. Do not switch models or services to obtain it without the user's permission.

## Examples

New image:

```json
{
  "prompt": "Website hero illustration of a small ceramic robot tending a fern. Watercolor on warm white paper, soft window light. Wide framing with room for page copy. No lettering or watermark.",
  "output_path": "public/images/robot-hero.png"
}
```

Targeted edit:

```json
{
  "prompt": "Image 1 is the edit target. Change only the watering can to blue. Keep the robot design, pose, fern, background, lighting, framing, and watercolor texture unchanged. No new objects or text.",
  "referenced_image_paths": ["public/images/robot-hero.png"],
  "output_path": "public/images/robot-hero-v2.png"
}
```

Recent-image edit:

```json
{
  "prompt": "Change only the background of the supplied image to a plain warm white. Preserve the subject, pose, materials, and framing.",
  "num_last_images_to_include": 1
}
```

## Authentication and failures

By default, the tool and this skill load when pi has an `openai-codex` OAuth subscription login. `pi-image-generation-settings.json` in the global agent directory or trusted project `.pi` (also `.pi/agent`) directory can select another provider with `provider` or supply an OpenAI `apiKey`. Project settings override global settings. API-key requests use the paid OpenAI Images API, not the subscription backend. Pi manages provider credential resolution and OAuth refresh. After changing credentials or settings, use `/reload` to update registration. The active conversation model does not need to be OpenAI.

If authentication fails, ask the user to check their configured provider login or API-key settings; never ask them to paste secrets into chat. For rate limits, wait rather than changing providers. After a timeout or connection failure, the image request may already have consumed allowance or incurred API charges. Do not claim a file exists unless the tool returned a saved path.
