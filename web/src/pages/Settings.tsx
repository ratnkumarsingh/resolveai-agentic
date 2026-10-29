import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../api";
import { Button, Card, ErrorBox, Spinner } from "../components/ui";

export default function Settings() {
  const qc = useQueryClient();
  const config = useQuery({ queryKey: ["config"], queryFn: api.config });
  const [confirming, setConfirming] = useState(false);
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
                : <>Recorded — investigations replay a recorded analysis (INC-1042) or deterministic rules. No model is called.</>
            ) : "…"}
          </dd>
        </dl>
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
