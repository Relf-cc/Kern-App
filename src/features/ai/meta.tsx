/**
 * @Author Christian Relf
 * @Date 2026-10-12
 */

import { Bot } from "lucide-react";
import { siAnthropic } from "simple-icons";
import type { AiAccount, AiErrorCategory, AiProvider, AiStatus } from "@/lib/types";
import { BrandIcon } from "@/components/ui/BrandIcon";

export const PROVIDER_NAME: Record<AiProvider, string> = { anthropic: "Anthropic", openai: "OpenAI", "claude-cli": "Claude subscription" };

/**
 * Provider mark in a neutral tile. Anthropic uses its Simple Icons mark.
 * Simple Icons no longer includes an OpenAI mark, so OpenAI gets a generic
 * glyph in the same tile rather than an imitation logo.
 */
export function ProviderIcon({ provider, size = 28 }: { provider: AiProvider; size?: number }) {
  const inner = Math.round(size * 0.55);
  return (
    <span className="provider-icon" style={{ width: size, height: size }} title={PROVIDER_NAME[provider]} aria-label={PROVIDER_NAME[provider]} role="img">
      {provider === "anthropic" ? <BrandIcon icon={siAnthropic} size={inner} /> : <Bot size={inner} strokeWidth={1.75} />}
    </span>
  );
}

export const STATUS_LABEL: Record<AiStatus | "active", string> = {
  active: "Active",
  ready: "Ready",
  rate_limited: "Rate limited",
  quota_reached: "Quota reached",
  auth_error: "Authentication error",
  permission_error: "Permission error",
  unavailable: "Temporarily unavailable",
  disabled: "Disabled",
  unknown: "Unknown",
};

export const STATUS_HINT: Record<AiStatus | "active", string> = {
  active: "Used first for new requests.",
  ready: "The last request or connection test succeeded.",
  rate_limited: "The provider asked Kern to slow down. It's skipped until the reported reset time.",
  quota_reached: "The provider reported a billing or quota limit. Kern pauses it instead of sending requests that would fail.",
  auth_error: "The provider rejected this key. Replace it or test the connection again.",
  permission_error: "The key isn't allowed to use this model or feature.",
  unavailable: "The provider was overloaded or erroring. It's retried after a short pause.",
  disabled: "Never used for requests.",
  unknown: "Not tested yet. Use Test connection to check the key.",
};

export function effectiveStatus(a: AiAccount, activeId: string | null): AiStatus | "active" {
  if (a.status === "ready" || a.status === "unknown") return a.id === activeId && a.enabled ? "active" : a.status;
  return a.status;
}

export const CATEGORY_LABEL: Record<AiErrorCategory, string> = {
  rate_limited: "Rate limited",
  spend_limit: "Spend limit reached",
  insufficient_quota: "Out of credit",
  invalid_key: "Invalid API key",
  permission: "Missing permission",
  model_unavailable: "Model unavailable",
  network: "Network unavailable",
  overloaded: "Provider overloaded",
  timeout: "Timed out",
  invalid_request: "Invalid request",
  unknown: "Provider error",
};

export const VALIDATION_LABEL: Record<string, string> = {
  authenticated: "Authentication successful",
  auth_failed: "Authentication failed",
  permission: "Insufficient permissions",
  unavailable: "Provider temporarily unavailable",
  rate_limited: "Rate limited - the key works but is busy",
  quota: "Authenticated, but out of credit or quota",
  network: "Couldn't reach the provider",
  unknown: "Unknown validation status",
};

export const formatTokens = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
export const formatUsd = (n: number) => (n < 0.01 && n > 0 ? "<$0.01" : `$${n.toFixed(2)}`);

/** Suggested default models; the connection test lists what the key can actually use. */
export const SUGGESTED_MODEL: Record<AiProvider, string | null> = { anthropic: "claude-opus-5-5", openai: null, "claude-cli": "default" };

/** Providers that need an API key. The CLI is signed in on its own. */
export const NEEDS_KEY: Record<AiProvider, boolean> = { anthropic: true, openai: true, "claude-cli": false };

export const PROVIDER_HINT: Record<AiProvider, string> = {
  anthropic: "An API key from console.anthropic.com. Billed per token.",
  openai: "An API key from platform.openai.com. Billed per token.",
  "claude-cli": "The claude command already installed on this computer, on your own Claude subscription. No key, and nothing billed per token.",
};
