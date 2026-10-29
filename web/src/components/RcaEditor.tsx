import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { RcaDraft } from "@resolveai/shared";
import { useState } from "react";
import { api, type InvestigationDto } from "../api";
import { AiBadge, Button, cx, Empty, ErrorBox, formatTime, Spinner } from "./ui";

const lines = (s: string) => s.split("\n").map((l) => l.trim()).filter(Boolean);
const field = "mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm";

function Editor({ rca, incidentKey, onEvidence }: { rca: RcaDraft; incidentKey: string; onEvidence: (ref: string) => void }) {
  const qc = useQueryClient();
  const [impact, setImpact] = useState(rca.impact);
  const [rootCause, setRootCause] = useState(rca.root_cause);
  const [factors, setFactors] = useState(rca.contributing_factors.join("\n"));
  const [resolution, setResolution] = useState(rca.resolution_steps.join("\n"));
  const [prevention, setPrevention] = useState(rca.prevention_actions.join("\n"));
  const [copied, setCopied] = useState(false);

  const dirty =
    impact !== rca.impact || rootCause !== rca.root_cause || factors !== rca.contributing_factors.join("\n") ||
    resolution !== rca.resolution_steps.join("\n") || prevention !== rca.prevention_actions.join("\n");

  const save = useMutation({
    mutationFn: (status?: "draft" | "reviewed") => api.patchRca(rca.id, {
      impact, root_cause: rootCause,
      contributing_factors: lines(factors), resolution_steps: lines(resolution), prevention_actions: lines(prevention),
      status,
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["incident", incidentKey] });
      qc.invalidateQueries({ queryKey: ["incidents"] });
    },
  });

  const copy = useMutation({
    mutationFn: async () => {
      await navigator.clipboard.writeText(await api.rcaMarkdown(rca.id));
    },
    onSuccess: () => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    },
  });

  return (
    <div className="space-y-4 rounded-lg border border-slate-200 bg-white p-4" data-testid="rca-editor">
      <div className="flex flex-wrap items-center gap-2">
        <AiBadge>{rca.llm_mode === "live" ? "AI-generated draft" : "Recorded draft"} — review required</AiBadge>
        <span className={cx("rounded px-1.5 py-0.5 text-xs font-medium", rca.status === "reviewed" ? "bg-emerald-100 text-emerald-800" : "bg-slate-100 text-slate-700")}>
          {rca.status}
        </span>
        <span className="text-xs text-slate-500">
          v{rca.version} · generated {formatTime(rca.generated_at, true)} · edited {formatTime(rca.updated_at, true)}
        </span>
      </div>

      <label className="block text-sm font-medium text-slate-700">Impact
        <textarea value={impact} onChange={(e) => setImpact(e.target.value)} rows={3} className={field} />
      </label>

      <div>
        <div className="text-sm font-medium text-slate-700">Timeline (UTC)</div>
        <ol className="mt-1 space-y-1 rounded-md border border-slate-200 p-3 text-sm">
          {rca.timeline.length === 0 && <li className="text-slate-500">No timeline events.</li>}
          {rca.timeline.map((e, i) => (
            <li key={i} className="flex flex-wrap gap-2">
              <span className="font-mono text-xs leading-5 text-slate-500">{formatTime(e.timestamp)}</span>
              <span className="flex-1">{e.event}</span>
              {e.evidence_ids.map((ref) => (
                <button key={ref} onClick={() => onEvidence(ref)} className="rounded bg-slate-100 px-1.5 text-xs text-slate-600 hover:bg-indigo-100 hover:text-indigo-800" title={ref}>
                  source
                </button>
              ))}
            </li>
          ))}
        </ol>
      </div>

      <label className="block text-sm font-medium text-slate-700">Root cause
        <textarea value={rootCause} onChange={(e) => setRootCause(e.target.value)} rows={3} className={field} data-testid="rca-root-cause" />
      </label>
      <div className="grid gap-4 md:grid-cols-3">
        <label className="block text-sm font-medium text-slate-700">Contributing factors <span className="font-normal text-slate-500">(one per line)</span>
          <textarea value={factors} onChange={(e) => setFactors(e.target.value)} rows={5} className={field} />
        </label>
        <label className="block text-sm font-medium text-slate-700">Resolution <span className="font-normal text-slate-500">(one per line)</span>
          <textarea value={resolution} onChange={(e) => setResolution(e.target.value)} rows={5} className={field} />
        </label>
        <label className="block text-sm font-medium text-slate-700">Preventive actions <span className="font-normal text-slate-500">(one per line)</span>
          <textarea value={prevention} onChange={(e) => setPrevention(e.target.value)} rows={5} className={field} />
        </label>
      </div>

      <div className="flex flex-wrap items-center gap-2 border-t border-slate-100 pt-3">
        <Button variant="primary" onClick={() => save.mutate(undefined)} disabled={!dirty || save.isPending}>
          {save.isPending && <Spinner className="h-3.5 w-3.5" />} Save changes
        </Button>
        {rca.status !== "reviewed" && <Button onClick={() => save.mutate("reviewed")} disabled={save.isPending}>Save &amp; mark reviewed</Button>}
        <Button onClick={() => copy.mutate()} disabled={dirty}>{copied ? "Copied" : "Copy Markdown"}</Button>
        <a
          href={`/api/rca-drafts/${rca.id}/export.md`}
          className={cx("rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50", dirty && "pointer-events-none opacity-50")}
          download
        >
          Download .md
        </a>
        {dirty && <span className="text-xs text-amber-700">Unsaved changes — save before exporting.</span>}
        {save.isSuccess && !dirty && <span className="text-xs text-emerald-700">Saved.</span>}
      </div>
      {rca.validation_issues.length > 0 && (
        <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900" data-testid="rca-validation">
          <div className="font-medium">Check before publishing</div>
          <ul className="mt-1 list-disc space-y-0.5 pl-5">{rca.validation_issues.map((i) => <li key={i}>{i}</li>)}</ul>
        </div>
      )}
      {save.isError && <ErrorBox error={save.error} />}
      {copy.isError && <ErrorBox error={copy.error} />}
    </div>
  );
}

