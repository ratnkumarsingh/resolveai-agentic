using System.Text.Json;
using Anthropic;
using Anthropic.Core;
using Anthropic.Exceptions;
using Anthropic.Helpers.Beta;
using Anthropic.Models.Beta.Messages;
using ResolveAI.Contracts;

namespace ResolveAI.App.Llm;

/// <summary>Live provider: calls Claude server-side with a structured-output schema.</summary>
/// <param name="baseUrl">A gateway that speaks the Anthropic Messages API, in place of Anthropic's own API.</param>
public sealed class ClaudeProvider(string apiKey, string model, HttpClient? http = null, string? baseUrl = null) : ILlmProvider
{
    private readonly AnthropicClient _client = http is null
        ? new() { ApiKey = apiKey, BaseUrl = baseUrl ?? EnvironmentUrl.Production, MaxRetries = 2, Timeout = TimeSpan.FromSeconds(90) }
        : new() { ApiKey = apiKey, BaseUrl = baseUrl ?? EnvironmentUrl.Production, MaxRetries = 0, Timeout = TimeSpan.FromSeconds(90), HttpClient = http };

    public string Mode => "live";
    public string? Model => model;

    public Task<LlmResult<InvestigationOutput>> Investigate(EvidencePacket packet, CancellationToken ct) =>
        Call(Schemas.InvestigationJson, Schemas.ParseInvestigation, Prompts.InvestigationSystem, Prompts.InvestigationUserMessage(packet), ct);

    public Task<LlmResult<RcaOutput>> DraftRca(RcaInput input, CancellationToken ct) =>
        Call(Schemas.RcaJson, Schemas.ParseRca, Prompts.RcaSystem, Prompts.RcaUserMessage(input), ct);

    public FollowUp FollowUp => async (packet, tools, call, maxCalls, ct) =>
    {
        var usage = new Dictionary<string, long> { ["follow_up_input_tokens"] = 0, ["follow_up_output_tokens"] = 0, ["follow_up_turns"] = 0 };
        try
        {
            var runnable = tools.Select(t => (IBetaRunnableTool)new BetaRunnableTool
            {
                Name = t.Name,
                Definition = new BetaTool
                {
                    Name = t.Name,
                    Description = t.Description,
                    InputSchema = new InputSchema
                    {
                        Properties = t.InputSchema.TryGetProperty("properties", out var props)
                            ? props.EnumerateObject().ToDictionary(p => p.Name, p => p.Value.Clone())
                            : [],
                        Required = t.InputSchema.TryGetProperty("required", out var required)
                            ? required.EnumerateArray().Select(r => r.GetString()!).ToList()
                            : [],
                    },
                },
                Run = async (toolUse, token) =>
                {
                    var args = JsonSerializer.Deserialize<Dictionary<string, object?>>(JsonSerializer.Serialize(toolUse.Input), Json.Options) ?? [];
                    return await call(t.Name, args, token);
                },
            }).ToList();

            var parameters = new MessageCreateParams
            {
                Model = model,
                MaxTokens = 4000,
                OutputConfig = new BetaOutputConfig { Effort = Effort.Low },
                System = Prompts.FollowUpSystem,
                Messages = [new BetaUserMessageParam { Content = Prompts.FollowUpUserMessage(packet, maxCalls) }],
            };

            if (baseUrl is null) parameters = parameters with { Betas = ["server-side-fallback-2026-07-01"], Fallbacks = new Default() };
            var runner = _client.Beta.Messages.ToolRunner(parameters, runnable, thread: false, maxIterations: maxCalls + 1);
            await foreach (var message in runner.WithCancellation(ct))
            {
                usage["follow_up_input_tokens"] += message.Usage.InputTokens;
                usage["follow_up_output_tokens"] += message.Usage.OutputTokens;
                usage["follow_up_turns"]++;
            }
        }
        catch (Exception err) when (err is not LlmError and not OperationCanceledException)
        {
            throw ToLlmError(err);
        }
        return usage;
    };

    private async Task<LlmResult<T>> Call<T>(string schemaJson, Func<string, T> parse, string system, string content, CancellationToken ct)
    {
        BetaMessage res;
        try
        {
            var parameters = new MessageCreateParams
            {
                Model = model,
                MaxTokens = 16000,
                OutputConfig = new BetaOutputConfig
                {
                    Effort = Effort.Medium,
                    Format = new BetaJsonOutputFormat { Schema = JsonSerializer.Deserialize<Dictionary<string, JsonElement>>(schemaJson)! },
                },
                System = system,
                Messages = [new BetaUserMessageParam { Content = content }],
            };
            if (baseUrl is null) parameters = parameters with { Betas = ["server-side-fallback-2026-07-01"], Fallbacks = new Default() };
            res = await _client.Beta.Messages.Create(parameters, ct);
        }
        catch (Exception err) when (err is not OperationCanceledException)
        {
            throw ToLlmError(err);
        }

        if (res.StopReason == BetaStopReason.Refusal) throw new LlmError("The model declined to analyse this evidence. Review the packet for unusual content and try again.");
        if (res.StopReason == BetaStopReason.MaxTokens) throw new LlmError("The model's answer was cut off before it finished.", retryable: true);

        var text = string.Concat(res.Content.Select(block => block.TryPickText(out var t) ? t.Text : ""));
        try
        {
            return new LlmResult<T>(parse(text), res.Model.Raw(), new Dictionary<string, long>
            {
                ["input_tokens"] = res.Usage.InputTokens,
                ["output_tokens"] = res.Usage.OutputTokens,
                ["cache_read_input_tokens"] = res.Usage.CacheReadInputTokens ?? 0,
            });
        }
        catch (JsonException)
        {
            throw new LlmError("The model returned output that did not match the expected format.", retryable: true);
        }
    }

    private static LlmError ToLlmError(Exception err) => err switch
    {
        LlmError e => e,
        AnthropicUnauthorizedException or AnthropicForbiddenException => new LlmError("The Claude API rejected the server's credentials. Check ANTHROPIC_API_KEY."),
        AnthropicRateLimitException => new LlmError("The Claude API is rate limiting requests. Wait a minute and run the investigation again."),
        TimeoutException or TaskCanceledException => new LlmError("The Claude API timed out. Run the investigation again; the incident data is unchanged."),
        HttpRequestException or AnthropicIOException => new LlmError("Could not reach the Claude API. Check the server's network connection and try again."),
        AnthropicBadRequestException => new LlmError($"The Claude API rejected the request: {err.Message}"),
        AnthropicApiException e => new LlmError($"The Claude API returned an error ({(int)e.StatusCode}). Try again shortly."),
        AnthropicException or JsonException => new LlmError("The model returned output that could not be parsed.", retryable: true),
        _ => new LlmError("Unexpected error while calling the model."),
    };
}
