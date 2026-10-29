import type {
  AppConfig,
  FeedbackBody,
  Incident,
  IncidentEvidence,
  Investigation,
  PatchRcaBody,
  RcaDraft,
} from "@resolveai/shared";

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    try {
      message = (await res.json()).error ?? message;
    } catch {
      // Non-JSON error body; keep the generic message.
    }
    throw new Error(message);
  }
  return res.json() as Promise<T>;
}

export interface IncidentList {
  items: Incident[];
  total: number;
  page: number;
  page_size: number;
  services: string[];
}

export interface IncidentDetail {
  incident: Incident;
  latest_investigation_id: string | null;
  rca_drafts: RcaDraft[];
}

export type InvestigationDto = Investigation & { stage: string | null };

export interface KnowledgeDoc {
  id: string;
  title: string;
  doc_type: string;
  service_name: string | null;
  body: string;
}

export const api = {
  config: () => request<AppConfig>("GET", "/api/config"),
  incidents: (params: Record<string, string>) =>
    request<IncidentList>("GET", `/api/incidents?${new URLSearchParams(Object.entries(params).filter(([, v]) => v))}`),
  incident: (id: string) => request<IncidentDetail>("GET", `/api/incidents/${encodeURIComponent(id)}`),
  evidence: (id: string) => request<IncidentEvidence>("GET", `/api/incidents/${encodeURIComponent(id)}/evidence`),
  startInvestigation: (id: string, question?: string) =>
    request<{ investigation_id: string; status: string }>("POST", `/api/incidents/${encodeURIComponent(id)}/investigations`, { question }),
  investigation: (id: string) => request<InvestigationDto>("GET", `/api/investigations/${id}`),
  feedback: (id: string, body: FeedbackBody) => request<{ id: string }>("POST", `/api/investigations/${id}/feedback`, body),
  createRca: (incidentId: string, investigationId: string) =>
    request<{ rca_draft_id: string; rca: RcaDraft }>("POST", `/api/incidents/${encodeURIComponent(incidentId)}/rca-drafts`, { investigation_id: investigationId }),
  patchRca: (id: string, body: PatchRcaBody) => request<RcaDraft>("PATCH", `/api/rca-drafts/${id}`, body),
  rcaMarkdown: async (id: string) => {
    const res = await fetch(`/api/rca-drafts/${id}/export.md`);
    if (!res.ok) throw new Error(`Export failed (${res.status})`);
    return res.text();
  },
  knowledge: (id: string) => request<KnowledgeDoc>("GET", `/api/knowledge/${id}`),
  resetDemo: () => request<{ ok: true }>("POST", "/api/demo/reset"),
};
