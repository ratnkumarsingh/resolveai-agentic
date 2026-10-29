import type { ReactNode } from "react";

export const cx = (...xs: (string | false | null | undefined)[]) => xs.filter(Boolean).join(" ");

export function formatTime(iso: string | null | undefined, withDate = false) {
  if (!iso) return "—";
  const d = new Date(iso);
  const time = d.toISOString().slice(11, 19);
  return withDate ? `${d.toISOString().slice(0, 10)} ${time} UTC` : `${time} UTC`;
}

export function age(iso: string) {
  const mins = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60_000));
  if (mins < 60) return `${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

const SEVERITY: Record<string, string> = {
  "SEV-1": "bg-red-600 text-white",
  "SEV-2": "bg-orange-500 text-white",
  "SEV-3": "bg-amber-200 text-amber-900",
  "SEV-4": "bg-slate-200 text-slate-700",
};

export function SeverityChip({ severity }: { severity: string }) {
  return <span className={cx("rounded px-1.5 py-0.5 text-xs font-semibold", SEVERITY[severity] ?? SEVERITY["SEV-4"])}>{severity}</span>;
}

const STATUS: Record<string, string> = {
  open: "bg-red-50 text-red-700 ring-red-200",
  investigating: "bg-amber-50 text-amber-800 ring-amber-200",
  mitigated: "bg-sky-50 text-sky-700 ring-sky-200",
  resolved: "bg-emerald-50 text-emerald-700 ring-emerald-200",
};

export function StatusChip({ status }: { status: string }) {
  return <span className={cx("rounded-full px-2 py-0.5 text-xs font-medium capitalize ring-1", STATUS[status])}>{status}</span>;
}

const CONFIDENCE: Record<string, string> = {
  high: "bg-indigo-600 text-white",
  medium: "bg-indigo-100 text-indigo-800",
  low: "bg-slate-100 text-slate-600",
};

export function ConfidenceChip({ confidence }: { confidence: string }) {
  return (
    <span className={cx("rounded px-1.5 py-0.5 text-xs font-medium", CONFIDENCE[confidence])} title="Qualitative model assessment, not a probability">
      {confidence} confidence
    </span>
  );
}

export function AiBadge({ children = "AI-generated — review required" }: { children?: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1 rounded bg-violet-100 px-1.5 py-0.5 text-xs font-medium text-violet-800">
      <svg viewBox="0 0 16 16" className="h-3 w-3" fill="currentColor" aria-hidden><path d="M8 0l1.8 5.2L15 7l-5.2 1.8L8 14l-1.8-5.2L1 7l5.2-1.8z" /></svg>
      {children}
    </span>
  );
}

export function Spinner({ className = "h-4 w-4" }: { className?: string }) {
  return <span className={cx("inline-block animate-spin rounded-full border-2 border-current border-r-transparent", className)} aria-label="Loading" />;
}

export function ErrorBox({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const message = error instanceof Error ? error.message : String(error);
  return (
    <div role="alert" className="flex items-start justify-between gap-4 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800">
      <span>{message}</span>
      {onRetry && (
        <button onClick={onRetry} className="shrink-0 font-medium underline">
          Try again
        </button>
      )}
    </div>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-slate-300 bg-white p-8 text-center">
      <p className="font-medium text-slate-700">{title}</p>
      {children && <div className="mt-1 text-sm text-slate-500">{children}</div>}
    </div>
  );
}

export function Card({ title, actions, children, className }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cx("rounded-lg border border-slate-200 bg-white", className)}>
      {(title || actions) && (
        <header className="flex items-center justify-between gap-2 border-b border-slate-100 px-4 py-2.5">
          <h3 className="text-sm font-semibold text-slate-700">{title}</h3>
          {actions}
        </header>
      )}
      <div className="p-4">{children}</div>
    </section>
  );
}

export function Button({
  variant = "secondary", className, ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" | "ghost" }) {
  return (
    <button
      {...props}
      className={cx(
        "inline-flex items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-50",
        variant === "primary" && "bg-indigo-600 text-white hover:bg-indigo-700",
        variant === "secondary" && "border border-slate-300 bg-white text-slate-700 hover:bg-slate-50",
        variant === "ghost" && "text-slate-600 hover:bg-slate-100",
        className,
      )}
    />
  );
}
