export const AI_PROVIDER_DIRECT = "direct";
export const AI_PROVIDER_ZAI_CODING_PLAN = "zai-coding-plan";
export const DEFAULT_CODING_PLAN_BASE = "https://api.z.ai/api/coding/paas/v4";
export const DEFAULT_DIRECT_BASE = "https://api.z.ai/api/paas/v4";
export const DEFAULT_CODING_PLAN_MODEL = "glm-5.3";
export const DEFAULT_DIRECT_MODEL = "glm-5v-turbo";
export const MCP_MODEL_LABEL = "zai-mcp-server@0.1.5 (bundled model)";

function value(env, ...names) {
  for (const name of names) {
    if (typeof env[name] === "string" && env[name].trim()) return env[name].trim();
  }
  return "";
}

function positiveInt(raw, fallback, maximum) {
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed > 0 ? Math.min(parsed, maximum) : fallback;
}

/**
 * Resolve worker AI settings without reading any secret from disk or emitting
 * it. The same admin-owned key can authenticate Keeper text and the local Z.AI
 * MCP process, while direct mode retains the original OpenAI-compatible path.
 */
export function loadConfig(env = process.env) {
  const requested = value(env, "AI_PROVIDER").toLowerCase() || AI_PROVIDER_DIRECT;
  if (![AI_PROVIDER_DIRECT, "openai-compatible", AI_PROVIDER_ZAI_CODING_PLAN].includes(requested)) {
    const error = Error(`Unsupported AI_PROVIDER: ${requested}`);
    error.configuration = true;
    throw error;
  }
  const mode = requested === "openai-compatible" ? AI_PROVIDER_DIRECT : requested;
  const key = mode === AI_PROVIDER_ZAI_CODING_PLAN
    ? value(env, "Z_AI_API_KEY", "VISION_API_KEY")
    : value(env, "VISION_API_KEY", "Z_AI_API_KEY");
  const keySource = mode === AI_PROVIDER_ZAI_CODING_PLAN
    ? value(env, "Z_AI_API_KEY") ? "Z_AI_API_KEY" : key ? "VISION_API_KEY_ALIAS" : "missing"
    : value(env, "VISION_API_KEY") ? "VISION_API_KEY" : key ? "Z_AI_API_KEY_ALIAS" : "missing";
  const state = { textFailure: null, visionFailure: null };
  const keeper = mode === AI_PROVIDER_ZAI_CODING_PLAN
    ? {
        mode,
        base: value(env, "KEEPER_BASE_URL") || DEFAULT_CODING_PLAN_BASE,
        model: value(env, "KEEPER_MODEL") || DEFAULT_CODING_PLAN_MODEL,
        key,
        keySource,
      }
    : {
        mode,
        base: value(env, "KEEPER_BASE_URL", "VISION_BASE_URL") || DEFAULT_DIRECT_BASE,
        model: value(env, "KEEPER_MODEL", "VISION_MODEL") || DEFAULT_DIRECT_MODEL,
        key,
        keySource,
      };
  const vision = mode === AI_PROVIDER_ZAI_CODING_PLAN
    ? { mode, transport: "mcp", model: MCP_MODEL_LABEL, key, keySource }
    : {
        mode,
        transport: "http",
        base: value(env, "VISION_BASE_URL") || DEFAULT_DIRECT_BASE,
        model: value(env, "VISION_MODEL") || DEFAULT_DIRECT_MODEL,
        key,
        keySource,
      };
  return {
    mode,
    timeZone: value(env, "TZ") || "UTC",
    keeper,
    vision,
    visionMcp: {
      command: value(env, "Z_AI_MCP_COMMAND") || "zai-mcp-server",
      cwd: value(env, "Z_AI_MCP_CWD") || process.cwd(),
      timeoutMs: positiveInt(env.Z_AI_MCP_TIMEOUT_MS, 120_000, 300_000),
      key,
      keySource,
      model: MCP_MODEL_LABEL,
    },
    providerState: state,
    // Status is deliberately derived from booleans and non-sensitive labels.
    status() {
      const configured = !!key;
      return {
        mode,
        model: keeper.model,
        configured,
        keySource,
        text: {
          configured,
          model: keeper.model,
          endpoint: keeper.base,
          failure: state.textFailure || (!configured
            ? mode === AI_PROVIDER_ZAI_CODING_PLAN ? "Coding Plan text key is missing" : "Direct text provider key is missing"
            : null),
        },
        vision: {
          configured,
          model: vision.model,
          transport: vision.transport,
          endpoint: vision.transport === "mcp" ? "zai-mcp-server" : vision.base,
          failure: state.visionFailure || (!configured
            ? mode === AI_PROVIDER_ZAI_CODING_PLAN ? "Vision MCP key is missing" : "Direct vision provider key is missing"
            : null),
        },
      };
    },
  };
}
