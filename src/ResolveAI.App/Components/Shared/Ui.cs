using System.Globalization;
using ResolveAI.App.Llm;
using ResolveAI.App.Services;
using ResolveAI.Contracts;

namespace ResolveAI.App.Components.Shared;

/// <summary>Formatting shared by the components.</summary>
public static class Ui
{
    public static string Cx(params string?[] classes) => string.Join(' ', classes.Where(c => !string.IsNullOrEmpty(c)));

    /// <summary>"true"/"false" for ARIA attributes, which Blazor would otherwise drop when the value is a false bool.</summary>
    public static string Aria(bool value) => value ? "true" : "false";

    public static string FormatTime(string? iso, bool withDate = false)
    {
        if (string.IsNullOrEmpty(iso) || !Js.TryParseDate(iso, out var d)) return "—";
        var s = Js.Iso(d);
        var time = s[11..19];
        return withDate ? $"{s[..10]} {time} UTC" : $"{time} UTC";
    }

    public static string Age(string iso)
    {
        var mins = Math.Max(0, Js.Round((DateTimeOffset.UtcNow - Js.ParseDate(iso)).TotalMinutes));
        if (mins < 60) return $"{Js.Num(mins)}m";
        var hours = Js.Round(mins / 60);
        if (hours < 48) return $"{Js.Num(hours)}h";
        return $"{Js.Num(Js.Round(hours / 24))}d";
    }

    /// <summary>A number as the browser's toLocaleString showed it: grouped, at most three decimals.</summary>
    public static string Number(double n) => n.ToString("#,##0.###", CultureInfo.InvariantCulture);

    public static string Fixed(double n, int decimals) => n.ToString($"F{decimals}", CultureInfo.InvariantCulture);

    public static string RowId(string reference) => $"ev-{reference}";

    /// <summary>The message a person should see for a failure. Anything unexpected stays generic, so internals aren't shown.</summary>
    public static string Message(Exception err) => err is AppError or LlmError ? err.Message : "Something went wrong. Try again.";

    public static string Severity(string severity) => severity switch
    {
        "SEV-1" => "bg-red-100 text-red-700 ring-1 ring-red-300",
        "SEV-2" => "bg-orange-100 text-orange-700",
        "SEV-3" => "bg-amber-100 text-amber-700",
        _ => "bg-slate-200 text-slate-700",
    };

    public static string SeverityGlow(string severity) => severity switch
    {
        "SEV-1" => "glow-red",
        "SEV-2" => "glow-orange",
        "SEV-3" => "glow-amber",
        _ => "",
    };

    /// <summary>A fixed colour per service name, so a service is easy to spot down the queue. The colour carries no status.</summary>
    public static string ServiceChip(string service)
    {
        string[] palette =
        [
            "bg-sky-100 text-sky-700", "bg-violet-100 text-violet-700", "bg-teal-100 text-teal-700",
            "bg-pink-100 text-pink-700", "bg-cyan-100 text-cyan-700",
        ];
        return palette[service.Sum(c => c) % palette.Length];
    }

    public static string SeverityTile(string severity) => severity switch
    {
        "SEV-1" => "tile-red",
        "SEV-2" => "tile-orange",
        "SEV-3" => "tile-amber",
        _ => "tile-blue",
    };

    public static string Status(string status) => status switch
    {
        "open" => "bg-red-100 text-red-700",
        "investigating" => "bg-amber-100 text-amber-700",
        "mitigated" => "bg-sky-100 text-sky-700",
        "resolved" => "bg-emerald-100 text-emerald-700",
        _ => "bg-slate-100 text-slate-700",
    };

    public static string StatusDot(string status) => status switch
    {
        "open" => "bg-red-400",
        "investigating" => "bg-amber-400",
        "mitigated" => "bg-sky-400",
        "resolved" => "bg-emerald-400",
        _ => "bg-slate-400",
    };

    public static string Confidence(string confidence) => confidence switch
    {
        "high" => "bg-emerald-100 text-emerald-700",
        "medium" => "bg-amber-100 text-amber-700",
        "low" => "bg-slate-100 text-slate-600",
        _ => "",
    };

    public static string LogLevel(string level) => level switch
    {
        "ERROR" => "text-red-700 bg-red-50",
        "FATAL" => "text-red-800 bg-red-100",
        "WARN" => "text-amber-800 bg-amber-50",
        _ => "text-slate-600 bg-slate-100",
    };

