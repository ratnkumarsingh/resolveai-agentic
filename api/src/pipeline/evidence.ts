import {
  evidenceId,
  type Deployment,
  type ErrorSignal,
  type Incident,
  type IncidentEvidence,
  type KnowledgeDocument,
  type LogEvent,
  type MetricSnapshot,
  type TimelineEvent,
} from "@resolveai/shared";
import { all, type Db } from "../db/index.js";

const MIN = 60_000;
const HOUR = 60 * MIN;

const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

/** Gathers the evidence for an incident deterministically: no model involvement. */
export function loadEvidence(db: Db, incident: Incident): IncidentEvidence {
  const start = Date.parse(incident.started_at);
  const detected = Date.parse(incident.detected_at);
  const windowFrom = iso(start - 30 * MIN);
  const windowTo = iso(Math.max(detected, start) + HOUR);

  // Logs for the affected service in the incident window, plus anything explicitly linked to it.
  const logs = all<Omit<LogEvent, "ref">>(db,
    `SELECT id, timestamp, service_name, level, message, error_signature, trace_id, source
       FROM log_events
      WHERE (service_name = ? OR incident_id = ?) AND timestamp BETWEEN ? AND ?
      ORDER BY timestamp LIMIT 200`,
    incident.service_name, incident.id, windowFrom, windowTo,
  ).map((l) => ({ ...l, ref: evidenceId("log", l.id) }));

  const signals = new Map<string, ErrorSignal>();
  for (const log of logs) {
    if (!log.error_signature) continue;
    const s = signals.get(log.error_signature);
    if (s) {
      s.count++;
      s.last_seen = log.timestamp;
    } else {
      signals.set(log.error_signature, { signature: log.error_signature, count: 1, first_seen: log.timestamp, last_seen: log.timestamp });
    }
  }

  // Same-service deployments in the 48h before the incident, and other services' deployments within ±1h.
  const deployments = all<Omit<Deployment, "ref">>(db,
    `SELECT id, service_name, environment, version, deployed_at, change_summary, commit_ref
       FROM deployments
      WHERE (service_name = ? AND deployed_at BETWEEN ? AND ?)
         OR (service_name <> ? AND deployed_at BETWEEN ? AND ?)
      ORDER BY deployed_at DESC LIMIT 20`,
    incident.service_name, iso(start - 48 * HOUR), windowTo,
    incident.service_name, iso(start - HOUR), iso(start + HOUR),
  ).map((d) => ({ ...d, ref: evidenceId("dep", d.id) }));

  const metrics = all<Omit<MetricSnapshot, "ref">>(db,
    "SELECT id, name, unit, baseline, peak, observed_at FROM metric_snapshots WHERE incident_id = ? ORDER BY name",
    incident.id,
  ).map((m) => ({ ...m, ref: evidenceId("met", m.id) }));

  const timeline = all<Omit<TimelineEvent, "ref">>(db,
    "SELECT id, timestamp, kind, description FROM timeline_events WHERE incident_id = ? ORDER BY timestamp",
    incident.id,
  ).map((e) => ({ ...e, ref: evidenceId("tl", e.id) }));

  const runbooks = all<Omit<KnowledgeDocument, "ref">>(db,
    `SELECT id, title, doc_type, service_name, body FROM knowledge_documents
      WHERE doc_type IN ('runbook', 'guide') AND (service_name = ? OR service_name IS NULL)
      ORDER BY doc_type DESC, title LIMIT 5`,
    incident.service_name,
  ).map((d) => ({ ...d, ref: evidenceId("doc", d.id) }));

  return {
    incident,
    timeline,
    logs,
    error_signals: [...signals.values()].sort((a, b) => b.count - a.count),
    deployments,
    metrics,
    runbooks,
  };
}
