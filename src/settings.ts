import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";

export const SETTINGS_FILE = "pi-image-generation-settings.json";
export type ImageSettings = { provider: string } | { apiKey: string };

// Select a whole file, not a field merge: a local provider must not inherit a global API key.
export async function loadImageSettings(cwd: string, projectTrusted: boolean): Promise<ImageSettings | undefined> {
  const paths = [
    ...(projectTrusted ? [join(cwd, CONFIG_DIR_NAME, "agent", SETTINGS_FILE), join(cwd, CONFIG_DIR_NAME, SETTINGS_FILE)] : []),
    join(getAgentDir(), SETTINGS_FILE),
  ];
  for (const path of paths) {
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw new Error(`Cannot read image generation settings: ${path}`);
    }
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      // JSON parser errors can contain the API key. Never include them in diagnostics.
      throw new Error(`Invalid JSON in image generation settings: ${path}`);
    }
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const entries = Object.entries(value);
      if (entries.length === 1) {
        const [key, raw] = entries[0];
        if (typeof raw === "string" && raw.trim()) {
          if (key === "provider") return { provider: raw.trim() };
          if (key === "apiKey") return { apiKey: raw.trim() };
        }
      }
    }
    throw new Error(`Image generation settings must contain exactly one non-empty string: provider or apiKey (${path}).`);
  }
  return undefined;
}
