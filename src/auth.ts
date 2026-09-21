import { readStoredCredential, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ImageSettings } from "./settings.ts";

export const PROVIDER = "openai-codex";
export const OFF_WARNING = "image generation is off, no openai-codex provider configured.";

export function hasSubscription(provider = PROVIDER): boolean {
  const credential = readStoredCredential(provider);
  return credential?.type === "oauth" && typeof credential.access === "string" &&
    credential.access.length > 0 && typeof credential.refresh === "string" &&
    credential.refresh.length > 0;
}

export function hasImageAuth(
  settings: ImageSettings | undefined,
  registry: Pick<ExtensionContext["modelRegistry"], "getProviderAuthStatus">,
): boolean {
  if (!settings) return hasSubscription();
  if ("apiKey" in settings) return true;
  if (readStoredCredential(settings.provider)?.type === "oauth") return hasSubscription(settings.provider);
  return registry.getProviderAuthStatus(settings.provider).configured;
}

export function offWarning(settings?: ImageSettings): string {
  return settings && "provider" in settings
    ? `image generation is off, no ${settings.provider} provider configured.`
    : OFF_WARNING;
}

export type ImageAuth = { accessToken: string; accountId: string } | { apiKey: string };

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
  registry: Pick<ExtensionContext["modelRegistry"], "getProviderAuth"> &
    Partial<Pick<ExtensionContext["modelRegistry"], "getProvider">>,
  settings?: ImageSettings,
): Promise<ImageAuth> {
  if (settings && "apiKey" in settings) return { apiKey: settings.apiKey };
  const provider = settings?.provider ?? PROVIDER;
  // With no settings, preserve the subscription-only default (no paid API fallback).
  if (!settings && !hasSubscription()) throw new Error(OFF_WARNING + " Use /login openai-codex, then /reload.");

  // Pi owns token refresh, file locking and persistence. Never refresh or write auth.json here.
  let resolved;
  try {
    resolved = await registry.getProviderAuth(provider);
  } catch {
    throw new Error(`Could not refresh or resolve the ${provider} login. Use /login ${provider}, then /reload.`);
  }
  const credential = readStoredCredential(provider);
  const accessToken = resolved?.auth.apiKey;
  if (!accessToken) throw new Error(offWarning(settings) + ` Use /login ${provider}, then /reload.`);
  if (settings) {
    // A provider name is not proof that its secret belongs to OpenAI. Never send another
    // service's credentials to our fixed endpoints, even if the user selects it by mistake.
    const baseUrl = resolved?.auth.baseUrl ?? registry.getProvider?.(provider)?.baseUrl;
    let origin: string | undefined;
    try { origin = baseUrl ? new URL(baseUrl).origin : undefined; } catch { /* reject below */ }
    const expectedOrigin = credential?.type === "oauth" ? "https://chatgpt.com" : "https://api.openai.com";
    if (origin !== expectedOrigin) {
      throw new Error(`The ${provider} provider is not configured for a supported OpenAI endpoint. Select an OpenAI provider or set apiKey explicitly.`);
    }
    if (credential?.type !== "oauth") return { apiKey: accessToken };
  }

  // Reject environment/API-key overrides of a subscription credential, including named aliases.
  if (credential?.type !== "oauth" || accessToken !== credential.access) {
    throw new Error(`Image generation requires the stored ${provider} subscription login, not an API key or override.`);
  }
  const accountId = accountIdFromToken(accessToken) ??
    (typeof credential.accountId === "string" && credential.accountId.length > 0 ? credential.accountId : undefined);
  if (!accountId) throw new Error(`The ${provider} login has no account ID. Please log in again.`);
  return { accessToken, accountId };
}
