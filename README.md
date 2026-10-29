# ResolveAI — Incident Investigation Copilot (hackathon MVP)

ResolveAI pulls an incident's logs, deployments, metrics, runbooks and past incidents into one workflow. It then produces **evidence-backed root-cause hypotheses**, finds **similar past incidents**, suggests **safe, read-only checks** and drafts an **RCA for human review**.

> **Demo dataset only.** Every incident, log, deployment and metric is synthetic seed data. No observability integrations are connected, and the UI says so on every page. AI output is always labelled as a draft or recommendation. Nothing is executed automatically.

## Quick start

```bash
npm install
npm run seed        # optional; the API seeds an empty database on first start
npm run dev         # API on http://127.0.0.1:8787, web on http://localhost:5173
```

Open http://localhost:5173 and pick **INC-1042**.

Requires Node 22.13+ (it uses the built-in `node:sqlite`; nothing native to compile).

## Environment

Copy `.env.example` to `.env`. All variables are server-side; none use the `VITE_` prefix, so none can reach the browser bundle.

| Variable | Default | Purpose |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | empty | Claude API key. Empty means recorded mode. |
| `LLM_MODE` | `recorded` | `live` calls Claude; `recorded` replays fixtures and rules offline. |
| `CLAUDE_MODEL` | `claude-opus-5-5` | Model for investigations and RCA drafts. |
| `DEMO_MODE` | `true` | Enables `POST /api/demo/reset` (localhost only). |
| `DB_PATH` | `../data/resolveai.db` | SQLite file, relative to `api/`. |
| `API_PORT` | `8787` | API port. |

### LLM modes

- **recorded** (default): deterministic and runs without network access. INC-1042 replays a recorded analysis; other incidents get a rule-based analysis built from the same evidence packet. Both go through the same server-side validation as live output. Use this mode for a demo that must behave the same way every time.
- **live**: the server calls Claude through `@anthropic-ai/sdk` with structured JSON output (`output_config.format`, effort `medium`) and server-side refusal fallback (`fallbacks: "default"`). The response is then validated against the evidence packet.

## Demo script (3–4 minutes)

1. The **incident queue** shows active incidents. Open **INC-1042**.
2. On **Signals & timeline**, point out that HTTP 500s rose from 0.2% to 28% and the DB pool rose from 6 to 20. **Deployments** shows payment-api v2.8.1 rolling out four minutes before the incident started.
3. Click **Run investigation**. The loading state shows each backend stage.
4. On **AI findings**, the *Observed facts* (computed from records) are kept apart from the *Inferred analysis* (model output). Click an evidence chip such as `pool.max=20` to jump to the source log line.
5. **Similar incidents** shows INC-0881, a pool-size regression after a config change. Open its historical RCA.
6. **Recommended checks** list what an engineer should verify and what signal to expect. No action is executed.
7. Record a verified root cause, then go to **RCA**: **Generate RCA draft**, edit a field, **Save**, then **Copy Markdown** or **Download .md**.
8. **Settings → Reset demo data** returns everything to a known state for the next run.

Other seeded cases:
- **INC-1043**: insufficient evidence. The system says so rather than inventing a cause.
- **INC-1044**: contains a prompt-injection log line and a fake password. The line is treated as data, and the secret is redacted before analysis.

## How it works

```
web (React + Vite)  ──/api──▶  api (Fastify)  ──▶  SQLite (node:sqlite, FTS5)
                                   │
                                   ├─ evidence.ts   deterministic gathering (time window, same-service deploys)
                                   ├─ similar.ts    FTS5 bm25 search over past incidents (no model choice)
                                   ├─ packet.ts     sanitise → dedupe → bound (≤40 log groups, ≤24k chars), typed IDs
                                   ├─ llm/          Claude (live) or recorded provider
                                   └─ validate.ts   drop unknown citations, unsafe checks, clip sizes, score + rank
```

- **Typed evidence IDs** (`log:`, `dep:`, `met:`, `tl:`, `doc:`, `hist:`) are given to the model. Any citation the server can't find in the packet is removed and recorded under *Validation notes*. A hypothesis left with no valid evidence is marked **speculative** and forced to low confidence.
- **Ranking score** = `2 × confidence weight (1/2/3) + min(supporting citations, 5) − counter-evidence count`. It is only used for ordering, never shown as a probability.
- **Similar incidents are retrieved by code.** The model only writes the explanation for each retrieved candidate.
- **Sanitisation** redacts bearer tokens, API keys, `password=`-style secrets, URL credentials, emails and card-like numbers when the packet is built. Stored logs are immutable; a trigger rejects UPDATEs.
- **Safety:** the system prompt treats all evidence as untrusted data. Recommended checks that describe destructive actions (`rm -rf`, `kubectl delete`, `DROP TABLE`, …) are stripped server-side.
- **Lifecycle:** `POST …/investigations` returns 202 and runs in the background (`queued → running → completed | failed`). The UI polls every 1.5 s. Malformed model output is retried once. Provider errors become a readable message and the incident page stays usable.
- **RCA versions:** generating again creates a new version, so edits to earlier versions are kept.

### API

| Endpoint | Purpose |
| --- | --- |
| `GET /api/incidents?status=&severity=&service=&q=&page=&page_size=` | List and filter incidents |
| `GET /api/incidents/:id` | Detail, latest investigation ID, RCA versions (`:id` = UUID or key) |
| `GET /api/incidents/:id/evidence` | Logs, error signals, deployments, metrics, timeline, runbooks |
| `POST /api/incidents/:id/investigations` | Start an investigation `{ question? }`, returns 202 |
| `GET /api/investigations/:id` | Status, stage, hypotheses with resolved evidence, similar incidents |
| `POST /api/investigations/:id/feedback` | `{ hypothesis_id?, helpful?, comment?, verified_root_cause? }` |
| `POST /api/incidents/:id/rca-drafts` | Generate an RCA version from a completed investigation |
| `GET/PATCH /api/rca-drafts/:id` | Read or save RCA edits |
| `GET /api/rca-drafts/:id/export.md` | Markdown export |
| `GET /api/knowledge/:id` | Runbook or historical RCA document |
| `POST /api/demo/reset` | Reseed (requires `DEMO_MODE=true` and a localhost caller) |

## Tests

```bash
npm test            # Vitest: pipeline + API (in-memory DB, recorded/scripted providers)
npm run e2e         # Playwright smoke: queue → investigation → evidence → similar → RCA edit/save/export
npm run typecheck
```

Covered: happy path, insufficient evidence, invalid evidence IDs, prompt injection, secret redaction, retry on malformed output, provider failure, RCA edit persistence and versioning, demo reset (including determinism across runs), log immutability.

## Known limitations

- Synthetic data only; there are no live integrations. A real adapter (one observability source, behind an interface) is the next step.
- No authentication. The API binds to 127.0.0.1, and demo reset is restricted to localhost.
- Retrieval is keyword/FTS5 only; there is no vector search.
- Investigations run in-process. A server restart marks in-flight runs as failed.
- Model confidence is qualitative and uncalibrated.

## Deviations from the original spec

- **SQLite (`node:sqlite`) instead of Supabase**, so a reviewer can run the app from this README with no cloud account. The schema maps directly to Postgres.
- **The RCA comes from a separate call** after the investigation, instead of being part of the investigation output. This leaves one path for generating RCAs, and lets the RCA use engineer feedback.
- **Added tables** `metric_snapshots`, `timeline_events`, `evidence_links` and `investigation_similar_incidents`, which the spec's UI and API needed but its data model lacked.
