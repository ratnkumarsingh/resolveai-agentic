import { useQuery } from "@tanstack/react-query";
import type { SimilarIncidentResult } from "@resolveai/shared";
import { useState } from "react";
import { api, type InvestigationDto } from "../api";
import { rowId } from "./EvidenceTabs";
import { Button, cx, Empty, ErrorBox, formatTime, Spinner } from "./ui";

function HistoricalRca({ docId }: { docId: string }) {
  const doc = useQuery({ queryKey: ["knowledge", docId], queryFn: () => api.knowledge(docId) });
  if (doc.isPending) return <div className="flex items-center gap-2 text-sm text-slate-500"><Spinner /> Loading RCA…</div>;
  if (doc.isError) return <ErrorBox error={doc.error} />;
  return (
    <div className="rounded-md border border-slate-200 bg-slate-50 p-3">
      <div className="text-sm font-medium">{doc.data.title}</div>
      <p className="mt-1 whitespace-pre-line text-sm text-slate-700">{doc.data.body}</p>
    </div>
  );
}

function SimilarCard({ s, focus }: { s: SimilarIncidentResult; focus: string | null }) {
  const [open, setOpen] = useState(false);
  const h = s.historical;
  return (
    <article id={rowId(h.ref)} className={cx("rounded-lg border border-slate-200 bg-white p-4", focus === h.ref && "flash")} data-testid="similar-incident">
      <header className="flex flex-wrap items-baseline gap-2">
        <span className="font-mono text-xs text-slate-500">{h.key}</span>
        <h4 className="font-semibold">{h.title}</h4>
        <span className="font-mono text-xs text-slate-500">{h.service_name}</span>
        <span className="ml-auto text-xs text-slate-500">resolved {formatTime(h.resolved_at, true).slice(0, 10)}</span>
      </header>
      <p className="mt-2 text-sm"><span className="font-medium text-violet-800">Why it matches: </span>{s.similarity_reason}</p>
      <dl className="mt-3 grid gap-2 text-sm sm:grid-cols-2">
        <div><dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">Prior root cause</dt><dd>{h.root_cause}</dd></div>
        <div><dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">Resolution</dt><dd>{h.resolution}</dd></div>
      </dl>
      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        {s.matched_terms.slice(0, 8).map((t) => <span key={t} className="rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-600">{t}</span>)}
        {h.rca_document_id && (
          <Button variant="ghost" className="ml-auto" onClick={() => setOpen(!open)}>{open ? "Hide historical RCA" : "View historical RCA"}</Button>
        )}
      </div>
      {open && h.rca_document_id && <div className="mt-3"><HistoricalRca docId={h.rca_document_id} /></div>}
    </article>
  );
}

export function SimilarIncidents({ inv, focus }: { inv: InvestigationDto | undefined; focus: string | null }) {
  if (!inv || inv.status !== "completed") {
    return <Empty title="Similar incidents appear after an investigation">The search runs over past incidents and RCA notes as part of “Run investigation”.</Empty>;
  }
  if (inv.similar_incidents.length === 0) {
    return <Empty title="No similar past incidents found">No historical incident shared enough symptoms, signatures or service context.</Empty>;
  }
  return (
    <div className="space-y-3">
      <p className="text-xs text-slate-500">Retrieved by full-text search over past incidents, ranked by matching terms and service. The explanation of each match is model-written.</p>
      {inv.similar_incidents.map((s) => <SimilarCard key={s.historical.id} s={s} focus={focus} />)}
    </div>
  );
}
