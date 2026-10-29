import { randomUUID } from "node:crypto";
import type { Incident, PatchRcaBody, RcaDraft } from "@resolveai/shared";
import { all, type Db, get, json, run } from "../db/index.js";
import { LlmError } from "../llm/provider.js";
import { packetText, validateRca } from "../pipeline/validate.js";
import { callWithRetry, type Deps, getInvestigation, getInvestigationRow, getPacket, withTimeout } from "./investigations.js";

interface RcaRow {
  id: string;
  incident_id: string;
  investigation_id: string;
  version: number;
  status: "draft" | "reviewed";
  impact: string;
  timeline: string;
  root_cause: string;
  contributing_factors: string;
  resolution_steps: string;
  prevention_actions: string;
  evidence_ids: string;
  validation_issues: string;
  llm_mode: "live" | "recorded";
  generated_at: string;
  updated_at: string;
}

function toDto(r: RcaRow): RcaDraft {
  return {
    id: r.id,
    incident_id: r.incident_id,
    investigation_id: r.investigation_id,
    version: r.version,
    status: r.status,
    impact: r.impact,
    timeline: json(r.timeline, []),
    root_cause: r.root_cause,
    contributing_factors: json(r.contributing_factors, []),
    resolution_steps: json(r.resolution_steps, []),
    prevention_actions: json(r.prevention_actions, []),
    evidence_ids: json(r.evidence_ids, []),
    validation_issues: json(r.validation_issues, []),
    llm_mode: r.llm_mode,
    generated_at: r.generated_at,
    updated_at: r.updated_at,
  };
}

export function getRca(db: Db, id: string): RcaDraft | undefined {
  const row = get<RcaRow>(db, "SELECT * FROM rca_drafts WHERE id = ?", id);
  return row && toDto(row);
}

export function listRcas(db: Db, incidentId: string): RcaDraft[] {
  return all<RcaRow>(db, "SELECT * FROM rca_drafts WHERE incident_id = ? ORDER BY version DESC", incidentId).map(toDto);
}

/**
 * Generates a new RCA version from a completed investigation. Earlier versions (and any edits to
 * them) are kept; regenerating never overwrites a human's changes.
 */
export async function createRca(deps: Deps, incident: Incident, investigationId: string): Promise<RcaDraft> {
  const { db, llm } = deps;
  const row = getInvestigationRow(db, investigationId);
  if (!row || row.incident_id !== incident.id) throw new LlmError("That investigation does not belong to this incident.");
  if (row.status !== "completed") throw new LlmError("Run an investigation to completion before drafting an RCA.");
  const inv = getInvestigation(db, investigationId)!;
  const packet = getPacket(row);
  if (!packet) throw new LlmError("The investigation has no stored evidence packet.");

  const feedback = all<{ comment: string | null; verified_root_cause: string | null }>(db,
    "SELECT comment, verified_root_cause FROM feedback WHERE investigation_id = ? ORDER BY created_at, rowid", investigationId);
  const verified = feedback.map((f) => f.verified_root_cause).filter(Boolean).at(-1) ?? null;

  const issues: string[] = [];
  const result = await withTimeout(
    callWithRetry(() => llm.draftRca({
      packet,
      summary: inv.summary,
      hypotheses: inv.hypotheses.map((h) => ({
        rank: h.rank,
        title: h.title,
        explanation: h.explanation,
        confidence: h.confidence,
        speculative: h.speculative,
        evidence_ids: h.evidence.map((e) => e.ref),
        helpful: h.feedback?.helpful ?? null,
      })),
      verified_root_cause: verified,
      engineer_notes: feedback.map((f) => f.comment).filter((c): c is string => !!c),
      similar: inv.similar_incidents.map((s) => ({
        id: s.historical.ref, key: s.historical.key, root_cause: s.historical.root_cause, resolution: s.historical.resolution,
      })),
    }), issues),
    180_000,
    "Drafting the RCA took too long and was stopped. Try again.",
  );

  const sourceText = [packetText(packet), verified ?? "", ...feedback.map((f) => f.comment ?? "")].join("\n");
  const v = validateRca(result.output, new Set(packet.items.map((i) => i.id)), sourceText);
  const { rca, evidence_ids } = v;
  issues.push(...v.issues);
  const version = (get<{ v: number | null }>(db, "SELECT MAX(version) AS v FROM rca_drafts WHERE incident_id = ?", incident.id)?.v ?? 0) + 1;
  const id = randomUUID();
  const ts = new Date().toISOString();
  run(db,
    `INSERT INTO rca_drafts (id, incident_id, investigation_id, version, status, impact, timeline, root_cause,
                             contributing_factors, resolution_steps, prevention_actions, evidence_ids, validation_issues, llm_mode,
                             generated_at, updated_at)
     VALUES (?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id, incident.id, investigationId, version, rca.impact, JSON.stringify(rca.timeline), rca.root_cause,
    JSON.stringify(rca.contributing_factors), JSON.stringify(rca.resolution_steps), JSON.stringify(rca.prevention_actions),
    JSON.stringify(evidence_ids), JSON.stringify(issues), llm.mode, ts, ts);
  return getRca(db, id)!;
}

export function patchRca(db: Db, id: string, patch: PatchRcaBody): RcaDraft | undefined {
  const existing = getRca(db, id);
  if (!existing) return undefined;
  const sets: string[] = [];
  const params: string[] = [];
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    sets.push(`${key} = ?`);
    params.push(typeof value === "string" ? value : JSON.stringify(value));
  }
  sets.push("updated_at = ?");
  params.push(new Date().toISOString());
  run(db, `UPDATE rca_drafts SET ${sets.join(", ")} WHERE id = ?`, ...params, id);
  return getRca(db, id);
}

const bullets = (xs: string[]) => (xs.length ? xs.map((x) => `- ${x}`).join("\n") : "- _None recorded_");

export function rcaMarkdown(rca: RcaDraft, incident: Incident): string {
  return `# Post-incident report: ${incident.key} — ${incident.title}

> **AI-generated draft — review required.** Status: ${rca.status}. Version ${rca.version}, generated ${rca.generated_at}, last edited ${rca.updated_at}.
> Source: ResolveAI demo dataset (synthetic data, not live telemetry).

| Field | Value |
| --- | --- |
| Service | ${incident.service_name} |
| Severity | ${incident.severity} |
| Environment | ${incident.environment} |
| Started | ${incident.started_at} |
| Detected | ${incident.detected_at} |

## Impact

${rca.impact}

## Timeline (UTC)

${rca.timeline.length ? rca.timeline.map((e) => `- **${e.timestamp}** — ${e.event}${e.evidence_ids.length ? ` _(evidence: ${e.evidence_ids.join(", ")})_` : ""}`).join("\n") : "- _None recorded_"}

## Root cause

${rca.root_cause}

## Contributing factors

${bullets(rca.contributing_factors)}

## Resolution

${bullets(rca.resolution_steps)}

## Preventive actions

${bullets(rca.prevention_actions)}
`;
}
