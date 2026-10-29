import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { get, openDb } from "./db/index.js";
import { seedDemoData } from "./db/seed.js";
import { ClaudeProvider } from "./llm/claude.js";
import { RecordedProvider } from "./llm/recorded.js";

const config = loadConfig();
const db = openDb(config.dbPath);

// First run: start with the demo dataset so the app is never empty.
if (!get(db, "SELECT 1 FROM incidents LIMIT 1")) seedDemoData(db);

const llm = config.llmMode === "live" ? new ClaudeProvider(config.apiKey!, config.model) : new RecordedProvider();
const app = buildApp({ db, llm, config });

// Investigations interrupted by a restart can't resume; mark them failed so the UI isn't stuck polling.
db.prepare("UPDATE investigations SET status = 'failed', stage = NULL, error_message = 'Interrupted by a server restart. Run the investigation again.' WHERE status IN ('queued', 'running')").run();

await app.listen({ host: "127.0.0.1", port: config.port });
console.log(`ResolveAI API on http://127.0.0.1:${config.port} — LLM mode: ${llm.mode}${llm.mode === "live" ? ` (${config.model})` : ""}`);
