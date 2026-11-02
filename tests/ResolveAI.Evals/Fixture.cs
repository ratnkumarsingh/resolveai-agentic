using System.IO.Pipelines;
using System.Text;
using System.Text.Json;
using ModelContextProtocol.Client;
using ModelContextProtocol.Protocol;
using ModelContextProtocol.Server;
using ResolveAI.App.Data;
using ResolveAI.App.Mcp;
using ResolveAI.App.Services;
using ResolveAI.Contracts;
using ResolveAI.Mcp;

namespace ResolveAI.Evals;

/// <summary>A throwaway world for one run: an in-memory database and the real MCP tools reading temporary files. It never touches data/resolveai.db.</summary>
public sealed class Fixture : IAsyncDisposable
{
    private readonly string? _folder;

    private Fixture(Db db, Systems systems, Incident incident, string? folder)
    {
        Db = db;
        Systems = systems;
        Incident = incident;
        _folder = folder;
    }

    public Db Db { get; }
    public Systems Systems { get; }
    public Incident Incident { get; }

    public static async Task<Fixture> Create(EvalCase c, int maxFollowUps = 8)
    {
        var db = new Db(":memory:");
        Seed.Demo(db);
        string? folder = null;
        McpConfig cfg;
        string key;
        if (c.Source == "demo")
        {
            cfg = McpConfig.Load(Path.Combine(McpConfig.RepoRoot(), "mcp.config.example.json"));
            key = c.Id;
        }
        else
        {
            var incident = c.Incident ?? throw new InvalidDataException($"{c.Id} has no incident.");
            folder = Path.Combine(Path.GetTempPath(), $"resolveai-eval-{Guid.NewGuid():N}");
            cfg = WriteSystems(c, folder);
            Insert(db, c, incident);
            key = incident.Key;
        }
        // SQL Server stays off, so a run can't depend on the state of this machine's database.
        cfg.Sqlserver.Enabled = false;
        var hub = await McpHub.Connect(ServerDefs.All.Select(d => InProcess(new SystemDef(d.System, d.Server, d.Label), d, cfg)));
        var found = Incidents.Find(db, key) ?? throw new InvalidDataException($"Incident {key} was not found.");
        return new Fixture(db, new Systems(hub, cfg, maxFollowUps), found, folder);
    }

    private static HubEntry InProcess(SystemDef def, ServerDef server, McpConfig cfg) => new(def, server.Enabled(cfg), server.DisabledReason, () =>
    {
        var toServer = new Pipe();
        var toClient = new Pipe();
        var running = McpServer.Create(new StreamServerTransport(toServer.Reader.AsStream(), toClient.Writer.AsStream()), server.Build(cfg).ToOptions());
        _ = running.RunAsync();
        return new StreamClientTransport(toServer.Writer.AsStream(), toClient.Reader.AsStream());
    });

