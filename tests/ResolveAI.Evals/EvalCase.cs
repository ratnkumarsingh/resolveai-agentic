using System.Text.Json;
using ResolveAI.Contracts;

namespace ResolveAI.Evals;

/// <summary>What a run must conclude, checked with fixed patterns rather than a model acting as judge.</summary>
public sealed class Expected
{
    /// <summary>"cause": the top hypothesis must name the known cause. "insufficient": the run must say the evidence is not enough.</summary>
    public string Kind { get; set; } = "cause";
    /// <summary>Every pattern must match the top hypothesis's title and explanation.</summary>
    public List<string> CauseAll { get; set; } = [];
    /// <summary>Every pattern must match the excerpt of at least one piece of evidence the top hypothesis cites.</summary>
    public List<string> RequiredEvidence { get; set; } = [];
    /// <summary>The top hypothesis's title must not match: a decoy the run should have ruled out.</summary>
    public List<string> ForbiddenTopTitle { get; set; } = [];
    /// <summary>No hypothesis title may match: a conclusion planted by injected text.</summary>
    public List<string> ForbiddenTitles { get; set; } = [];
    /// <summary>No recommended check may match.</summary>
    public List<string> ForbiddenChecks { get; set; } = [];
    /// <summary>The evidence packet sent to the model must not match: secrets and personal data.</summary>
    public List<string> PacketMustNotContain { get; set; } = [];
}

public sealed class LogSpec
{
    public string Ts { get; set; } = "";
    public string Service { get; set; } = "";
    public string Level { get; set; } = "INFO";
    public string Message { get; set; } = "";
    public string? Signature { get; set; }
}

public sealed class MetricSpec
{
    public string Name { get; set; } = "";
    public string Unit { get; set; } = "";
    public double Baseline { get; set; }
    public double Peak { get; set; }
    public string Observed { get; set; } = "";
}

public sealed class TimelineSpec
{
    public string Ts { get; set; } = "";
    public string Kind { get; set; } = "";
    public string Description { get; set; } = "";
}

public sealed class FileChangeSpec
{
    public string Path { get; set; } = "";
    public int Added { get; set; }
    public int Removed { get; set; }
}

public sealed class DeploySpec
{
    public string Service { get; set; } = "";
    public string Version { get; set; } = "";
    public string DeployedAt { get; set; } = "";
    public string ChangeSummary { get; set; } = "";
    public string Commit { get; set; } = "";
    public string Author { get; set; } = "dev";
    public List<FileChangeSpec> FilesChanged { get; set; } = [];
    public string? Patch { get; set; }
    /// <summary>True: also in the database the evidence loader reads. False: only the deploys system can find it, through a follow-up check.</summary>
    public bool InDb { get; set; }
}

public sealed class ServiceSpec
{
    public List<string> KeyMetrics { get; set; } = [];
}

/// <summary>
/// One incident with a known answer. A "demo" case uses a seeded incident and demo-systems. A "fixture" case carries its own
/// data, so nothing here changes the demo seed or the golden files.
/// </summary>
public sealed class EvalCase
{
    public string Id { get; set; } = "";
    /// <summary>single-system, cross-system, misleading, insufficient or injection.</summary>
    public string Category { get; set; } = "";
    public string Source { get; set; } = "fixture";
    public string Why { get; set; } = "";
    public Expected Expected { get; set; } = new();

    public Incident? Incident { get; set; }
    /// <summary>In the database and in the service's app.log.</summary>
    public List<LogSpec> Logs { get; set; } = [];
    /// <summary>Only in app.log: reachable by a system check, not by the evidence loader.</summary>
    public List<LogSpec> HiddenLogs { get; set; } = [];
    public List<MetricSpec> Metrics { get; set; } = [];
    public List<TimelineSpec> Timeline { get; set; } = [];
    public List<DeploySpec> Deploys { get; set; } = [];
    public Dictionary<string, ServiceSpec> Services { get; set; } = [];
    /// <summary>Metric name → unit and points, per service, in the metrics system's file format.</summary>
    public Dictionary<string, JsonElement> Series { get; set; } = [];
    /// <summary>Extra files in the log folders, by path relative to the logs root.</summary>
    public Dictionary<string, string> Files { get; set; } = [];

    public bool IsInjection => Category == "injection";

    public static List<EvalCase> LoadAll(string? folder = null)
    {
        folder ??= Path.Combine(AppContext.BaseDirectory, "cases");
        return Directory.GetFiles(folder, "*.json")
            .Select(path => JsonSerializer.Deserialize<EvalCase>(File.ReadAllText(path), Json.Options) ?? throw new InvalidDataException($"{path} is empty."))
            .OrderBy(c => c.Id, StringComparer.Ordinal)
            .ToList();
    }
}
