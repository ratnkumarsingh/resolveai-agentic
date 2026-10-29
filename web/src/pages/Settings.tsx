import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { accessCode, api } from "../api";
import { Button, Card, ErrorBox, Spinner } from "../components/ui";

export default function Settings() {
  const qc = useQueryClient();
  const config = useQuery({ queryKey: ["config"], queryFn: api.config });
  const [confirming, setConfirming] = useState(false);
  const [code, setCode] = useState(accessCode.get);
  const [savedCode, setSavedCode] = useState(accessCode.get);
  const reset = useMutation({
    mutationFn: api.resetDemo,
    onSuccess: () => {
      setConfirming(false);
      qc.invalidateQueries();
    },
  });

  return (
    <div className="max-w-2xl space-y-4">
      <h1 className="text-xl font-semibold">Settings &amp; demo data</h1>

      <Card title="Data source">
        <dl className="grid grid-cols-[10rem_1fr] gap-y-2 text-sm">
          <dt className="text-slate-500">Mode</dt>
          <dd className="font-medium">Demo dataset</dd>
          <dt className="text-slate-500">Integrations</dt>
          <dd>None connected. Incidents, logs, deployments and metrics are synthetic seed data, not live telemetry.</dd>
          <dt className="text-slate-500">LLM mode</dt>
          <dd>
            {config.data ? (
              config.data.llm_mode === "live"
                ? <>Live — investigations call Claude (<span className="font-mono">{config.data.model}</span>) from the server.</>
                : <>Recorded by default — investigations replay a recorded analysis (INC-1042) or deterministic rules. No model is called.</>
            ) : "…"}
          </dd>
          <dt className="text-slate-500">Live Claude</dt>
          <dd>
            {config.data ? (
              config.data.live_available
                ? <>Available on request (<span className="font-mono">{config.data.live_model}</span>) · {config.data.live_runs_today} of {config.data.live_daily_limit} model calls used today (UTC).</>
                : "Not available on this server (needs ANTHROPIC_API_KEY and LIVE_ACCESS_CODE)."
            ) : "…"}
          </dd>
        </dl>
      </Card>

      <Card title="Access code">
        <p className="text-sm text-slate-600">
          Live Claude runs cost money, so they need the access code set on the server (<span className="font-mono">LIVE_ACCESS_CODE</span>).
          It also allows demo reset from outside localhost. The code is kept only in this browser.
        </p>
        <form
          className="mt-3 flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            accessCode.set(code.trim());
            setSavedCode(code.trim());
          }}
        >
          <input
            type="password"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="Access code"
            aria-label="Access code"
            autoComplete="off"
            className="w-64 rounded-md border border-slate-300 px-3 py-1.5 text-sm"
          />
          <Button type="submit" disabled={code.trim() === savedCode}>Save</Button>
          {savedCode && (
            <Button type="button" variant="ghost" onClick={() => { accessCode.set(""); setCode(""); setSavedCode(""); }}>Forget</Button>
          )}
          <span className="text-xs text-slate-500">{savedCode ? "Saved in this browser." : "No code saved."}</span>
        </form>
      </Card>

      <Card title="Reset demo data">
        <p className="text-sm text-slate-600">
          Deletes all investigations, feedback and RCA drafts and restores the seeded incidents, so the demo can be run again from a known state.
        </p>
        <div className="mt-3 flex items-center gap-2">
          {!confirming ? (
            <Button onClick={() => setConfirming(true)} disabled={!config.data?.demo_mode}>Reset demo data…</Button>
          ) : (
            <>
              <Button variant="primary" className="bg-red-600 hover:bg-red-700" onClick={() => reset.mutate()} disabled={reset.isPending}>
                {reset.isPending && <Spinner className="h-3.5 w-3.5" />} Yes, reset everything
              </Button>
              <Button variant="ghost" onClick={() => setConfirming(false)}>Cancel</Button>
            </>
          )}
          {reset.isSuccess && !confirming && <span className="text-sm text-emerald-700">Demo data restored.</span>}
        </div>
        {config.data && !config.data.demo_mode && <p className="mt-2 text-xs text-slate-500">Disabled: the server is not running with DEMO_MODE=true.</p>}
        {reset.isError && <div className="mt-3"><ErrorBox error={reset.error} /></div>}
      </Card>
    </div>
  );
}
