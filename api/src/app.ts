import { randomUUID } from "node:crypto";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { CreateRcaBody, FeedbackBody, PatchRcaBody, StartInvestigationBody, type AppConfig } from "@resolveai/shared";
import type { z } from "zod";
import type { Config } from "./config.js";
import { type Db, get, run } from "./db/index.js";
import { seedDemoData } from "./db/seed.js";
import { LlmError, type LlmProvider } from "./llm/provider.js";
import { loadEvidence } from "./pipeline/evidence.js";
import { findIncident, listIncidents, listServices } from "./services/incidents.js";
import { getInvestigation, getInvestigationRow, latestInvestigationId, startInvestigation } from "./services/investigations.js";
import { createRca, getRca, listRcas, patchRca, rcaMarkdown } from "./services/rca.js";

export interface AppDeps {
  db: Db;
  llm: LlmProvider;
  config: Pick<Config, "demoMode" | "model">;
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function parse<S extends z.ZodType>(schema: S, body: unknown): z.infer<S> {
  const r = schema.safeParse(body ?? {});
  if (!r.success) throw new HttpError(400, `Invalid request: ${r.error.issues.map((i) => `${i.path.join(".") || "body"} ${i.message}`).join("; ")}`);
  return r.data;
}

const LOCAL = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

export function buildApp(deps: AppDeps) {
  const { db, llm, config } = deps;
  const app = Fastify({ logger: false });

  app.setErrorHandler((err: unknown, _req, reply) => {
    if (err instanceof HttpError) return reply.status(err.status).send({ error: err.message });
    if (err instanceof LlmError) return reply.status(502).send({ error: err.message });
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status < 500) return reply.status(status).send({ error: (err as Error).message });
    console.error(err);
    return reply.status(500).send({ error: "Internal server error" });
  });

  const incidentOr404 = (idOrKey: string) => {
    const incident = findIncident(db, idOrKey);
    if (!incident) throw new HttpError(404, "Incident not found");
    return incident;
  };

  app.get("/api/config", async (): Promise<AppConfig> => ({
    llm_mode: llm.mode,
    model: llm.mode === "live" ? config.model : "recorded fixtures",
    demo_mode: config.demoMode,
    data_source: "Demo dataset",
  }));

  app.get("/api/incidents", async (req: FastifyRequest<{ Querystring: Record<string, string | undefined> }>) => {
    const q = req.query;
    return {
      ...listIncidents(db, {
        status: q.status || undefined,
        severity: q.severity || undefined,
        service: q.service || undefined,
        q: q.q?.trim() || undefined,
        page: Math.max(1, Number(q.page) || 1),
        pageSize: Math.min(100, Math.max(1, Number(q.page_size) || 25)),
      }),
      services: listServices(db),
    };
  });

  app.get("/api/incidents/:id", async (req: FastifyRequest<{ Params: { id: string } }>) => {
    const incident = incidentOr404(req.params.id);
    return { incident, latest_investigation_id: latestInvestigationId(db, incident.id) ?? null, rca_drafts: listRcas(db, incident.id) };
  });

  app.get("/api/incidents/:id/evidence", async (req: FastifyRequest<{ Params: { id: string } }>) => {
    return loadEvidence(db, incidentOr404(req.params.id));
  });

  app.post("/api/incidents/:id/investigations", async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    const incident = incidentOr404(req.params.id);
    const body = parse(StartInvestigationBody, req.body);
    const running = get<{ id: string }>(db,
      "SELECT id FROM investigations WHERE incident_id = ? AND status IN ('queued', 'running') LIMIT 1", incident.id);
    if (running) return reply.status(202).send({ investigation_id: running.id, status: "running" });
    const id = startInvestigation({ db, llm }, incident, body.question?.trim() || null);
    return reply.status(202).send({ investigation_id: id, status: "queued" });
  });

  app.get("/api/investigations/:id", async (req: FastifyRequest<{ Params: { id: string } }>) => {
    const inv = getInvestigation(db, req.params.id);
    if (!inv) throw new HttpError(404, "Investigation not found");
    return inv;
  });

  app.post("/api/investigations/:id/feedback", async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    const row = getInvestigationRow(db, req.params.id);
    if (!row) throw new HttpError(404, "Investigation not found");
    const body = parse(FeedbackBody, req.body);
    if (body.hypothesis_id) {
      const owned = get(db, "SELECT 1 FROM hypotheses WHERE id = ? AND investigation_id = ?", body.hypothesis_id, row.id);
      if (!owned) throw new HttpError(400, "Hypothesis does not belong to this investigation");
    }
    if (body.helpful === undefined && !body.comment?.trim() && !body.verified_root_cause?.trim()) {
      throw new HttpError(400, "Feedback needs a helpful flag, a comment or a verified root cause");
    }
    const id = randomUUID();
    run(db,
      `INSERT INTO feedback (id, investigation_id, hypothesis_id, helpful, comment, verified_root_cause, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      id, row.id, body.hypothesis_id ?? null, body.helpful === undefined ? null : body.helpful ? 1 : 0,
      body.comment?.trim() || null, body.verified_root_cause?.trim() || null, new Date().toISOString());
    return reply.status(201).send({ id });
  });

  app.post("/api/incidents/:id/rca-drafts", async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    const incident = incidentOr404(req.params.id);
    const body = parse(CreateRcaBody, req.body);
    const inv = getInvestigationRow(db, body.investigation_id);
    if (!inv || inv.incident_id !== incident.id) throw new HttpError(400, "That investigation does not belong to this incident");
    if (inv.status !== "completed") throw new HttpError(409, "Run an investigation to completion before drafting an RCA");
    const rca = await createRca({ db, llm }, incident, body.investigation_id);
    return reply.status(201).send({ rca_draft_id: rca.id, rca });
  });

  app.get("/api/rca-drafts/:id", async (req: FastifyRequest<{ Params: { id: string } }>) => {
    const rca = getRca(db, req.params.id);
    if (!rca) throw new HttpError(404, "RCA draft not found");
    return rca;
  });

  app.patch("/api/rca-drafts/:id", async (req: FastifyRequest<{ Params: { id: string } }>) => {
    const rca = patchRca(db, req.params.id, parse(PatchRcaBody, req.body));
    if (!rca) throw new HttpError(404, "RCA draft not found");
    return rca;
  });

  app.get("/api/rca-drafts/:id/export.md", async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    const rca = getRca(db, req.params.id);
    if (!rca) throw new HttpError(404, "RCA draft not found");
    const incident = incidentOr404(rca.incident_id);
    return reply
      .header("content-type", "text/markdown; charset=utf-8")
      .header("content-disposition", `attachment; filename="${incident.key}-rca-v${rca.version}.md"`)
      .send(rcaMarkdown(rca, incident));
  });

  app.get("/api/knowledge/:id", async (req: FastifyRequest<{ Params: { id: string } }>) => {
    const doc = get(db, "SELECT id, title, doc_type, service_name, body FROM knowledge_documents WHERE id = ?", req.params.id);
    if (!doc) throw new HttpError(404, "Document not found");
    return doc;
  });

  app.post("/api/demo/reset", async (req: FastifyRequest) => {
    if (!config.demoMode) throw new HttpError(404, "Not found");
    if (!LOCAL.has(req.ip)) throw new HttpError(403, "Demo reset is only available from localhost");
    const running = get(db, "SELECT 1 FROM investigations WHERE status IN ('queued', 'running') LIMIT 1");
    if (running) throw new HttpError(409, "An investigation is still running; wait for it to finish before resetting");
    seedDemoData(db);
    return { ok: true };
  });

  return app;
}
