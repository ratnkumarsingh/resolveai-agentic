import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const API_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export interface Config {
  apiKey: string | undefined;
  llmMode: "live" | "recorded";
  model: string;
  demoMode: boolean;
  dbPath: string;
  port: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const apiKey = env.ANTHROPIC_API_KEY?.trim() || undefined;
  // Live mode needs a key; without one we fall back to the deterministic recorded mode.
  const llmMode = env.LLM_MODE === "live" && apiKey ? "live" : "recorded";
  return {
    apiKey,
    llmMode,
    model: env.CLAUDE_MODEL?.trim() || "claude-opus-5-5",
    demoMode: (env.DEMO_MODE ?? "true") === "true",
    dbPath: env.DB_PATH === ":memory:" ? ":memory:" : resolve(API_ROOT, env.DB_PATH || "../data/resolveai.db"),
    port: Number(env.API_PORT) || 8787,
  };
}
