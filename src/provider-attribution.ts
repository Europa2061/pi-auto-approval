import { toRecord } from "./common.js";

/**
 * Provider attribution headers that pi core injects into every model request
 * (see pi-coding-agent's provider-attribution module). The approval
 * classifier calls `completeSimple` directly, bypassing that merge, so
 * without this the classifier requests are the only pi traffic arriving at
 * OpenRouter / NVIDIA NIM / Cloudflare without pi's attribution headers.
 *
 * Mirrors pi core's host/provider matching exactly so the classifier stays
 * consistent with pi's normal model calls for both built-in providers and
 * custom providers pointed at the same hosts.
 */

const OPENROUTER_HOST = "openrouter.ai";
const NVIDIA_NIM_HOST = "integrate.api.nvidia.com";
const CLOUDFLARE_API_HOST = "api.cloudflare.com";
const CLOUDFLARE_AI_GATEWAY_HOST = "gateway.ai.cloudflare.com";

function matchesHost(baseUrl: string, expectedHost: string): boolean {
  if (!baseUrl) {
    return false;
  }
  try {
    return new URL(baseUrl).hostname === expectedHost;
  } catch {
    return false;
  }
}

export function getProviderAttributionHeaders(model: unknown): Record<string, string> | undefined {
  const record = toRecord(model);
  const provider = typeof record.provider === "string" ? record.provider : "";
  const baseUrl = typeof record.baseUrl === "string" ? record.baseUrl : "";

  if (provider === "openrouter" || baseUrl.includes(OPENROUTER_HOST)) {
    return {
      "HTTP-Referer": "https://pi.dev",
      "X-OpenRouter-Title": "pi",
      "X-OpenRouter-Categories": "cli-agent",
    };
  }
  if (provider === "nvidia" || matchesHost(baseUrl, NVIDIA_NIM_HOST)) {
    return { "X-BILLING-INVOKE-ORIGIN": "Pi" };
  }
  if (
    provider === "cloudflare-workers-ai" ||
    provider === "cloudflare-ai-gateway" ||
    matchesHost(baseUrl, CLOUDFLARE_API_HOST) ||
    matchesHost(baseUrl, CLOUDFLARE_AI_GATEWAY_HOST)
  ) {
    return { "User-Agent": "pi-coding-agent" };
  }
  return undefined;
}
