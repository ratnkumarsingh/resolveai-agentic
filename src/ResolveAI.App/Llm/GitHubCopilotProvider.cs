using GitHub.Copilot;
using ResolveAI.Contracts;

namespace ResolveAI.App.Llm;

/// <summary>Live provider backed by the official GitHub Copilot SDK.</summary>
public sealed class GitHubCopilotProvider : ILlmProvider
{
    private readonly string _token;
    private readonly string _model;

    public GitHubCopilotProvider(string token, string model)
    {
        _token = token;
        _model = model;
    }

    public string Mode => "live";
    public string? Model => string.IsNullOrWhiteSpace(_model) ? "Copilot default" : _model;
    public FollowUp? FollowUp => null;

    public Task<LlmResult<InvestigationOutput>> Investigate(EvidencePacket packet, CancellationToken ct) =>
        Call<InvestigationOutput>(Prompts.InvestigationSystem, Prompts.InvestigationUserMessage(packet), ValidateInvestigation, ct);

    public Task<LlmResult<RcaOutput>> DraftRca(RcaInput input, CancellationToken ct) =>
        Call<RcaOutput>(Prompts.RcaSystem, Prompts.RcaUserMessage(input), static _ => { }, ct);

    private async Task<LlmResult<T>> Call<T>(string system, string prompt, Action<T> validate, CancellationToken ct)
    {
        try
        {
            await using var client = new CopilotClient(new CopilotClientOptions
            {
                GitHubToken = _token,
                UseLoggedInUser = false,
            });
            await client.StartAsync();
            var sessionConfig = new SessionConfig
            {
                SystemMessage = new SystemMessageConfig { Content = system },
                Streaming = false,
            };
            if (!string.IsNullOrWhiteSpace(_model)) sessionConfig.Model = _model;
            await using var session = await client.CreateSessionAsync(sessionConfig);
#pragma warning disable GHCP001
            var result = await session.SendAndWaitAsync<T>(prompt, Json.Options, cancellationToken: ct);
#pragma warning restore GHCP001
            validate(result);
            var modelName = string.IsNullOrWhiteSpace(_model) ? "Copilot default" : _model;
            return new LlmResult<T>(result, modelName);
        }
        catch (LlmError)
        {
            throw;
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception err)
        {
            throw new LlmError($"The GitHub Copilot SDK could not complete the investigation: {SafeMessage(err)}", retryable: true);
        }
    }

    private static void ValidateInvestigation(InvestigationOutput output)
    {
        if (output.Hypotheses.Any(h => h.Confidence is not ("low" or "medium" or "high")))
            throw new LlmError("The GitHub Copilot response contained an invalid confidence value.", retryable: true);
    }

    private static string SafeMessage(Exception err) => err.Message.Length <= 300 ? err.Message : err.Message[..300] + "…";
}
