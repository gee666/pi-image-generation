import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, lstat, stat, mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, extname, isAbsolute, join, resolve } from "node:path";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { MAX_IMAGE_BYTES } from "./backend.ts";

export const MAX_REFERENCES = 5;
const MAX_TOTAL_INPUT_BYTES = 50 * 1024 * 1024;

export function imagePath(input: string, cwd: string): string {
  let path = input.startsWith("@") ? input.slice(1) : input;
  if (path === "~") path = homedir();
  else if (/^~[/\\]/.test(path)) path = join(homedir(), path.slice(2));
  return isAbsolute(path) ? path : resolve(cwd, path);
}

export function mimeForImage(bytes: Buffer): string {
  if (bytes.subarray(0, 8).toString("hex") === "89504e470d0a1a0a") return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  throw new Error("Reference images must be PNG, JPEG, or WebP files.");
}

async function fileImage(path: string, signal: AbortSignal): Promise<Buffer> {
  signal.throwIfAborted();
  if (!(await stat(path)).isFile()) throw new Error("Reference images must be regular files.");
  // O_NONBLOCK prevents a FIFO swapped in after stat() from hanging open() on Unix.
  const flags = constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NONBLOCK);
  const handle = await open(path, flags);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size === 0 || stat.size > MAX_IMAGE_BYTES) {
      throw new Error("Reference images must be regular files of at most 32 MiB.");
    }
    // Bounded even if another process grows the file between stat and read.
    const bytes = Buffer.alloc(stat.size + 1);
    let read = 0;
    while (read < bytes.length) {
      signal.throwIfAborted();
      const result = await handle.read(bytes, read, bytes.length - read, null);
      if (result.bytesRead === 0) break;
      read += result.bytesRead;
    }
    if (read > stat.size) throw new Error("Reference image changed while reading. Try again.");
    return bytes.subarray(0, read);
  } finally {
    await handle.close();
  }
}

type Reference = { path: string } | { base64: string };
const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" ? value as Record<string, unknown> : undefined;

// The caller supplies only the active branch. Never use getEntries(), which includes abandoned forks.
export function recentReferences(entries: readonly unknown[], count: number): Reference[] {
  const found: Reference[] = [];
  for (let index = entries.length - 1; index >= 0 && found.length < count; index--) {
    const entry = record(entries[index]);
    const message = entry?.type === "message" ? record(entry.message) :
      entry?.type === "custom_message" ? entry : undefined;
    if (!message || message.isError === true) continue;
    if (message.role === "toolResult" && message.toolName === "image_gen") {
      const details = record(message.details);
      if (typeof details?.savedPath === "string") {
        found.push({ path: details.savedPath });
        continue; // Use the full-resolution artifact, not its inline preview as a second reference.
      }
    }
    if (!Array.isArray(message.content)) continue;
    for (let i = message.content.length - 1; i >= 0 && found.length < count; i--) {
      const block = record(message.content[i]);
      if (block?.type !== "image") continue;
      if (typeof block.data === "string") found.push({ base64: block.data });
      else throw new Error("A recent image is not available inline. Use referenced_image_paths instead.");
    }
  }
  if (found.length !== count) {
    throw new Error(`Requested ${count} recent images, but only ${found.length} are available on this branch. Use referenced_image_paths instead.`);
  }
  return found.reverse();
}

export async function loadReferences(
  paths: string[] | undefined,
  recentCount: number | undefined,
  entries: readonly unknown[],
  cwd: string,
  signal: AbortSignal,
): Promise<string[]> {
  if (paths !== undefined && recentCount !== undefined) {
    throw new Error("Use referenced_image_paths or num_last_images_to_include, not both.");
  }
  if (paths !== undefined && (paths.length < 1 || paths.length > MAX_REFERENCES)) {
    throw new Error("Supply between 1 and 5 reference-image paths.");
  }
  if (recentCount !== undefined && (!Number.isInteger(recentCount) || recentCount < 1 || recentCount > MAX_REFERENCES)) {
    throw new Error("num_last_images_to_include must be an integer between 1 and 5.");
  }
  const references: Reference[] = paths?.map(path => ({ path: imagePath(path, cwd) })) ??
    (recentCount === undefined ? [] : recentReferences(entries, recentCount));
  let total = 0;
  const images: string[] = [];
  for (const reference of references) {
    signal.throwIfAborted();
    let bytes: Buffer;
    if ("path" in reference) {
      bytes = await fileImage(reference.path, signal);
    } else {
      if (reference.base64.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 ||
        reference.base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(reference.base64)) {
        throw new Error("Recent image has invalid or oversized data. Use a local image path instead.");
      }
      bytes = Buffer.from(reference.base64, "base64");
    }
    total += bytes.length;
    if (bytes.length > MAX_IMAGE_BYTES || total > MAX_TOTAL_INPUT_BYTES) {
      throw new Error("Reference images exceed the 32 MiB per-image or 50 MiB combined limit.");
    }
    images.push(`data:${mimeForImage(bytes)};base64,${bytes.toString("base64")}`);
  }
  return images;
}

export async function prepareOutput(cwd: string, requested?: string): Promise<string> {
  const path = requested === undefined
    ? join(cwd, "output", "imagegen", `${Date.now()}-${randomUUID()}.png`)
    : imagePath(requested, cwd);
  if (extname(path).toLowerCase() !== ".png") throw new Error("output_path must end in .png.");
  try {
    await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return path;
    throw error;
  }
  throw new Error("The output file already exists. Choose a new filename; images are never overwritten.");
}

export async function saveImage(path: string, bytes: Buffer): Promise<void> {
  await withFileMutationQueue(path, async () => {
    await mkdir(dirname(path), { recursive: true });
    // Exclusive creation protects against races, hardlinks and an existing symlink at the destination.
    await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
  });
}
