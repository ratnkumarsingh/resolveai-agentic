using System.Globalization;
using ResolveAI.App;
using ResolveAI.App.Llm;
using ResolveAI.Mcp;

namespace ResolveAI.Evals;

/// <summary>
/// dotnet run --project tests/ResolveAI.Evals                     recorded mode: free, checks the cases and the scoring
/// dotnet run --project tests/ResolveAI.Evals -- --mode live      prints the estimate and spends nothing
/// ... -- --mode live --max-tokens 1500000 --yes                  spends money, up to that many tokens
/// </summary>
public static class EvalProgram
{
    public sealed record Options(string Mode, string Design, int? Runs, long? MaxTokens, bool Yes, bool List, string? Cases);

    public static Options Parse(string[] args)
    {
        string mode = "recorded", design = "pipeline";
        int? runs = null;
        long? maxTokens = null;
        var yes = false;
        var list = false;
        string? cases = null;
        for (var i = 0; i < args.Length; i++)
        {
            string Next() => ++i < args.Length ? args[i] : throw new ArgumentException($"{args[i - 1]} needs a value.");
            switch (args[i])
            {
                case "--mode": mode = Next(); break;
                case "--design": design = Next(); break;
                case "--runs": runs = int.Parse(Next(), CultureInfo.InvariantCulture); break;
                case "--max-tokens": maxTokens = long.Parse(Next(), CultureInfo.InvariantCulture); break;
                case "--cases": cases = Next(); break;
                case "--yes": yes = true; break;
                case "--list": list = true; break;
                default: throw new ArgumentException($"Unknown option {args[i]}.");
            }
        }
        if (mode is not ("recorded" or "live")) throw new ArgumentException("--mode must be recorded or live.");
        if (design != "pipeline") throw new ArgumentException($"Design {design} doesn't exist yet. Only pipeline is built.");
        if (runs is < 1) throw new ArgumentException("--runs must be at least 1.");
        return new Options(mode, design, runs, maxTokens, yes, list, cases);
    }

    /// <summary>Spending needs both an explicit yes and a token limit. Returns why it is refused, or null.</summary>
    public static string? LiveRefusal(Options o, string? apiKey)
    {
        if (string.IsNullOrEmpty(apiKey)) return "No ANTHROPIC_API_KEY is set, so nothing can run live.";
        if (!o.Yes || o.MaxTokens is null) return "Nothing was spent. To run this for real, add both --yes and --max-tokens <limit>.";
        return null;
    }

    public static async Task<int> Main(string[] args)
    {
        Options o;
        try
        {
            o = Parse(args);
        }
        catch (Exception e) when (e is ArgumentException or FormatException or OverflowException)
        {
            await Console.Error.WriteLineAsync(e.Message);
            return 2;
        }

        var all = EvalCase.LoadAll();
        var wanted = o.Cases?.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        var cases = wanted is null ? all : all.Where(c => wanted.Contains(c.Id, StringComparer.OrdinalIgnoreCase)).ToList();
        if (cases.Count == 0)
        {
            await Console.Error.WriteLineAsync("No cases matched.");
            return 2;
        }
        if (o.List)
        {
            foreach (var c in cases) Console.WriteLine($"{c.Id,-10} {c.Category,-13} {c.Why}");
            return 0;
        }

        AppSettings.LoadDotEnv(Path.Combine(McpConfig.RepoRoot(), ".env"));
        var settings = AppSettings.Load();
        var plan = new RunPlan(cases, o.Runs ?? (o.Mode == "live" ? 3 : 1), o.MaxTokens);

        ILlmProvider llm = new RecordedProvider(0);
        if (o.Mode == "live")
        {
            Console.WriteLine($"Plan: {plan.Cases.Count} cases x {plan.Runs} runs = {plan.TotalRuns} live runs on {settings.CopilotModel}.");
            Console.WriteLine($"Estimate: about {plan.EstimatedTokens:N0} tokens, at {RunPlan.EstimatedTokensPerRun:N0} per run (measured in Phase 0).");
            if (LiveRefusal(o, settings.ClaudeApiKey) is { } refusal)
            {
                Console.WriteLine(refusal);
                return settings.ClaudeApiKey is null ? 2 : 0;
            }
            llm = new ClaudeProvider(settings.ClaudeApiKey!, settings.CopilotModel, baseUrl: settings.GitHubModelsBaseUrl);
        }

        var started = DateTimeOffset.UtcNow;
        var result = await Runner.RunAll(plan, llm, r => Console.WriteLine($"{r.CaseId,-10} run {r.RunNumber}: {(r.Passed ? "pass" : "FAIL")} {r.TotalTokens,7:N0} tokens {r.Seconds,6:F1}s  {r.TopTitle ?? r.Error ?? "(no hypothesis)"}"));

        var header = new ReportHeader(o.Design, o.Mode, o.Mode == "live" ? settings.CopilotModel : "recorded fixtures", settings.GitHubModelsBaseUrl is { } url && o.Mode == "live" ? new Uri(url).Host : null, Prompts.Version,
            started.ToString("yyyy-MM-ddTHH:mm:ssZ", CultureInfo.InvariantCulture), plan.Cases.Count, plan.Runs, result.StoppedEarly);
        var markdown = Report.Markdown(header, result.Scores);
        Console.WriteLine();
        Console.WriteLine(markdown);

        // Only live results are worth keeping, and a report never holds the key or the evidence packets.
        if (o.Mode == "live")
        {
            var folder = Path.Combine(McpConfig.RepoRoot(), "tests", "ResolveAI.Evals", "reports");
            Directory.CreateDirectory(folder);
            var stem = Path.Combine(folder, $"{o.Design}-{started:yyyyMMdd-HHmm}");
            await File.WriteAllTextAsync($"{stem}.md", markdown);
            await File.WriteAllTextAsync($"{stem}.json", Report.Json(header, result.Scores));
            Console.WriteLine($"Saved {stem}.md and .json");
        }
        return result.StoppedEarly is null ? 0 : 1;
    }
}