    public static string EvidenceKind(string kind) => kind switch
    {
        "log" => "bg-sky-100 text-sky-700",
        "dep" => "bg-violet-100 text-violet-700",
        "met" => "bg-teal-100 text-teal-700",
        "tl" => "bg-amber-100 text-amber-700",
        "doc" => "bg-emerald-100 text-emerald-700",
        "hist" => "bg-pink-100 text-pink-700",
        _ => "bg-slate-100 text-slate-700",
    };

    public static (string Label, string Class, string Title) Review(string state) => state switch
    {
        "pending" => ("Needs review", "bg-amber-100 text-amber-700", "AI findings exist but no one has verified the root cause and reviewed the RCA"),
        "verified" => ("Verified", "bg-emerald-100 text-emerald-700", "Root cause verified and RCA marked reviewed by a person"),
        _ => ("Not investigated", "bg-slate-100 text-slate-600", "No completed investigation yet"),
    };

    /// <summary>Which tab shows a cited record, by the kind of its evidence ID.</summary>
    public static string TabForEvidence(string reference)
    {
        var colon = reference.IndexOf(':');
        return (colon >= 0 ? reference[..colon] : reference) switch
        {
            "log" => "logs",
            "dep" => "deployments",
            "hist" => "similar",
            "mcp" => "systems",
            _ => "overview",
        };
    }

    /// <summary>A metric moved enough to call out.</summary>
    public static bool MovedSharply(MetricSnapshot m) => m.Peak >= Math.Max(3 * m.Baseline, m.Baseline + 1);
}

/// <summary>
/// One colour per system, used everywhere a system appears: pills, cards, citations and the trace.
/// Chips use a light shade on a translucent tint of the same colour; the icon tile and the bar carry the saturated gradient.
/// </summary>
public sealed record SystemStyle(string Label, string Blurb, string Tile, string Soft, string Text, string Chip, string Dot, string Ring, string Bar, string Accent, string Hollow)
{
    public static readonly IReadOnlyList<string> Order = ["database", "files", "deploys", "metrics"];

    private static readonly Dictionary<string, SystemStyle> All = new()
    {
        ["database"] = new("Database", "SQL Server health, blocking chains, long queries, deadlocks, errors and file space.",
            "tile-sky gloss text-white", "bg-sky-100", "text-sky-700", "bg-sky-100 text-sky-700", "bg-sky-500", "ring-sky-200",
            "bg-gradient-to-r from-sky-400 to-indigo-500", "border-l-sky-500", "bg-surface ring-2 ring-sky-500"),
        ["files"] = new("Files & logs", "Search log files, read the end of a file, list recent changes, check a path and free disk space.",
            "tile-amber gloss text-white", "bg-amber-100", "text-amber-700", "bg-amber-100 text-amber-700", "bg-amber-500", "ring-amber-200",
            "bg-gradient-to-r from-amber-400 to-orange-500", "border-l-amber-500", "bg-surface ring-2 ring-amber-500"),
        ["deploys"] = new("Deploys & Git", "Releases and commits in a time window, and what a release changed (files and a short diff).",
            "tile-violet gloss text-white", "bg-violet-100", "text-violet-700", "bg-violet-100 text-violet-700", "bg-violet-500", "ring-violet-200",
            "bg-gradient-to-r from-violet-400 to-fuchsia-500", "border-l-violet-500", "bg-surface ring-2 ring-violet-500"),
        ["metrics"] = new("Metrics & host", "A metric's baseline, peak and timing for a service, and the host's CPU and memory right now.",
            "tile-green gloss text-white", "bg-emerald-100", "text-emerald-700", "bg-emerald-100 text-emerald-700", "bg-emerald-500", "ring-emerald-200",
            "bg-gradient-to-r from-emerald-400 to-teal-500", "border-l-emerald-500", "bg-surface ring-2 ring-emerald-500"),
    };

    public static SystemStyle Of(string system) => All.GetValueOrDefault(system) ?? All["files"];

    /// <summary>Evidence labels for system checks read "&lt;system&gt;: &lt;tool&gt;"; anything else isn't a system.</summary>
    public static string? OfLabel(string label)
    {
        var s = label.Split(':')[0];
        return Order.Contains(s) ? s : null;
    }
}
