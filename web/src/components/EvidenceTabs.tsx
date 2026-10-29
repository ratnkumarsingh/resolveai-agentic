import type { IncidentEvidence } from "@resolveai/shared";
import { Card, cx, Empty, formatTime } from "./ui";

export const rowId = (ref: string) => `ev-${ref}`;

const LEVEL: Record<string, string> = {
  ERROR: "text-red-700 bg-red-50",
  FATAL: "text-red-800 bg-red-100",
  WARN: "text-amber-800 bg-amber-50",
  INFO: "text-slate-600 bg-slate-100",
};

function ratio(baseline: number, peak: number) {
  if (baseline === 0) return peak > 0 ? "new" : "flat";
  const r = peak / baseline;
  return r >= 1.5 ? `×${r >= 10 ? Math.round(r) : r.toFixed(1)}` : r <= 0.67 ? `×${r.toFixed(2)}` : "≈ flat";
}

export function OverviewTab({ evidence, focus }: { evidence: IncidentEvidence; focus: string | null }) {
  const start = Date.parse(evidence.incident.started_at);
  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <div className="space-y-4 lg:col-span-2">
        <Card title="Metrics (baseline → peak)">
          {evidence.metrics.length === 0 ? (
            <p className="text-sm text-slate-500">No metric snapshots recorded for this incident.</p>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2">
              {evidence.metrics.map((m) => {
                const big = m.peak >= Math.max(3 * m.baseline, m.baseline + 1);
                return (
                  <div key={m.id} id={rowId(m.ref)} className={cx("rounded-md border border-slate-200 p-3", focus === m.ref && "flash")}>
                    <div className="text-xs text-slate-500">{m.name}</div>
                    <div className="mt-1 flex items-baseline gap-2">
                      <span className="text-sm text-slate-500">{m.baseline.toLocaleString()} →</span>
                      <span className={cx("text-xl font-semibold", big ? "text-red-700" : "text-slate-800")}>{m.peak.toLocaleString()}</span>
                      <span className="text-xs text-slate-500">{m.unit}</span>
                      <span className={cx("ml-auto rounded px-1.5 text-xs font-medium", big ? "bg-red-50 text-red-700" : "bg-slate-100 text-slate-600")}>{ratio(m.baseline, m.peak)}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </Card>

        <Card title="Error signals">
          {evidence.error_signals.length === 0 ? (
            <p className="text-sm text-slate-500">No error signatures found in the incident window.</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-slate-500">
                <tr><th className="pb-2">Signature</th><th className="pb-2">Count</th><th className="pb-2">First seen</th><th className="pb-2">Last seen</th></tr>
              </thead>
              <tbody>
                {evidence.error_signals.map((s) => (
                  <tr key={s.signature} className="border-t border-slate-100">
                    <td className="py-1.5 font-mono text-xs">{s.signature}</td>
                    <td className="py-1.5 font-semibold">{s.count}</td>
                    <td className="py-1.5 text-xs text-slate-600">{formatTime(s.first_seen)}</td>
                    <td className="py-1.5 text-xs text-slate-600">{formatTime(s.last_seen)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>

        <Card title="Runbooks & guides">
          {evidence.runbooks.length === 0 ? (
            <p className="text-sm text-slate-500">No runbooks for this service.</p>
          ) : (
            <ul className="space-y-3">
              {evidence.runbooks.map((r) => (
                <li key={r.id} id={rowId(r.ref)} className={cx("rounded-md", focus === r.ref && "flash")}>
                  <div className="text-sm font-medium">{r.title}</div>
                  <p className="mt-0.5 text-sm text-slate-600">{r.body}</p>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <Card title="Timeline">
        {evidence.timeline.length === 0 ? (
          <p className="text-sm text-slate-500">No timeline events.</p>
        ) : (
          <ol className="relative space-y-4 border-l border-slate-200 pl-4">
            {evidence.timeline.map((e) => (
              <li key={e.id} id={rowId(e.ref)} className={cx("relative rounded", focus === e.ref && "flash")}>
                <span className={cx("absolute -left-[21px] top-1.5 h-2.5 w-2.5 rounded-full ring-2 ring-white",
                  e.kind === "deployment" ? "bg-indigo-500" : e.kind === "alert" ? "bg-red-500" : Date.parse(e.timestamp) >= start ? "bg-amber-500" : "bg-slate-400")} />
                <div className="text-xs text-slate-500">{formatTime(e.timestamp)} · {e.kind}</div>
                <div className="text-sm">{e.description}</div>
              </li>
            ))}
          </ol>
        )}
      </Card>
    </div>
  );
}

export function LogsTab({ evidence, focus }: { evidence: IncidentEvidence; focus: string | null }) {
  if (evidence.logs.length === 0) return <Empty title="No logs in the incident window" />;
  return (
    <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
      <p className="border-b border-slate-100 px-4 py-2 text-xs text-slate-500">
        Raw sample logs from the demo dataset for {evidence.incident.service_name} and linked services, 30 minutes before start to 1 hour after detection. Secrets are redacted before anything is sent to the model; stored logs are never modified.
      </p>
      <table className="w-full text-left text-sm">
        <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
          <tr><th className="px-3 py-2">Time</th><th className="px-3 py-2">Level</th><th className="px-3 py-2">Service</th><th className="px-3 py-2">Message</th></tr>
        </thead>
        <tbody className="divide-y divide-slate-100 font-mono text-xs">
          {evidence.logs.map((l) => (
            <tr key={l.id} id={rowId(l.ref)} className={cx(focus === l.ref && "flash")}>
              <td className="whitespace-nowrap px-3 py-1.5 text-slate-500">{formatTime(l.timestamp)}</td>
              <td className="px-3 py-1.5"><span className={cx("rounded px-1", LEVEL[l.level] ?? LEVEL.INFO)}>{l.level}</span></td>
              <td className="whitespace-nowrap px-3 py-1.5 text-slate-600">{l.service_name}</td>
              <td className="px-3 py-1.5 break-all">
                {l.message}
                {l.error_signature && <span className="ml-2 rounded bg-slate-100 px-1 text-slate-500">{l.error_signature}</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function DeploymentsTab({ evidence, focus }: { evidence: IncidentEvidence; focus: string | null }) {
  if (evidence.deployments.length === 0) return <Empty title="No deployments near this incident" />;
  const start = Date.parse(evidence.incident.started_at);
  return (
    <div className="space-y-2">
      {evidence.deployments.map((d) => {
        const minutes = Math.round((start - Date.parse(d.deployed_at)) / 60_000);
        const sameService = d.service_name === evidence.incident.service_name;
        return (
          <div key={d.id} id={rowId(d.ref)} className={cx("flex flex-wrap items-start gap-3 rounded-lg border border-slate-200 bg-white p-3", focus === d.ref && "flash")}>
            <span className={cx("rounded px-1.5 py-0.5 font-mono text-xs", sameService ? "bg-indigo-100 text-indigo-800" : "bg-slate-100 text-slate-600")}>
              {d.service_name} {d.version}
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-sm">{d.change_summary}</div>
              <div className="text-xs text-slate-500">
                {formatTime(d.deployed_at, true)} · {d.environment}{d.commit_ref && <> · commit <span className="font-mono">{d.commit_ref}</span></>}
              </div>
            </div>
            <span className={cx("text-xs font-medium", minutes >= 0 && minutes <= 60 && sameService ? "text-red-700" : "text-slate-500")}>
              {minutes >= 0 ? `${minutes >= 120 ? `${Math.round(minutes / 60)}h` : `${minutes} min`} before start` : `${-minutes} min after start`}
            </span>
          </div>
        );
      })}
    </div>
  );
}
