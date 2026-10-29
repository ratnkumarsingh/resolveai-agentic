import { randomUUID } from "node:crypto";
import type {
  Hypothesis,
  Incident,
  Investigation,
  InvestigationStatus,
  RecommendedCheck,
  ResolvedEvidence,
  SimilarIncidentResult,
  HistoricalIncident,
} from "@resolveai/shared";
import { evidenceId } from "@resolveai/shared";
import { all, type Db, get, json, run, tx } from "../db/index.js";
import { PROMPT_VERSION } from "../llm/prompts.js";
import { LlmError, type LlmProvider, type LlmResult } from "../llm/provider.js";
import { loadEvidence } from "../pipeline/evidence.js";
import { buildPacket, type EvidencePacket } from "../pipeline/packet.js";
import { findSimilar } from "../pipeline/similar.js";
import { validateInvestigation } from "../pipeline/validate.js";

export interface Deps {
  db: Db;
  llm: LlmProvider;
}

const OVERALL_TIMEOUT_MS = 180_000;

const now = () => new Date().toISOString();

/** Creates a queued investigation and runs it in the background. Returns its ID immediately. */
export function startInvestigation(deps: Deps, incident: Incident, question: string | null): string {
  const id = randomUUID();
  run(deps.db,
    `INSERT INTO investigations (id, incident_id, status, stage, question, llm_mode, prompt_version, started_at)
     VALUES (?, ?, 'queued', 'Queued', ?, ?, ?, ?)`,
    id, incident.id, question, deps.llm.mode, PROMPT_VERSION, now());
  setImmediate(() => {
    runInvestigation(deps, id, incident, question).catch((err) => failInvestigation(deps.db, id, err));
  });
  return id;
}

function setStage(db: Db, id: string, status: InvestigationStatus, stage: string) {
  run(db, "UPDATE investigations SET status = ?, stage = ? WHERE id = ?", status, stage, id);
}

function failInvestigation(db: Db, id: string, err: unknown) {
  const message = err instanceof LlmError ? err.message : "The investigation failed unexpectedly. The incident data is unchanged; try again.";
  if (!(err instanceof LlmError)) console.error(`investigation ${id} failed:`, err);
  run(db, "UPDATE investigations SET status = 'failed', stage = NULL, error_message = ?, completed_at = ? WHERE id = ?", message, now(), id);
}

export async function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([p, new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new LlmError(message)), ms)))]);
  } finally {
    clearTimeout(timer);
  }
}

/** Calls the model, retrying once when the failure is malformed output. */
export async function callWithRetry<T>(fn: () => Promise<LlmResult<T>>, issues: string[]): Promise<LlmResult<T>> {
  try {
    return await fn();
  } catch (err) {
    if (!(err instanceof LlmError && err.retryable)) throw err;
    issues.push(`First model response was rejected (${err.message}); retried once.`);
    return await fn();
  }
}

