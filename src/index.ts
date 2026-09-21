import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import { resizeImage, type ExtensionAPI, type ExtensionContext, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { hasImageAuth, offWarning, resolveImageAuth } from "./auth.ts";
import { loadImageSettings } from "./settings.ts";
import { IMAGE_MODEL, requestImage } from "./backend.ts";
import { loadReferences, prepareOutput, saveImage } from "./images.ts";

const parameters = Type.Object({
  prompt: Type.String({ minLength: 1, maxLength: 16000, description: "Complete image brief, including reference-image roles and details that must not change." }),
  referenced_image_paths: Type.Optional(Type.Array(Type.String({ minLength: 1 }), {
    minItems: 1, maxItems: 5, description: "Local PNG/JPEG/WebP references, in prompt order. Relative paths resolve against the project. Do not combine with num_last_images_to_include.",
  })),
  num_last_images_to_include: Type.Optional(Type.Integer({
    minimum: 1, maximum: 5, description: "Use the last 1-5 images on this conversation branch, oldest first. Prefer explicit paths when several unrelated images are present.",
  })),
  output_path: Type.Optional(Type.String({ minLength: 1, description: "New .png destination. Defaults to output/imagegen/<unique-name>.png in the project. Never overwrites an existing file." })),
}, { additionalProperties: false });

// Registry auth resolution does its own locked refresh. Stop waiting on cancellation without
// interrupting that shared refresh or letting this tool proceed to an image request afterward.
async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let onAbort: () => void = () => {};
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  try {
    return await Promise.race([promise, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

export default function imageGeneration(pi: ExtensionAPI): void {
  const settingsFor = (ctx: ExtensionContext) => loadImageSettings(ctx.cwd, ctx.isProjectTrusted());
  let registered = false;
  // Wait for the session cwd, trust decision and custom provider registrations.
  pi.on("session_start", async (_event, ctx) => {
    try {
      const settings = await settingsFor(ctx);
      if (!hasImageAuth(settings, ctx.modelRegistry)) throw new Error(offWarning(settings));
      if (!registered) {
        pi.registerTool(tool);
        registered = true;
      }
    } catch (error) {
      const message = (error as Error).message;
      if (ctx.hasUI) ctx.ui.notify(message, "warning");
      else console.error(message);
    }
  });

  // Not listed in the static manifest, so it cannot leak into unauthenticated sessions.
  pi.on("resources_discover", async (_event, ctx) => {
    try {
      const settings = await settingsFor(ctx);
      return { skillPaths: registered && hasImageAuth(settings, ctx.modelRegistry)
        ? [fileURLToPath(new URL("../resources/imagegen/SKILL.md", import.meta.url))] : [] };
    } catch {
      return { skillPaths: [] };
    }
  });

  const tool: ToolDefinition<typeof parameters> = {
    name: "image_gen",
    label: "Generate image",
    description: "Generate or edit one raster image using the configured OpenAI provider or API key. Accepts up to five local or recent-conversation reference images for consistent edits and variants. Saves a new PNG and returns a preview when possible. Uses openai-codex by default; credentials can be overridden in pi-image-generation-settings.json. Reference limits: 32 MiB each, 50 MiB combined; 4-minute request timeout. Load the imagegen skill first.",
    promptSnippet: "Generate images or edit them using local or recent image references",
    promptGuidelines: [
      "Before using image_gen, read the imagegen skill. Reuse reference images and state what must remain unchanged for consistent edits.",
      "Use image_gen for requested raster artwork, not SVG placeholders. Prefer native code edits for existing vector assets.",
    ],
    parameters,
    async execute(_toolCallId, args, signal, onUpdate, ctx) {
      const timeout = AbortSignal.timeout(240_000);
      const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
      requestSignal.throwIfAborted();
      if (!args.prompt.trim()) throw new Error("The image prompt must not be blank.");
      const settings = await settingsFor(ctx);
      if (!hasImageAuth(settings, ctx.modelRegistry)) throw new Error(offWarning(settings) + " Check your image generation settings and login, then /reload.");
      const path = await prepareOutput(ctx.cwd, args.output_path);
      const images = await loadReferences(args.referenced_image_paths, args.num_last_images_to_include,
        ctx.sessionManager.getBranch(), ctx.cwd, requestSignal);
      const auth = await abortable(resolveImageAuth(ctx.modelRegistry, settings), requestSignal);
      onUpdate?.({ content: [{ type: "text", text: images.length ? "Editing image…" : "Generating image…" }], details: {} });

      let result;
      try {
        result = await requestImage(auth, { prompt: args.prompt, images }, requestSignal);
      } catch (error) {
        if (timeout.aborted && !signal?.aborted) {
          throw new Error("Image generation timed out after four minutes. It may still have consumed image allowance; no automatic retry was made.");
        }
        throw error;
      }
      // Persist the original before processing a smaller preview. Never re-encode the saved PNG.
      let savedPath = path;
      let saveNote = "";
      try {
        await saveImage(savedPath, result.bytes);
      } catch {
        savedPath = await prepareOutput(ctx.cwd);
        try {
          await saveImage(savedPath, result.bytes);
        } catch {
          throw new Error("The image was generated, but could not be saved. Check workspace write permissions before generating again.");
        }
        saveNote = " The requested destination could not be written; saved to the default output directory instead.";
      }
      const preview = await resizeImage(result.bytes, "image/png").catch(() => null);
      const content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[] = [
        { type: "text", text: `Saved image: ${savedPath}.${saveNote}\nPrompt: ${args.prompt}` },
      ];
      if (preview) content.push({ type: "image", data: preview.data, mimeType: preview.mimeType });
      else content.push({ type: "text", text: "Preview unavailable. Inspect the saved PNG with the read tool." });
      return {
        content,
        details: {
          savedPath,
          prompt: args.prompt,
          model: IMAGE_MODEL,
          operation: images.length ? "edit" : "generate",
          referenceCount: images.length,
        },
      };
    },
  };
}
