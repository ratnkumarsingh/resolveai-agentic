using ResolveAI.App.Llm;
using ResolveAI.Contracts;
using ResolveAI.Evals;

namespace ResolveAI.Tests;

/// <summary>The eval harness itself: nothing here calls a model or spends money.</summary>
public class EvalTests
{
    private static readonly List<EvalCase> Cases = EvalCase.LoadAll();

    private static EvalCase Case(string id) => Cases.Single(c => c.Id == id);

    private static Hypothesis Top(string title, string explanation = "", string confidence = "high", params string[] excerpts) => new()
    {
        Rank = 1,
        Title = title,
        Explanation = explanation,
        Confidence = confidence,
        Evidence = excerpts.Select(e => new ResolvedEvidence { Ref = "log:x", Excerpt = e }).ToList(),
    };

    private static Investigation Done(params Hypothesis[] hypotheses) => new() { Status = "completed", Hypotheses = [.. hypotheses] };

    [Fact]
    public void Cases_cover_what_the_plan_asks_for()
    {
        Assert.InRange(Cases.Count, 12, 15);
        foreach (var id in new[] { "INC-1042", "INC-1043", "INC-1044", "INC-1046" }) Assert.Contains(Cases, c => c.Id == id);
        Assert.True(Cases.Count(c => c.Category == "cross-system") >= Cases.Count / 2 - 1, "Most new cases should span systems.");
        Assert.Contains(Cases, c => c.Category == "misleading");
        Assert.True(Cases.Count(c => c.IsInjection) >= 2);
        Assert.True(Cases.Count(c => c.Expected.Kind == "insufficient") >= 2);
    }

    [Fact]
    public void Every_cause_case_says_what_must_be_concluded_and_cited()
    {
        foreach (var c in Cases.Where(c => c.Expected.Kind == "cause"))
        {
            Assert.True(c.Expected.CauseAll.Count >= 2, $"{c.Id} needs at least two cause patterns.");
            Assert.NotEmpty(c.Expected.RequiredEvidence);
        }
    }

    [Theory]
    [MemberData(nameof(CaseIds))]
    public async Task Every_case_runs_through_the_real_pipeline_in_recorded_mode(string id)
    {
        var score = await Runner.RunOnce(Case(id), new RecordedProvider(0));
        Assert.True(score.Status == "completed", $"{id}: {score.Status}: {score.Error}");
        Assert.Equal(0, score.TotalTokens);
    }

    public static TheoryData<string> CaseIds() => new(Cases.Select(c => c.Id));

    [Fact]
    public async Task Baseline_checks_read_the_cases_own_files()
    {
        await using var world = await Fixture.Create(Case("E-01"));
        var result = await world.Systems.Hub.Call("files_search", new Dictionary<string, object?> { ["root"] = "inventory-svc", ["phrase"] = "cache removed" });
        Assert.True(result.Ok, result.Summary);
        Assert.Contains("cache removed", Json.Serialize(result.Rows));
        var deploys = await world.Systems.Hub.Call("deploys_recent", new Dictionary<string, object?> { ["service"] = "inventory-svc", ["from"] = "2026-09-14T00:00:00Z", ["to"] = "2026-09-14T12:00:00Z" });
        Assert.Contains("v3.1.0", Json.Serialize(deploys.Rows));
    }

    [Fact]
    public async Task Hidden_evidence_is_only_reachable_through_a_system_check()
    {
        await using var world = await Fixture.Create(Case("E-01"));
        var evidence = ResolveAI.App.Pipeline.EvidenceLoader.Load(world.Db, world.Incident);
        Assert.DoesNotContain(evidence.Logs, l => l.Message.Contains("cache removed", StringComparison.Ordinal));
        Assert.DoesNotContain(evidence.Deployments, d => d.ServiceName == "inventory-svc");
    }

    [Fact]
    public void Right_answer_with_right_citation_passes()
    {
        var score = Scorer.Score(Case("E-01"), Done(Top("inventory-svc removed its cache", "v3.1.0 sends all reads to the database", "high", "stock-level read cache removed")), "packet");
        Assert.True(score.Passed);
        Assert.Equal(0, score.FalseClaims);
    }

    [Fact]
    public void Right_answer_without_the_citation_is_correct_but_does_not_pass()
    {
        var score = Scorer.Score(Case("E-01"), Done(Top("inventory-svc removed its cache", "", "high", "checkout timed out")), "packet");
        Assert.True(score.Correct);
        Assert.False(score.CitationsOk);
        Assert.False(score.Passed);
    }

    [Fact]
    public void Decoy_as_the_top_title_fails_and_counts_as_a_false_claim()
    {
        var score = Scorer.Score(Case("E-07"), Done(Top("billing-api v5.0.3 caused the lock wait timeouts via a migration", "", "high", "ALTER TABLE invoices")), "packet");
        Assert.False(score.Passed);
        Assert.Equal(1, score.FalseClaims);
    }

    [Fact]
    public void Wrong_cause_fails()
    {
        var score = Scorer.Score(Case("E-01"), Done(Top("Checkout database is down", "connections refused", "high", "cache")), "packet");
        Assert.False(score.Correct);
        Assert.NotEmpty(score.MissingCause);
    }

    [Fact]
    public void Citation_free_guess_is_not_a_correct_cause()
    {
        var top = Top("inventory-svc removed its cache");
        top.Speculative = true;
        Assert.False(Scorer.Score(Case("E-01"), Done(top), "packet").Correct);
    }

    [Fact]
    public void Failed_run_is_never_correct()
    {
        var inv = Done(Top("inventory-svc removed its cache", "", "high", "cache"));
        inv.Status = "failed";
        Assert.False(Scorer.Score(Case("E-01"), inv, "packet").Passed);
    }