export function RcaPanel({
  incidentKey, drafts, inv, onEvidence,
}: { incidentKey: string; drafts: RcaDraft[]; inv: InvestigationDto | undefined; onEvidence: (ref: string) => void }) {
  const qc = useQueryClient();
  const [selected, setSelected] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: () => api.createRca(incidentKey, inv!.id),
    onSuccess: (res) => {
      setSelected(res.rca.id);
      qc.invalidateQueries({ queryKey: ["incident", incidentKey] });
    },
  });
  const canGenerate = inv?.status === "completed";
  const current = drafts.find((d) => d.id === selected) ?? drafts[0];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="primary" onClick={() => create.mutate()} disabled={!canGenerate || create.isPending} data-testid="generate-rca">
          {create.isPending && <Spinner className="h-3.5 w-3.5" />}
          {drafts.length ? "Generate new version" : "Generate RCA draft"}
        </Button>
        {!canGenerate && <span className="text-sm text-slate-500">Complete an investigation first; the draft is built from its evidence and your feedback.</span>}
        {drafts.length > 1 && (
          <select value={current?.id} onChange={(e) => setSelected(e.target.value)} className="ml-auto rounded-md border border-slate-300 px-2 py-1.5 text-sm" aria-label="RCA version">
            {drafts.map((d) => <option key={d.id} value={d.id}>Version {d.version} ({d.status})</option>)}
          </select>
        )}
      </div>
      {create.isPending && <p className="text-sm text-slate-500">Drafting the RCA from the investigation…</p>}
      {create.isError && <ErrorBox error={create.error} onRetry={() => create.mutate()} />}
      {current ? (
        <Editor key={current.id} rca={current} incidentKey={incidentKey} onEvidence={onEvidence} />
      ) : (
        !create.isPending && <Empty title="No RCA draft yet">Generate a draft, edit it, then copy or download it for the postmortem or ticket.</Empty>
      )}
    </div>
  );
}
