import type { Confidence, InvestigationOutput, RcaOutput, RecommendedCheck } from "@resolveai/shared";
import type { EvidencePacket } from "./packet.js";
import { scoreHypothesis } from "./score.js";

export interface ValidatedHypothesis {
  rank: number;
  title: string;
  explanation: string;
  confidence: Confidence;
  score: number;
  speculative: boolean;
  evidence_ids: string[];
  counter_evidence: string[];
  unknowns: string[];
  recommended_checks: RecommendedCheck[];
}

export interface ValidatedInvestigation {
  summary: string;
  insufficient_evidence: boolean;
  hypotheses: ValidatedHypothesis[];
  similar_reasons: Map<string, string>;
  limitations: string[];
  issues: string[];
}

const MAX_HYPOTHESES = 5;
const MAX_LIST = 8;
const MAX_CHECKS = 5;

/** Recommended checks must be read-only. This catches commands and actions that change state. */
const UNSAFE_ACTION =
  /\brm\s+-[a-z]*[rf]|\b(drop|truncate|delete\s+from|alter|update\s+\w+\s+set)\b.*\b(table|database|from|set)\b|\bkubectl\s+(delete|apply|scale|rollout\s+undo|edit)\b|\b(terraform|helm)\s+(apply|destroy|rollback|uninstall)\b|\bshutdown\b|\breboot\b|\bmkfs\b|\bchmod\s+777\b/i;

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const clipList = (xs: string[], n = MAX_LIST, len = 500) => xs.filter((x) => x.trim()).slice(0, n).map((x) => clip(x.trim(), len));

/**
 * Enforces the output contract beyond what the JSON schema can express: citations must reference
 * packet IDs, lists and strings are bounded, and hypotheses are ranked by a deterministic score.
 */
export function validateInvestigation(output: InvestigationOutput, packet: EvidencePacket): ValidatedInvestigation {
  const issues: string[] = [];
  const known = new Set(packet.items.map((i) => i.id));
  const candidates = new Set(packet.similar_candidates);

  if (output.hypotheses.length > MAX_HYPOTHESES) {
    issues.push(`Model returned ${output.hypotheses.length} hypotheses; kept the first ${MAX_HYPOTHESES}.`);
  }

  const hypotheses = output.hypotheses.slice(0, MAX_HYPOTHESES).map((h) => {
    const cited = [...new Set(h.evidence_ids.map((id) => id.trim()))];
    const valid = cited.filter((id) => known.has(id));
    for (const bad of cited.filter((id) => !known.has(id))) {
      issues.push(`Removed citation "${clip(bad, 80)}" from "${clip(h.title, 60)}": not in the evidence packet.`);
    }
    const speculative = valid.length === 0;
    const unknowns = clipList(h.unknowns);
    if (speculative) unknowns.unshift("No supporting evidence in the packet — speculative, insufficient evidence.");
    const counter = clipList(h.counter_evidence);
    // A hypothesis without valid evidence cannot be rated above low confidence.
    const confidence: Confidence = speculative ? "low" : h.confidence;
    return {
      rank: 0,
      title: clip(h.title.trim() || "Untitled hypothesis", 200),
      explanation: clip(h.explanation.trim(), 2000),
      confidence,
      score: scoreHypothesis(confidence, valid.length, counter.length),
      speculative,
      evidence_ids: valid,
      counter_evidence: counter,
      unknowns: unknowns.slice(0, MAX_LIST),
      recommended_checks: h.recommended_checks
        .filter((c) => {
          if (!UNSAFE_ACTION.test(`${c.step} ${c.why}`)) return true;
          issues.push(`Removed a recommended check from "${clip(h.title, 60)}": it described a destructive or state-changing action.`);
          return false;
        })
        .slice(0, MAX_CHECKS)
        .map((c) => ({
          step: clip(c.step, 400),
          why: clip(c.why, 400),
          expected_signal: clip(c.expected_signal, 400),
        })),
    };
  });

  hypotheses.sort((a, b) => b.score - a.score);
  hypotheses.forEach((h, i) => (h.rank = i + 1));

  const similar_reasons = new Map<string, string>();
  for (const s of output.similar_incidents) {
    if (candidates.has(s.incident_id)) similar_reasons.set(s.incident_id, clip(s.similarity_reason, 600));
    else issues.push(`Ignored similar incident "${clip(s.incident_id, 80)}": not among retrieved candidates.`);
  }

  const supported = hypotheses.filter((h) => !h.speculative);
  let insufficient = output.insufficient_evidence;
  if (!insufficient && supported.length === 0) {
    insufficient = true;
    issues.push("No hypothesis had valid supporting evidence; marked as insufficient evidence.");
  }

  return {
    summary: clip(output.summary.trim(), 2000),
    insufficient_evidence: insufficient,
    hypotheses,
    similar_reasons,
    limitations: clipList(output.limitations),
    issues,
  };
}

export function validateRca(output: RcaOutput, knownIds: Set<string>): { rca: RcaOutput; evidence_ids: string[]; issues: string[] } {
  const issues: string[] = [];
  const cited = new Set<string>();
  const timeline = output.timeline.slice(0, 30).map((e) => {
    const ids = e.evidence_ids.filter((id) => {
      if (knownIds.has(id)) {
        cited.add(id);
        return true;
      }
      issues.push(`Removed RCA timeline citation "${clip(id, 80)}": not in the investigation evidence.`);
      return false;
    });
    return { timestamp: clip(e.timestamp, 40), event: clip(e.event, 500), evidence_ids: ids };
  });
  timeline.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  return {
    rca: {
      impact: clip(output.impact, 3000),
      timeline,
      root_cause: clip(output.root_cause, 3000),
      contributing_factors: clipList(output.contributing_factors, 15, 1000),
      resolution_steps: clipList(output.resolution_steps, 15, 1000),
      prevention_actions: clipList(output.prevention_actions, 15, 1000),
    },
    evidence_ids: [...cited],
    issues,
  };
}
