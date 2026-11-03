using System.Diagnostics;
using ResolveAI.App.Llm;
using ResolveAI.App.Services;
using ResolveAI.Contracts;

namespace ResolveAI.Evals;

public sealed record RunPlan(IReadOnlyList<EvalCase> Cases, int Runs, long? MaxTokens = null)
{
    /// <summary>From the two live runs measured in Phase 0: 26,326 and 30,891 tokens.</summary>
    public const long EstimatedTokensPerRun = 30_000;

    public int TotalRuns => Cases.Count * Runs;
    public long EstimatedTokens => TotalRuns * EstimatedTokensPerRun;
}

public sealed record EvalResult(List<RunScore> Scores, string? StoppedEarly);

public static class Runner
{
    /// <summary>Longer than the pipeline's own limits (120 s follow-ups, 180 s analysis), so this only catches a stuck run.</summary>
    private static readonly TimeSpan RunLimit = TimeSpan.FromMinutes(6);

    private const int MaxFailuresInARow = 3;

    /// <summary>Runs one case through the real pipeline in its own throwaway world and scores it.</summary>
    public static async Task<RunScore> RunOnce(EvalCase c, ILlmProvider llm, int runNumber = 1)
    {
        await using var world = await Fixture.Create(c);
        var timer = Stopwatch.StartNew();
        var id = Investigations.Start(world.Db, llm, world.Systems, world.Incident, null);
        while (Investigations.GetRow(world.Db, id) is not { Status: "completed" or "failed" })
        {
            if (timer.Elapsed > RunLimit) throw new TimeoutException($"{c.Id} did not finish within {RunLimit.TotalMinutes} minutes.");
            await Task.Delay(100);
        }
        var inv = Investigations.Get(world.Db, id)!;
        return Scorer.Score(c, inv, Investigations.GetRow(world.Db, id)?.EvidencePacket, runNumber, timer.Elapsed.TotalSeconds);
    }

    /// <summary>
    /// Runs the plan one run at a time. It stops before a run that could pass the token budget, and after repeated failures,
    /// so an empty account or a broken gateway can't burn through the plan.
    /// </summary>
    public static async Task<EvalResult> RunAll(RunPlan plan, ILlmProvider llm, Action<RunScore>? progress = null)
    {
        var scores = new List<RunScore>();
        long spent = 0, largest = RunPlan.EstimatedTokensPerRun;
        var failuresInARow = 0;
        for (var run = 1; run <= plan.Runs; run++)
        {
            foreach (var c in plan.Cases)
            {
                if (plan.MaxTokens is { } max && spent + largest > max) return new EvalResult(scores, $"Stopped before the token budget of {max:N0} could be passed; {spent:N0} used.");
                RunScore score;
                try
                {
                    score = await RunOnce(c, llm, run);
                }
                catch (TimeoutException e)
                {
                    score = new RunScore { CaseId = c.Id, Category = c.Category, RunNumber = run, Status = "timed_out", Error = e.Message };
                }
                scores.Add(score);
                spent += score.TotalTokens;
                largest = Math.Max(largest, score.TotalTokens);
                progress?.Invoke(score);
                failuresInARow = score.Status == "completed" ? 0 : failuresInARow + 1;
                if (failuresInARow >= MaxFailuresInARow) return new EvalResult(scores, $"Stopped after {MaxFailuresInARow} failed runs in a row. Last error: {score.Error}");
            }
        }
        return new EvalResult(scores, null);
    }
}
