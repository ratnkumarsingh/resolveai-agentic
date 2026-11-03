using System.Globalization;
using System.Text;
using System.Text.Json;
using ResolveAI.Contracts;

namespace ResolveAI.Evals;

public sealed record ReportHeader(string Design, string Mode, string Model, string? GatewayHost, string PromptVersion, string StartedAt, int CasesPlanned, int RunsPerCase, string? StoppedEarly);

public static class Report
{
    private static string N(double value) => value.ToString("N0", CultureInfo.InvariantCulture);
    private static string Cell(string? text) => (text ?? "").Replace('|', '/').ReplaceLineEndings(" ");

    public static string Json(ReportHeader header, IReadOnlyList<RunScore> scores) =>
        JsonSerializer.Serialize(new { header, summary = Summary.Of(scores), scores }, new JsonSerializerOptions(ResolveAI.Contracts.Json.Options) { WriteIndented = true });

    public static string Markdown(ReportHeader h, IReadOnlyList<RunScore> scores)
    {
        var s = Summary.Of(scores);
        var md = new StringBuilder();
        md.Append(CultureInfo.InvariantCulture, $"# Eval report: {h.Design} ({h.Mode})\n\n");
        if (h.Mode != "live") md.Append("> **Not a quality score.** Recorded mode uses written and rule-based analyses, so this only shows that the cases and the scoring run.\n\n");
        if (h.StoppedEarly is not null) md.Append(CultureInfo.InvariantCulture, $"> **Stopped early.** {h.StoppedEarly}\n\n");
        md.Append(CultureInfo.InvariantCulture, $"Model `{h.Model}`{(h.GatewayHost is null ? "" : $" through `{h.GatewayHost}`")}, prompt `{h.PromptVersion}`, started {h.StartedAt}. {h.CasesPlanned} cases, {h.RunsPerCase} run(s) each.\n\n");
        md.Append("| Measure | Result |\n| --- | --- |\n");
        md.Append(CultureInfo.InvariantCulture, $"| Runs completed | {s.Completed} of {s.Runs} |\n");
        md.Append(CultureInfo.InvariantCulture, $"| Correct cause | {s.Correct} of {s.Runs} |\n");
        md.Append(CultureInfo.InvariantCulture, $"| Required citations | {s.CitationsOk} of {s.Runs} |\n");
        md.Append(CultureInfo.InvariantCulture, $"| Passed every check | {s.Passed} of {s.Runs} |\n");
        md.Append(CultureInfo.InvariantCulture, $"| False or unsupported claims | {s.FalseClaims} |\n");
        md.Append(CultureInfo.InvariantCulture, $"| Injection resistance | {s.InjectionOk} of {s.InjectionRuns} |\n");
        md.Append(CultureInfo.InvariantCulture, $"| Tokens | {N(s.TotalTokens)} in total, {N(s.AverageTokens)} per run |\n");
        md.Append(CultureInfo.InvariantCulture, $"| Time | {s.AverageSeconds.ToString("F1", CultureInfo.InvariantCulture)} s per run |\n\n");

        md.Append("## By category\n\n| Category | Correct | Passed |\n| --- | --- | --- |\n");
        foreach (var g in scores.GroupBy(r => r.Category).OrderBy(g => g.Key, StringComparer.Ordinal))
        {
            md.Append(CultureInfo.InvariantCulture, $"| {g.Key} | {g.Count(r => r.Correct)} of {g.Count()} | {g.Count(r => r.Passed)} of {g.Count()} |\n");
        }

        md.Append("\n## Every run\n\nThe checks are fixed patterns, so read the titles too: a right answer in unexpected words shows as a miss.\n\n");
        md.Append("| Case | Run | Result | Top hypothesis | Confidence | Problems | Follow-ups | Tokens | Seconds |\n| --- | --- | --- | --- | --- | --- | --- | --- | --- |\n");
        foreach (var r in scores.OrderBy(r => r.CaseId, StringComparer.Ordinal).ThenBy(r => r.RunNumber))
        {
            md.Append(CultureInfo.InvariantCulture, $"| {r.CaseId} | {r.RunNumber} | {(r.Passed ? "Pass" : "Fail")} | {Cell(r.TopTitle ?? (r.InsufficientEvidence ? "(insufficient evidence)" : "(none)"))} | {r.TopConfidence} | {Cell(Problems(r))} | {r.FollowUpCalls} | {N(r.TotalTokens)} | {r.Seconds.ToString("F1", CultureInfo.InvariantCulture)} |\n");
        }
        return md.ToString();
    }

    private static string Problems(RunScore r)
    {
        var problems = new List<string>();
        if (r.Status != "completed") problems.Add($"{r.Status}: {r.Error}");
        if (r.MissingCause.Count > 0) problems.Add($"cause missing {string.Join(", ", r.MissingCause)}");
        if (r.MissingEvidence.Count > 0) problems.Add($"citation missing {string.Join(", ", r.MissingEvidence)}");
        if (r.ForbiddenHits.Count > 0) problems.Add($"forbidden {string.Join(", ", r.ForbiddenHits)}");
        if (r.RemovedCitations > 0) problems.Add($"{r.RemovedCitations} citation(s) removed");
        if (r.UnverifiedNumbers > 0) problems.Add($"{r.UnverifiedNumbers} unverified number(s)");
        if (r.UnsafeChecksRemoved > 0) problems.Add($"{r.UnsafeChecksRemoved} unsafe check(s) removed");
        if (r.SpeculativeHypotheses > 0) problems.Add($"{r.SpeculativeHypotheses} speculative");
        return string.Join("; ", problems);
    }
}
