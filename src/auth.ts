import { readStoredCredential, type ExtensionContext } from "@earendil-works/pi-coding-agent";

export const PROVIDER = "openai-codex";
export const OFF_WARNING = "image generation is off, no openai-codex provider configured.";

export function hasSubscription(): boolean {
  const credential = readStoredCredential(PROVIDER);
  return credential?.type === "oauth" && typeof credential.access === "string" &&
    credential.access.length > 0 && typeof credential.refresh === "string" &&
    credential.refresh.length > 0;
}

export interface ImageAuth {
  accessToken: string;
  accountId: string;
}

// Only extracts routing metadata. The backend, not this decoder, verifies the JWT.
export function accountIdFromToken(token: string): string | undefined {
  try {
    const claims = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
    const id = claims["https://api.openai.com/auth"]?.chatgpt_account_id;
    return typeof id === "string" && id.length > 0 ? id : undefined;
  } catch {
    return undefined;
  }
}

export async function resolveImageAuth(
  registry: Pick<ExtensionContext["modelRegistry"], "getProviderAuth">,
): Promise<ImageAuth> {
  if (!hasSubscription()) throw new Error(OFF_WARNING + " Use /login openai-codex, then /reload.");

  // Pi owns token refresh, file locking and persistence. Never refresh or write auth.json here.
  let resolved;
  try {
    resolved = await registry.getProviderAuth(PROVIDER);
  } catch {
    throw new Error("Could not refresh the openai-codex login. Use /login openai-codex, then /reload.");
  }
  const credential = readStoredCredential(PROVIDER);
  const accessToken = resolved?.auth.apiKey;
  // Reject environment/API-key fallbacks and provider overrides that changed the credential.
  if (credential?.type !== "oauth" || !accessToken || accessToken !== credential.access) {
    throw new Error("Image generation requires the stored openai-codex subscription login, not an API key or override.");
  }
  const accountId = accountIdFromToken(accessToken) ??
    (typeof credential.accountId === "string" ? credential.accountId : undefined);
  if (!accountId) throw new Error("The openai-codex login has no account ID. Please log in again.");
  return { accessToken, accountId };
}