async function runInvestigation(deps: Deps, id: string, incident: Incident, question: string | null) {
  const { db, llm } = deps;

  setStage(db, id, "running", "Gathering logs, deployments and metrics");
  const evidence = loadEvidence(db, incident);

  setStage(db, id, "running", "Searching incident history");
  const similar = findSimilar(db, evidence);
  const packet = buildPacket(evidence, similar, question);
  run(db, "UPDATE investigations SET evidence_packet = ? WHERE id = ?", JSON.stringify(packet), id);

  setStage(db, id, "running", llm.mode === "live" ? "Analysing evidence with Claude" : "Analysing evidence (recorded mode)");
  const issues: string[] = [];
  const result = await withTimeout(
    callWithRetry(() => llm.investigate(packet), issues),
    OVERALL_TIMEOUT_MS,
    "The analysis took too long and was stopped. Try again; the incident data is unchanged.",
  );
  const v = validateInvestigation(result.output, packet);
  issues.push(...v.issues);
  if (packet.redactions > 0) issues.push(`Redacted ${packet.redactions} secret or personal value(s) before analysis.`);
  if (packet.truncated) issues.push("Evidence packet was trimmed to fit the size limit; lower-priority log lines were left out.");

  tx(db, () => {
    for (const h of v.hypotheses) {
      const hid = randomUUID();
      run(db,
        `INSERT INTO hypotheses (id, investigation_id, rank, title, explanation, confidence, score, speculative, counter_evidence, unknowns, recommended_checks)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        hid, id, h.rank, h.title, h.explanation, h.confidence, h.score, h.speculative ? 1 : 0,
        JSON.stringify(h.counter_evidence), JSON.stringify(h.unknowns), JSON.stringify(h.recommended_checks));
      h.evidence_ids.forEach((ref, i) => run(db, "INSERT INTO evidence_links (hypothesis_id, evidence_ref, position) VALUES (?, ?, ?)", hid, ref, i));
    }
    similar.forEach((c, i) => {
      const reason = v.similar_reasons.get(c.historical.ref)
        ?? `Matched on: ${c.matched_terms.slice(0, 6).join(", ")}${c.historical.service_name === incident.service_name ? " (same service)" : ""}.`;
      run(db,
        `INSERT INTO investigation_similar_incidents (investigation_id, historical_incident_id, rank, match_score, matched_terms, similarity_reason)
         VALUES (?, ?, ?, ?, ?, ?)`,
        id, c.historical.id, i + 1, c.match_score, JSON.stringify(c.matched_terms), reason);
    });
    run(db,
      `UPDATE investigations SET status = 'completed', stage = NULL, model_name = ?, summary = ?, insufficient_evidence = ?,
              limitations = ?, validation_issues = ?, usage = ?, completed_at = ? WHERE id = ?`,
      result.model, v.summary, v.insufficient_evidence ? 1 : 0, JSON.stringify(v.limitations), JSON.stringify(issues),
      result.usage ? JSON.stringify(result.usage) : null, now(), id);
  });
}

// ---------------------------------------------------------------------------
// Read model
// ---------------------------------------------------------------------------

interface InvestigationRow {
  id: string;
  incident_id: string;
  status: InvestigationStatus;
  stage: string | null;
  question: string | null;
  llm_mode: "live" | "recorded";
  evidence_packet: string | null;
  model_name: string | null;
  prompt_version: string;
  summary: string | null;
  insufficient_evidence: number;
  limitations: string;
  validation_issues: string;
  started_at: string;
  completed_at: string | null;
  error_message: string | null;
}

export function getInvestigationRow(db: Db, id: string) {
  return get<InvestigationRow>(db, "SELECT * FROM investigations WHERE id = ?", id);
}

export function getPacket(row: { evidence_packet: string | null }): EvidencePacket | null {
  return json<EvidencePacket | null>(row.evidence_packet, null);
}

const KIND_LABEL: Record<string, string> = {
  log: "Log", dep: "Deployment", met: "Metric", doc: "Runbook", hist: "Past incident", tl: "Timeline",
};

export function resolveEvidence(packet: EvidencePacket | null, refs: string[]): ResolvedEvidence[] {
  const byId = new Map(packet?.items.map((i) => [i.id, i]) ?? []);
  return refs.map((ref) => {
    const item = byId.get(ref);
    const kind = ref.slice(0, ref.indexOf(":"));
    return {
      ref,
      kind,
      label: `${KIND_LABEL[kind] ?? kind}${item?.occurrences ? ` ×${item.occurrences}` : ""}`,
      excerpt: item?.excerpt ?? "(record not in packet)",
      timestamp: item?.timestamp ?? null,
    };
  });
}

export function getInvestigation(db: Db, id: string): (Investigation & { stage: string | null }) | undefined {
  const row = getInvestigationRow(db, id);
  if (!row) return undefined;
  const packet = getPacket(row);

  const hypotheses: Hypothesis[] = all<{
    id: string; rank: number; title: string; explanation: string; confidence: Hypothesis["confidence"]; score: number;
    speculative: number; counter_evidence: string; unknowns: string; recommended_checks: string;
  }>(db, "SELECT * FROM hypotheses WHERE investigation_id = ? ORDER BY rank", id).map((h) => {
    const refs = all<{ evidence_ref: string }>(db,
      "SELECT evidence_ref FROM evidence_links WHERE hypothesis_id = ? ORDER BY position", h.id).map((r) => r.evidence_ref);
    const fb = get<{ helpful: number | null }>(db,
      "SELECT helpful FROM feedback WHERE hypothesis_id = ? AND helpful IS NOT NULL ORDER BY created_at DESC, rowid DESC LIMIT 1", h.id);
    return {
      id: h.id,
      rank: h.rank,
      title: h.title,
      explanation: h.explanation,
      confidence: h.confidence,
      score: h.score,
      speculative: !!h.speculative,
      evidence: resolveEvidence(packet, refs),
      counter_evidence: json<string[]>(h.counter_evidence, []),
      unknowns: json<string[]>(h.unknowns, []),
      recommended_checks: json<RecommendedCheck[]>(h.recommended_checks, []),
      feedback: fb ? { helpful: fb.helpful === null ? null : !!fb.helpful } : null,
    };
  });

  const similar_incidents: SimilarIncidentResult[] = all<HistoricalIncident & { match_score: number; matched_terms: string; similarity_reason: string }>(db,
    `SELECT h.id, h.key, h.title, h.service_name, h.symptoms, h.root_cause, h.resolution, h.resolved_at, h.rca_document_id,
            s.match_score, s.matched_terms, s.similarity_reason
       FROM investigation_similar_incidents s JOIN historical_incidents h ON h.id = s.historical_incident_id
      WHERE s.investigation_id = ? ORDER BY s.rank`, id,
  ).map(({ match_score, matched_terms, similarity_reason, ...h }) => ({
    historical: { ...h, ref: evidenceId("hist", h.id) },
    match_score,
    matched_terms: json<string[]>(matched_terms, []),
    similarity_reason,
  }));

  return {
    id: row.id,
    incident_id: row.incident_id,
    status: row.status,
    stage: row.stage,
    question: row.question,
    llm_mode: row.llm_mode,
    model_name: row.model_name,
    prompt_version: row.prompt_version,
    started_at: row.started_at,
    completed_at: row.completed_at,
    error_message: row.error_message,
    summary: row.summary,
    insufficient_evidence: !!row.insufficient_evidence,
    limitations: json<string[]>(row.limitations, []),
    validation_issues: json<string[]>(row.validation_issues, []),
    hypotheses,
    similar_incidents,
    evidence_count: packet?.items.length ?? 0,
  };
}

export function latestInvestigationId(db: Db, incidentId: string): string | undefined {
  return get<{ id: string }>(db,
    "SELECT id FROM investigations WHERE incident_id = ? ORDER BY started_at DESC, rowid DESC LIMIT 1", incidentId)?.id;
}
