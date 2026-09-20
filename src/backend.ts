import { randomUUID } from "node:crypto";
import { PNG } from "pngjs";
import type { ImageAuth } from "./auth.ts";

export const IMAGE_MODEL = "gpt-image-2";
const BASE_URL = "https://chatgpt.com/backend-api/codex";
export const MAX_IMAGE_BYTES = 32 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 48 * 1024 * 1024;

export interface ImageRequest {
  prompt: string;
  images?: string[];
}

export interface GeneratedImage {
  bytes: Buffer;
  generationId?: string;
}

async function boundedBody(response: Response, maxBytes: number): Promise<Buffer> {
  const declared = Number(response.headers.get("content-length"));
  if (declared > maxBytes) {
    await response.body?.cancel();
    throw new Error("Image backend response exceeds the size limit.");
  }
  if (!response.body) throw new Error("Image backend returned an empty response.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error("Image backend response exceeds the size limit.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

export function decodePng(base64: unknown): Buffer {
  if (typeof base64 !== "string" || base64.length === 0 ||
    base64.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 ||
    base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) {
    throw new Error("Image backend returned invalid or oversized image data.");
  }
  const bytes = Buffer.from(base64, "base64");
  if (bytes.length > MAX_IMAGE_BYTES || bytes.length < 24 ||
    bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a" ||
    bytes.toString("ascii", 12, 16) !== "IHDR") {
    throw new Error("Image backend did not return a PNG image.");
  }
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (!width || !height || width > 8192 || height > 8192 || width * height > 16_777_216) {
    throw new Error("Image backend returned unsupported PNG dimensions.");
  }
  try {
    // Validate chunks, CRCs and pixel data, but keep the original encoded bytes and alpha.
    PNG.sync.read(bytes, { checkCRC: true });
  } catch {
    throw new Error("Image backend returned a corrupt PNG image.");
  }
  return bytes;
}

export async function requestImage(
  auth: ImageAuth,
  request: ImageRequest,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<GeneratedImage> {
  signal.throwIfAborted();
  const editing = !!request.images?.length;
  let response: Response;
  try {
    response = await fetcher(`${BASE_URL}/images/${editing ? "edits" : "generations"}`, {
      method: "POST",
      // Never follow a redirect with a subscription credential.
      redirect: "error",
      signal,
      headers: {
        Authorization: `Bearer ${auth.accessToken}`,
        "ChatGPT-Account-ID": auth.accountId,
        "Content-Type": "application/json",
        originator: "pi-image-generation",
        "x-codex-image-turn-id": randomUUID(),
      },
      body: JSON.stringify({
        model: IMAGE_MODEL,
        prompt: request.prompt,
        background: "auto",
        quality: "auto",
        size: "auto",
        ...(editing ? { images: request.images!.map(image_url => ({ image_url })) } : {}),
      }),
    });
  } catch {
    signal.throwIfAborted();
    throw new Error("Image backend connection failed. No automatic retry was made; the request may have been processed.");
  }

  if (!response.ok) {
    // Do not echo upstream bodies, prompts, account IDs or auth headers into the session.
    await response.body?.cancel();
    const hints: Record<number, string> = {
      400: "The backend rejected the image request. Check the prompt and reference images.",
      401: "The subscription login was rejected. Use /login openai-codex, then /reload.",
      403: "Image generation is not permitted for this account or request.",
      404: "The subscription image endpoint is unavailable.",
      429: "The image allowance or rate limit was reached. Wait before trying again.",
    };
    throw new Error(`Image generation failed (HTTP ${response.status}). ${hints[response.status] ?? "No automatic retry was made; try again later."}`);
  }

  let body: unknown;
  try {
    body = JSON.parse((await boundedBody(response, MAX_RESPONSE_BYTES)).toString("utf8"));
  } catch {
    signal.throwIfAborted();
    throw new Error("Image backend returned an unreadable or oversized response. No automatic retry was made.");
  }
  const data = (body as { data?: { b64_json?: unknown; generation_id?: unknown }[] })?.data;
  if (!Array.isArray(data) || data.length !== 1) {
    throw new Error("Image backend did not return exactly one image.");
  }
  return {
    bytes: decodePng(data[0]?.b64_json),
    generationId: typeof data[0]?.generation_id === "string" ? data[0].generation_id : undefined,
  };
}
