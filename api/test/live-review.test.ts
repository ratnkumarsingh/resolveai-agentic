import { describe, expect, it } from "vitest";
import { numbersIn, unverifiedNumbers } from "../src/pipeline/validate.js";
import { RecordedProvider } from "../src/llm/recorded.js";
import { makeApp, output, runInvestigation, ScriptedProvider } from "./helpers.js";

const CODE = "s3cret-code";

/** Recorded by default; live (scripted) only on request with the access code. */
function gatedApp(liveDailyLimit = 10) {
  const live = new ScriptedProvider((p) => output({
    summary: "scripted live run",
    hypotheses: [{
      title: "Pool limit", explanation: "Pool is exhausted.", confidence: "medium",
      evidence_ids: [p.items[0].id], counter_evidence: [], unknowns: [], recommended_checks: [],
    }],
  }));
  return { ...makeApp(new RecordedProvider(0), { liveAccessCode: CODE, liveDailyLimit }, live), live };
}

const start = (app: ReturnType<typeof gatedApp>["app"], body: object, code?: string) =>
  app.inject({
    method: "POST", url: "/api/incidents/INC-1042/investigations", payload: body,
    headers: code ? { "x-access-code": code } : {},
  });

describe("live mode access", () => {
  it("advertises live mode and defaults to recorded", async () => {
    const { app } = gatedApp();
    const cfg = (await app.inject("/api/config")).json();
    expect(cfg).toMatchObject({ llm_mode: "recorded", live_available: true, live_daily_limit: 10, live_runs_today: 0 });
    const inv = await runInvestigation(app, "INC-1042");
    expect(inv.llm_mode).toBe("recorded");
  });

  it("rejects live without the right code and runs live with it", async () => {
    const { app, live } = gatedApp();
    expect((await start(app, { mode: "live" })).statusCode).toBe(403);
    expect((await start(app, { mode: "live" }, "wrong")).statusCode).toBe(403);
    expect(live.packets).toHaveLength(0);

    const ok = await start(app, { mode: "live" }, CODE);
    expect(ok.statusCode).toBe(202);
    let inv;
    for (let i = 0; i < 200; i++) {
      inv = (await app.inject(`/api/investigations/${ok.json().investigation_id}`)).json();
      if (inv.status === "completed" || inv.status === "failed") break;
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(inv.status).toBe("completed");
    expect(inv.llm_mode).toBe("live");
    expect(inv.summary).toBe("scripted live run");
    expect(live.packets).toHaveLength(1);

    // The RCA follows the investigation's mode, so it needs the code too.
    const rcaNoCode = await app.inject({ method: "POST", url: "/api/incidents/INC-1042/rca-drafts", payload: { investigation_id: inv.id } });
    expect(rcaNoCode.statusCode).toBe(403);
    const rca = await app.inject({
      method: "POST", url: "/api/incidents/INC-1042/rca-drafts", payload: { investigation_id: inv.id }, headers: { "x-access-code": CODE },
    });
    expect(rca.statusCode).toBe(201);
    expect(rca.json().rca.llm_mode).toBe("live");
  });

  it("enforces the daily live limit", async () => {
    const { app } = gatedApp(1);
    expect((await start(app, { mode: "live" }, CODE)).statusCode).toBe(202);
    await new Promise((r) => setTimeout(r, 50));
    const again = await app.inject({
      method: "POST", url: "/api/incidents/INC-1043/investigations", payload: { mode: "live" }, headers: { "x-access-code": CODE },
    });
    expect(again.statusCode).toBe(429);
    expect((await app.inject("/api/config")).json().live_runs_today).toBe(1);
    // Recorded runs are never limited.
    expect((await runInvestigation(app, "INC-1043")).status).toBe("completed");
  });

  it("says live is unavailable when no key or code is configured", async () => {
    const { app } = makeApp();
    expect((await app.inject("/api/config")).json().live_available).toBe(false);
    expect((await start(app, { mode: "live" }, CODE)).statusCode).toBe(400);
  });

  it("allows demo reset from a non-local IP only with the access code", async () => {
    const { app } = gatedApp();
    const reset = (headers: Record<string, string>) =>
      app.inject({ method: "POST", url: "/api/demo/reset", remoteAddress: "172.17.0.1", headers });
    expect((await reset({})).statusCode).toBe(403);
    expect((await reset({ "x-access-code": CODE })).statusCode).toBe(200);
  });
});

describe("numeric claims", () => {
  it("flags numbers that are not in the evidence and ignores versions, dates and small counts", () => {
    const known = numbersIn("5xx rate 28% p95 2400ms pool.max=20 at 2026-10-27T10:04:00Z, 1,250 requests");
    expect(unverifiedNumbers("Errors hit 28% and p95 reached 2400ms with 20 connections; 1,250 requests failed.", known)).toEqual([]);
    expect(unverifiedNumbers("Error rate reached 35% after v2.8.1 shipped on 2026-10-27 at 10:04; 3 retries.", known)).toEqual(["35%"]);
    expect(unverifiedNumbers("Latency was 900ms and 450 requests timed out.", known)).toEqual(["900ms", "450"]);
  });

  it("records an invented metric as a validation issue without removing the hypothesis", async () => {
    const { app } = makeApp(new ScriptedProvider((p) => output({
      hypotheses: [{
        title: "Pool exhausted", explanation: "Error rate climbed to 35% once the pool saturated.", confidence: "high",
        evidence_ids: [p.items[0].id], counter_evidence: [], unknowns: [], recommended_checks: [],
      }],
    })));
    const inv = await runInvestigation(app, "INC-1042");
    expect(inv.hypotheses).toHaveLength(1);
    expect(inv.validation_issues.some((i: string) => i.includes('Unverified number "35%"'))).toBe(true);
    const validate = inv.trace.find((t: { stage: string }) => t.stage === "Validate output");
    expect(validate.details.unverified_numbers).toBe(1);
  });
});

describe("trace, review queue and run history", () => {
  it("persists a stage trace for each investigation", async () => {
    const { app } = makeApp();
    const inv = await runInvestigation(app, "INC-1042");
    expect(inv.trace.map((t: { stage: string }) => t.stage)).toEqual([
      "Gather evidence", "Search incident history", "Build evidence packet", "Analyse (recorded)", "Validate output",
    ]);
    const packet = inv.trace.find((t: { stage: string }) => t.stage === "Build evidence packet");
    expect(packet.details.redactions).toBeGreaterThan(0);
    expect(inv.trace.every((t: { duration_ms: number }) => t.duration_ms >= 0)).toBe(true);
  });

  it("moves an incident from none → pending → verified as a human confirms the work", async () => {
    const { app } = makeApp();
    const state = async () => (await app.inject("/api/incidents?q=INC-1042")).json().items[0].review_state;
    expect(await state()).toBe("none");

    const inv = await runInvestigation(app, "INC-1042");
    expect(await state()).toBe("pending");
    const pending = (await app.inject("/api/incidents?review=pending")).json();
    expect(pending.items.map((i: { key: string }) => i.key)).toEqual(["INC-1042"]);

    await app.inject({ method: "POST", url: `/api/investigations/${inv.id}/feedback`, payload: { verified_root_cause: "pool.max lowered to 20" } });
    expect(await state()).toBe("pending"); // the RCA still needs review
    const rca = (await app.inject({ method: "POST", url: "/api/incidents/INC-1042/rca-drafts", payload: { investigation_id: inv.id } })).json().rca;
    await app.inject({ method: "PATCH", url: `/api/rca-drafts/${rca.id}`, payload: { status: "reviewed" } });
    expect(await state()).toBe("verified");
    expect((await app.inject("/api/incidents?review=pending")).json().total).toBe(0);
  });

  it("keeps earlier runs and lists them newest first", async () => {
    const { app } = makeApp();
    const first = await runInvestigation(app, "INC-1042");
    const second = await runInvestigation(app, "INC-1042");
    const detail = (await app.inject("/api/incidents/INC-1042")).json();
    expect(detail.investigations.map((r: { id: string }) => r.id)).toEqual([second.id, first.id]);
    expect(detail.investigations[0]).toMatchObject({ status: "completed", llm_mode: "recorded" });
    expect(detail.investigations[0].top_hypothesis).toMatch(/pool/i);
  });
});
