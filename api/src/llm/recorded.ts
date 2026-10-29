import type { InvestigationOutput, LlmHypothesis, RcaOutput } from "@resolveai/shared";
import { stableId } from "../db/seed.js";
import type { EvidencePacket, PacketItem } from "../pipeline/packet.js";
import type { LlmProvider, LlmResult, RcaInput } from "./provider.js";

/**
 * Offline provider for deterministic demos and tests. INC-1042 replays a recorded analysis; other
 * incidents get a simple rule-based analysis built only from packet items. Either way the output goes
 * through the same validation as a live model response.
 */
export class RecordedProvider implements LlmProvider {
  readonly mode = "recorded" as const;
  readonly model = null;

  constructor(private readonly delayMs = 1200) {}

  async investigate(packet: EvidencePacket): Promise<LlmResult<InvestigationOutput>> {
    await sleep(this.delayMs);
    const fixture = FIXTURES[packet.incident.key];
    return { output: fixture ? fixture() : heuristicInvestigation(packet), model: null };
  }

  async draftRca(input: RcaInput): Promise<LlmResult<RcaOutput>> {
    await sleep(this.delayMs / 2);
    return { output: heuristicRca(input), model: null };
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const log = (inc: string, name: string) => `log:${stableId(`log:${inc}:${name}`)}`;
const met = (inc: string, name: string) => `met:${stableId(`met:${inc}:${name}`)}`;
const dep = (name: string) => `dep:${stableId(`dep:${name}`)}`;
const hist = (name: string) => `hist:${stableId(`hist:${name}`)}`;

const FIXTURES: Record<string, () => InvestigationOutput> = {
  "INC-1042": () => ({
    summary:
      "HTTP 500s on payment-api began about four minutes after v2.8.1 rolled out. The release moved database client settings into db-client.yaml, and the service logged pool.max=20 at startup where the 09:58 health check showed max=100. Requests then queued for connections and timed out while payments-db itself stayed healthy. This matches INC-0881, a pool-size regression after a config change. The leading hypothesis is not confirmed until an engineer compares the effective pool configuration with v2.8.0.",
    insufficient_evidence: false,
    hypotheses: [
      {
        title: "v2.8.1 config change reduced the DB connection pool (100 → 20), exhausting it under normal load",
        explanation:
          "The v2.8.1 deployment changed database client configuration. After rollout the service loaded pool.max=20, whereas the pre-deploy health check showed max=100. Within four minutes the pool was full (in_use=20, 14 waiting) and connection acquisition began timing out, which surfaced as HTTP 500s. Pool connections in use rose to exactly the new limit, while the database reported ample capacity.",
        confidence: "high",
        evidence_ids: [
          dep("pay-281"), log("INC-1042", "health"), log("INC-1042", "config"), log("INC-1042", "saturated"),
          log("INC-1042", "timeout-a"), met("INC-1042", "DB pool connections in use"), hist("hist-0881"),
        ],
        counter_evidence: ["Errors started ~4 minutes after rollout began; a traffic ramp would explain the lag but traffic volume is not in the packet."],
        unknowns: ["Whether pool.max=20 was intentional in the v2.8.1 change", "Request volume compared with the same time on previous days"],
        recommended_checks: [
          {
            step: "Compare the effective pool.max and acquireTimeoutMs between v2.8.0 and v2.8.1 (db-client.yaml and the previous config source).",
            why: "Confirms whether the release changed the pool size rather than load increasing.",
            expected_signal: "v2.8.0 resolved pool.max to 100 (or similar); v2.8.1 resolves to 20.",
          },
          {
            step: "Check the pool utilisation dashboard for every payment-api pod since 10:00.",
            why: "Pool exhaustion should be visible on all pods running v2.8.1.",
            expected_signal: "in_use pinned at max with a growing wait queue on all pods.",
          },
          {
            step: "Confirm payments-db has connection and CPU headroom for the full window.",
            why: "Rules out the database itself as the bottleneck.",
            expected_signal: "Active connections far below max_connections; CPU flat.",
          },
        ],
      },
      {
        title: "payments-db unavailable or overloaded",
        explanation:
          "Connection acquisition timeouts can be caused by a database that is slow to accept connections. The packet contains timeouts but no database-side errors.",
        confidence: "low",
        evidence_ids: [log("INC-1042", "timeout-a")],
        counter_evidence: [
          "payments-db reported active_connections=20 of max_connections=500, CPU 22% and no replication lag at 10:07.",
          "Database CPU stayed flat (21% → 23%) through the incident.",
        ],
        unknowns: ["Database slow-query log for the window"],
        recommended_checks: [
          {
            step: "Review payments-db slow-query and connection logs from 10:00 to 10:15.",
            why: "A database-side cause would show refused or slow connection handshakes.",
            expected_signal: "No refused connections or slow handshakes, which would rule this out.",
          },
        ],
      },
      {
        title: "Load increase from the checkout-web v5.2.0 release",
        explanation:
          "checkout-web deployed v5.2.0 at 09:30. If the new address autocomplete widget issued extra payment calls, increased load could exhaust the pool.",
        confidence: "low",
        evidence_ids: [dep("checkout-520")],
        counter_evidence: ["The release was 34 minutes before errors began and its change summary concerns address autocomplete, not payments."],
        unknowns: ["Payment request rate from checkout-web before and after 09:30"],
        recommended_checks: [
          {
            step: "Compare payment-api request rate from checkout-web before and after 09:30.",
            why: "Distinguishes a load increase from a capacity reduction.",
            expected_signal: "Flat request rate, which would rule this out.",
          },
        ],
      },
    ],
    similar_incidents: [
      {
        incident_id: hist("hist-0881"),
        similarity_reason:
          "Same service and the same pattern: HTTP 500s and database connection timeouts right after a configuration change, with a healthy database. INC-0881's root cause was an incorrect max connection setting.",
      },
    ],
    limitations: [
      "Request volume and per-pod pool metrics are not in the packet.",
      "The v2.8.0 configuration file itself is not available; the previous pool size comes from a health-check log line.",
      "The payment-api database connectivity runbook recommends comparing configuration with the last healthy deployment before any rollback decision.",
    ],
  }),
};

// ---------------------------------------------------------------------------
// Rule-based fallback for incidents without a recorded fixture
// ---------------------------------------------------------------------------

const humanize = (signature: string) => signature.replace(/_/g, " ");

function heuristicInvestigation(packet: EvidencePacket): InvestigationOutput {
  const { incident, items } = packet;
  const logs = items.filter((i) => i.type === "log");
  const bySignature = new Map<string, PacketItem[]>();
  for (const l of logs) {
    const sig = /\[signature=([^\]]+)\]/.exec(l.excerpt)?.[1];
    if (sig) bySignature.set(sig, [...(bySignature.get(sig) ?? []), l]);
  }
  const weight = (xs: PacketItem[]) => xs.reduce((n, x) => n + (x.occurrences ?? 1), 0);
  const signals = [...bySignature.entries()].sort((a, b) => weight(b[1]) - weight(a[1]));
  const start = Date.parse(incident.started_at);
  const recentDeploys = items.filter(
    (i) => i.type === "deployment" && i.excerpt.startsWith(`${incident.service}`) &&
      i.timestamp && start - Date.parse(i.timestamp) <= 2 * 3600_000 && start >= Date.parse(i.timestamp),
  );
  const bigMetrics = items.filter((i) => {
    const m = /baseline ([\d.]+) .* peak ([\d.]+)/.exec(i.excerpt);
    return i.type === "metric" && m && Number(m[2]) >= Math.max(3 * Number(m[1]), Number(m[1]) + 1);
  });
  const sameServiceHistory = items.filter((i) => i.type === "historical_incident" && i.excerpt.includes(`(${incident.service})`));

  const hypotheses: LlmHypothesis[] = [];

  if (signals.length > 0) {
    const [sig, sigLogs] = signals[0];
    const n = weight(sigLogs);
    hypotheses.push({
      title: `${humanize(sig)} is the primary failure mode`,
      explanation: `The most frequent error signature in the window is "${sig}" (${n} occurrence${n === 1 ? "" : "s"}). ${bigMetrics.length ? "Related metrics moved sharply over the same period." : "No supporting metric movement is in the packet."}`,
      confidence: n >= 3 && bigMetrics.length ? "medium" : "low",
      evidence_ids: [...sigLogs.slice(0, 3).map((l) => l.id), ...bigMetrics.map((m) => m.id)],
      counter_evidence: [],
      unknowns: ["What changed to trigger this failure mode"],
      recommended_checks: [
        {
          step: `Find when "${sig}" first appeared and whether it correlates with traffic, a dependency or a configuration change.`,
          why: "Establishes the trigger rather than the symptom.",
          expected_signal: "A clear onset time that lines up with a specific change.",
        },
      ],
    });
  }

  if (recentDeploys.length > 0 && signals.length > 0) {
    const d = recentDeploys[0];
    hypotheses.push({
      title: `Regression introduced by the recent ${incident.service} deployment`,
      explanation: `A deployment of ${incident.service} landed shortly before the incident started: ${d.excerpt}`,
      confidence: "medium",
      evidence_ids: [d.id, signals[0][1][0].id],
      counter_evidence: [],
      unknowns: ["Whether the deployed change touches the failing code path"],
      recommended_checks: [
        {
          step: "Diff the deployed change against the previous version for the failing component.",
          why: "Confirms or rules out the release as the trigger.",
          expected_signal: "A change in the component named by the error signature.",
        },
      ],
    });
  }

  if (sameServiceHistory.length > 0 && signals.length > 0) {
    const h = sameServiceHistory[0];
    hypotheses.push({
      title: `Recurrence of a past incident (${h.excerpt.split(" ")[0]})`,
      explanation: `A previous incident on ${incident.service} had matching symptoms. ${h.excerpt}`,
      confidence: "low",
      evidence_ids: [h.id, signals[0][1][0].id],
      counter_evidence: [],
      unknowns: ["Whether the previous fix is still in place"],
      recommended_checks: [
        {
          step: "Check whether the previous incident's trigger is present again.",
          why: "Past root causes often recur when the fix was partial.",
          expected_signal: "The same trigger condition visible in the current window.",
        },
      ],
    });
  }

  if (signals.length > 1) {
    const [sig, sigLogs] = signals[1];
    hypotheses.push({
      title: `Secondary failure: ${humanize(sig)}`,
      explanation: `A second error signature "${sig}" appears in the window; it may be a separate issue or a downstream effect.`,
      confidence: "low",
      evidence_ids: sigLogs.slice(0, 2).map((l) => l.id),
      counter_evidence: [],
      unknowns: ["Whether this error is related to the primary failure"],
      recommended_checks: [
        {
          step: `Check whether "${sig}" also occurs outside the incident window.`,
          why: "Distinguishes a pre-existing issue from part of this incident.",
          expected_signal: "Occurrences only within the incident window.",
        },
      ],
    });
  }

  const insufficient = hypotheses.length === 0;
  return {
    summary: insufficient
      ? `The packet for ${incident.key} contains no error signatures, recent ${incident.service} deployments or significant metric changes. There is insufficient evidence to propose a root cause.`
      : `Rule-based analysis of ${incident.key} (${incident.service}) found ${signals.length} error signature(s)${recentDeploys.length ? " and a recent deployment" : ""}. The hypotheses below are candidates for an engineer to verify.`,
    insufficient_evidence: insufficient,
    hypotheses,
    similar_incidents: [],
    limitations: [
      "Recorded/offline mode: this analysis was produced by deterministic rules, not by a live model call.",
      ...(insufficient ? ["Collect error logs, deployment history and metrics for the affected window, then run the investigation again."] : []),
    ],
  };
}

function heuristicRca(input: RcaInput): RcaOutput {
  const { packet } = input;
  const top = input.hypotheses.find((h) => !h.speculative);
  const start = Date.parse(packet.incident.started_at);
  const timelineStamps = new Set(packet.items.filter((i) => i.type === "timeline").map((i) => i.timestamp));
  // Same-service deployments within 2h before the start, unless the incident timeline already records them.
  const timelineItems = packet.items.filter((i) => i.type === "timeline" || (
    i.type === "deployment" && i.excerpt.startsWith(packet.incident.service) && i.timestamp && !timelineStamps.has(i.timestamp) &&
    start - Date.parse(i.timestamp) <= 2 * 3600_000 && start >= Date.parse(i.timestamp)
  ));
  const firstError = packet.items.find((i) => i.type === "log" && /^ERROR/.test(i.excerpt));

  const timeline = timelineItems
    .filter((i) => i.timestamp)
    .map((i) => ({ timestamp: i.timestamp!, event: i.type === "deployment" ? `Deployment: ${i.excerpt}` : i.excerpt, evidence_ids: [i.id] }));
  if (firstError?.timestamp) {
    timeline.push({ timestamp: firstError.timestamp, event: `First error logged: ${firstError.excerpt}`, evidence_ids: [firstError.id] });
  }
  timeline.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  const rootCause = input.verified_root_cause
    ? `Verified by engineer: ${input.verified_root_cause}`
    : top
      ? `Suspected (not yet confirmed): ${top.title}. ${top.explanation}`
      : "Root cause not determined; evidence was insufficient.";

  return {
    impact: `${packet.incident.impact_summary} Severity ${packet.incident.severity} in ${packet.incident.environment}.`,
    timeline,
    root_cause: rootCause,
    contributing_factors: input.hypotheses
      .filter((h) => h !== top && !h.speculative)
      .map((h) => `Considered: ${h.title} (${h.confidence} confidence)`)
      .concat(input.engineer_notes.map((n) => `Engineer note: ${n}`)),
    resolution_steps: [
      top ? `Validate the leading hypothesis: ${top.title}.` : "Gather additional evidence for the affected window.",
      "Record the verified cause and the action taken in this report before closing the incident.",
    ],
    prevention_actions: [
      ...input.similar.slice(0, 1).map((s) => `Revisit the prevention actions from ${s.key}: ${s.resolution}.`),
      "Add an alert on the leading error signature so recurrence is detected earlier.",
    ],
  };
}