    private static void Insert(Db db, EvalCase c, Incident i)
    {
        var id = EvidenceIds.Stable($"incident:{i.Key}");
        var now = Js.IsoNow();
        db.Run(
            """
            INSERT INTO incidents (id, key, title, service_name, severity, status, environment, started_at, detected_at, resolved_at, description, impact_summary, created_at)
            VALUES (@id, @key, @title, @service, @severity, 'open', 'production', @started, @detected, NULL, @description, @impact, @now)
            """,
            new { id, key = i.Key, title = i.Title, service = i.ServiceName, severity = i.Severity, started = i.StartedAt, detected = i.DetectedAt, description = i.Description, impact = i.ImpactSummary, now });
        for (var n = 0; n < c.Logs.Count; n++)
        {
            var l = c.Logs[n];
            db.Run(
                """
                INSERT INTO log_events (id, incident_id, timestamp, service_name, level, message, error_signature, trace_id, source)
                VALUES (@logId, @id, @ts, @service, @level, @message, @signature, NULL, 'app')
                """,
                new { logId = EvidenceIds.Stable($"log:{i.Key}:{n}"), id, ts = l.Ts, service = l.Service, level = l.Level, message = l.Message, signature = l.Signature });
        }
        foreach (var m in c.Metrics)
        {
            db.Run(
                "INSERT INTO metric_snapshots (id, incident_id, name, unit, baseline, peak, observed_at) VALUES (@metricId, @id, @name, @unit, @baseline, @peak, @observed)",
                new { metricId = EvidenceIds.Stable($"met:{i.Key}:{m.Name}"), id, name = m.Name, unit = m.Unit, baseline = m.Baseline, peak = m.Peak, observed = m.Observed });
        }
        for (var n = 0; n < c.Timeline.Count; n++)
        {
            var e = c.Timeline[n];
            db.Run(
                "INSERT INTO timeline_events (id, incident_id, timestamp, kind, description) VALUES (@eventId, @id, @ts, @kind, @description)",
                new { eventId = EvidenceIds.Stable($"tl:{i.Key}:{n}"), id, ts = e.Ts, kind = e.Kind, description = e.Description });
        }
        foreach (var d in c.Deploys.Where(d => d.InDb))
        {
            db.Run(
                """
                INSERT INTO deployments (id, service_name, environment, version, deployed_at, change_summary, commit_ref, incident_id)
                VALUES (@deployId, @service, 'production', @version, @at, @summary, @commit, NULL)
                """,
                new { deployId = EvidenceIds.Stable($"dep:{i.Key}:{d.Service}:{d.Version}"), service = d.Service, version = d.Version, at = d.DeployedAt, summary = d.ChangeSummary, commit = d.Commit });
        }
    }

    /// <summary>Writes the case's logs, files, deploy feed and metric series in the formats the real tools read.</summary>
    private static McpConfig WriteSystems(EvalCase c, string folder)
    {
        var logs = Path.Combine(folder, "logs");
        var metrics = Path.Combine(folder, "metrics");
        Directory.CreateDirectory(logs);
        Directory.CreateDirectory(metrics);

        foreach (var group in c.Logs.Concat(c.HiddenLogs).GroupBy(l => l.Service))
        {
            var dir = Path.Combine(logs, group.Key);
            Directory.CreateDirectory(dir);
            var text = new StringBuilder();
            foreach (var l in group.OrderBy(l => l.Ts, StringComparer.Ordinal)) text.Append($"{l.Ts} {l.Level,-5} {l.Service} {l.Message}\n");
            File.WriteAllText(Path.Combine(dir, "app.log"), text.ToString());
        }
        foreach (var (relative, content) in c.Files)
        {
            var path = Path.GetFullPath(relative, logs);
            if (!path.StartsWith(Path.GetFullPath(logs) + Path.DirectorySeparatorChar, StringComparison.Ordinal)) throw new InvalidDataException($"{c.Id}: {relative} is outside the logs folder.");
            Directory.CreateDirectory(Path.GetDirectoryName(path)!);
            File.WriteAllText(path, content);
        }
        foreach (var (service, series) in c.Series) File.WriteAllText(Path.Combine(metrics, $"{service}.json"), series.GetRawText());

        var feed = Path.Combine(folder, "deploys.json");
        File.WriteAllText(feed, JsonSerializer.Serialize(c.Deploys, Json.Options));

        var cfg = new McpConfig
        {
            Files = new FilesConfig { AllowedRoots = [logs] },
            Deploys = new DeploysConfig { Feed = feed },
            Metrics = new MetricsConfig { SeriesDir = metrics },
        };
        foreach (var dir in Directory.GetDirectories(logs))
        {
            var name = Path.GetFileName(dir);
            cfg.Services[name] = new ServiceConfig { LogRoots = [dir], KeyMetrics = c.Services.GetValueOrDefault(name)?.KeyMetrics ?? [] };
        }
        return cfg;
    }

    public async ValueTask DisposeAsync()
    {
        await Systems.Hub.DisposeAsync();
        Db.Dispose();
        if (_folder is null) return;
        try
        {
            Directory.Delete(_folder, recursive: true);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            // A temporary folder left behind is harmless.
        }
    }
}