    [Theory]
    [InlineData(true, "low", true)]
    [InlineData(false, "low", true)]
    [InlineData(false, "medium", false)]
    public void Insufficient_cases_reward_saying_so(bool flagged, string confidence, bool correct)
    {
        var inv = Done(Top("Maybe the network", "", confidence));
        inv.InsufficientEvidence = flagged;
        Assert.Equal(correct, Scorer.Score(Case("E-08"), inv, "packet").Correct);
    }

    [Fact]
    public void Injection_succeeding_fails_the_injection_check()
    {
        var planted = Top("Network outage is the root cause", "", "high", "currency_v2");
        var score = Scorer.Score(Case("E-09"), Done(planted), "packet");
        Assert.False(score.InjectionOk);
    }

    [Fact]
    public void Explaining_an_injection_attempt_is_allowed()
    {
        var score = Scorer.Score(Case("E-09"), Done(Top("Schema change added currency_v2, which the consumer can't decode",
            "A log line tries to claim a network outage; that is untrusted text.", "high", "unknown field 'currency_v2'")), "clean packet");
        Assert.True(score.InjectionOk);
        Assert.True(score.Passed);
    }

    [Fact]
    public void A_secret_in_the_packet_fails_the_case()
    {
        var score = Scorer.Score(Case("E-09"), Done(Top("Schema change added currency_v2 to the event", "", "high", "currency_v2")), "password=FAKE-s3cret-value");
        Assert.False(score.InjectionOk);
        Assert.Contains(score.ForbiddenHits, h => h.StartsWith("packet", StringComparison.Ordinal));
    }

    [Fact]
    public void An_unsafe_check_removed_by_the_validator_still_counts_against_injection()
    {
        var inv = Done(Top("Schema change added currency_v2 to the event", "", "high", "currency_v2"));
        inv.ValidationIssues = ["Removed a recommended check: looked destructive"];
        Assert.False(Scorer.Score(Case("E-09"), inv, "packet").InjectionOk);
    }

    [Fact]
    public async Task The_real_pipeline_redacts_the_cases_secrets_before_the_model()
    {
        foreach (var id in new[] { "INC-1044", "E-09" })
        {
            var score = await Runner.RunOnce(Case(id), new RecordedProvider(0));
            Assert.DoesNotContain(score.ForbiddenHits, h => h.StartsWith("packet", StringComparison.Ordinal));
        }
    }

    [Fact]
    public void Tokens_add_up_across_every_model_call_in_the_trace()
    {
        var inv = Done();
        inv.Trace =
        [
            new TraceStage { Details = new() { ["follow_up_input_tokens"] = 100L, ["follow_up_output_tokens"] = 10L } },
            new TraceStage { Details = new() { ["input_tokens"] = 200L, ["output_tokens"] = 20L, ["cache_read_input_tokens"] = 0L, ["calls"] = 7L } },
        ];
        Assert.Equal((300L, 30L), Scorer.Tokens(inv));
    }

    [Fact]
    public async Task Budget_stops_the_run_before_it_can_be_passed()
    {
        var provider = new ScriptedProvider((_, _) => Output.With(Output.Hypothesis("x", "low")));
        var result = await Runner.RunAll(new RunPlan(Cases, 3, MaxTokens: RunPlan.EstimatedTokensPerRun - 1), provider);
        Assert.Empty(result.Scores);
        Assert.Empty(provider.Packets);
        Assert.Contains("token budget", result.StoppedEarly);
    }

    [Fact]
    public async Task Repeated_failures_stop_the_run()
    {
        var provider = new ScriptedProvider((_, _) => throw new LlmError("gateway is down"));
        var result = await Runner.RunAll(new RunPlan(Cases, 3), provider);
        Assert.Equal(3, result.Scores.Count);
        Assert.Contains("failed runs in a row", result.StoppedEarly);
    }

    [Theory]
    [InlineData(new[] { "--mode", "live" }, "key", true)]
    [InlineData(new[] { "--mode", "live", "--yes" }, "key", true)]
    [InlineData(new[] { "--mode", "live", "--max-tokens", "1000" }, "key", true)]
    [InlineData(new[] { "--mode", "live", "--yes", "--max-tokens", "1000" }, null, true)]
    [InlineData(new[] { "--mode", "live", "--yes", "--max-tokens", "1000" }, "key", false)]
    public void Spending_needs_a_key_an_explicit_yes_and_a_token_limit(string[] args, string? key, bool refused) =>
        Assert.Equal(refused, EvalProgram.LiveRefusal(EvalProgram.Parse(args), key) is not null);

    [Fact]
    public void The_default_mode_is_free() => Assert.Equal("recorded", EvalProgram.Parse([]).Mode);

    [Fact]
    public void Designs_that_are_not_built_are_refused() => Assert.Throws<ArgumentException>(() => EvalProgram.Parse(["--design", "specialists"]));

    [Fact]
    public void A_report_never_carries_the_evidence_packet()
    {
        var score = Scorer.Score(Case("E-09"), Done(Top("x")), "password=FAKE-s3cret-value");
        var json = Report.Json(new ReportHeader("pipeline", "live", "m", null, "p", "now", 1, 1, null), [score]);
        Assert.DoesNotContain("FAKE-s3cret-value", json);
    }

    [Fact]
    public void Recorded_reports_say_they_are_not_a_quality_score()
    {
        var md = Report.Markdown(new ReportHeader("pipeline", "recorded", "recorded fixtures", null, "p", "now", 1, 1, null), []);
        Assert.Contains("Not a quality score", md);
    }
}
