import { toRecord } from "./common.js";

const OPENROUTER_HOST = "openrouter.ai";
const NVIDIA_NIM_HOST = "integrate.api.nvidia.com";
const CLOUDFLARE_API_HOST = "api.cloudflare.com";
const CLOUDFLARE_AI_GATEWAY_HOST = "gateway.ai.cloudflare.com";
const EARENDIL_CODING_AGENT = "@earendil-works/pi-coding-agent";

export interface InstallTelemetrySettingsLike {
  getEnableInstallTelemetry: () => boolean;
}

function isTruthyEnvFlag(value: string | undefined): boolean {
  if (!value) return false;
  return value === "1" || value.toLowerCase() === "true" || value.toLowerCase() === "yes";
}

/** Mirrors Pi's current telemetry precedence: PI_TELEMETRY overrides settings.json. */
export function isInstallTelemetryEnabled(
  settingsManager: InstallTelemetrySettingsLike,
  telemetryEnv: string | undefined,
): boolean {
  return telemetryEnv !== undefined ? isTruthyEnvFlag(telemetryEnv) : settingsManager.getEnableInstallTelemetry();
}

/**
 * Resolve whether Pi provider attribution is enabled for the active runtime.
 *
 * Earendil Pi exposes SettingsManager publicly, so use it to read the same
 * global/project settings Pi uses. The telemetry helper itself is not exported,
 * so the small env-precedence rule above mirrors current upstream semantics.
 * For OMP/older runtimes, preserve the existing behavior unless PI_TELEMETRY
 * is explicitly set.
 */
export async function isProviderAttributionEnabled(
  cwd: string | undefined,
  codingAgentPackage: string | undefined,
  telemetryEnv: string | undefined = process.env.PI_TELEMETRY,
): Promise<boolean> {
  if (telemetryEnv !== undefined) {
    return isTruthyEnvFlag(telemetryEnv);
  }
  if (codingAgentPackage !== EARENDIL_CODING_AGENT) {
    return true;
  }

  try {
    // Keep this dynamic so the optional peer dependency remains optional.
    const packageName = codingAgentPackage;
    const mod = await import(packageName);
    const settingsManagerClass = mod.SettingsManager as { create?: (cwd: string) => unknown } | undefined;
    if (typeof settingsManagerClass?.create !== "function") {
      return true;
    }
    const settingsManager = settingsManagerClass.create(cwd ?? process.cwd());
    const record = toRecord(settingsManager);
    const getter = record.getEnableInstallTelemetry;
    if (typeof getter !== "function") {
      return true;
    }
    return isInstallTelemetryEnabled({
      getEnableInstallTelemetry: () => {
        const enabled = getter.call(settingsManager);
        return typeof enabled === "boolean" ? enabled : true;
      },
    }, telemetryEnv);
  } catch {
    // Preserve compatibility with older/alternate runtimes if the public
    // SettingsManager API is unavailable.
    return true;
  }
}

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
