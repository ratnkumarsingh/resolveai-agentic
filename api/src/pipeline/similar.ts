import type { HistoricalIncident, IncidentEvidence } from "@resolveai/shared";
import { evidenceId } from "@resolveai/shared";
import { all, type Db } from "../db/index.js";

export interface SimilarCandidate {
  historical: HistoricalIncident;
  match_score: number;
  matched_terms: string[];
}

const STOPWORDS = new Set(
  "the and for with from that this are was were has have had not but all any can its into out our over per than then they".split(" ")
    .concat("after before about been being did does more most some such only very request requests failed error errors".split(" ")),
);

export function terms(text: string): string[] {
  return [...new Set(text.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !STOPWORDS.has(w) && !/^\d+$/.test(w)))];
}

/**
 * Deterministic similar-incident retrieval: FTS5 bm25 over historical incidents, boosted for the same
 * service. The model never chooses which incidents are similar; it only explains the matches.
 */
export function findSimilar(db: Db, evidence: IncidentEvidence, limit = 5): SimilarCandidate[] {
  const { incident } = evidence;
  const queryText = [
    incident.title,
    incident.description,
    ...evidence.error_signals.map((s) => s.signature),
    ...evidence.deployments.filter((d) => d.service_name === incident.service_name).map((d) => d.change_summary),
  ].join(" ");
  const queryTerms = terms(queryText);
  if (queryTerms.length === 0) return [];

  const match = queryTerms.map((w) => `"${w}"`).join(" OR ");
  const rows = all<HistoricalIncident & { rank: number }>(db,
    `SELECT h.id, h.key, h.title, h.service_name, h.symptoms, h.root_cause, h.resolution, h.resolved_at, h.rca_document_id,
            bm25(historical_fts) AS rank
       FROM historical_fts JOIN historical_incidents h ON h.id = historical_fts.id
      WHERE historical_fts MATCH ?
      ORDER BY rank LIMIT 20`,
    match,
  );

  const scored = rows
    .map(({ rank, ...h }) => {
      const haystack = new Set(terms(`${h.title} ${h.symptoms} ${h.root_cause} ${h.resolution}`));
      const matched = queryTerms.filter((w) => haystack.has(w));
      // bm25 is negative (lower is better); flip it and add a same-service boost.
      const score = -rank * 10 + matched.length + (h.service_name === incident.service_name ? 3 : 0);
      return { historical: { ...h, ref: evidenceId("hist", h.id) }, match_score: Math.round(score * 100) / 100, matched_terms: matched };
    })
    .filter((c) => c.matched_terms.length >= 2)
    .sort((a, b) => b.match_score - a.match_score);
  // Drop weak tail matches: anything scoring under 35% of the best candidate is noise.
  const best = scored[0]?.match_score ?? 0;
  return scored.filter((c) => c.match_score >= best * 0.35).slice(0, limit);
}
