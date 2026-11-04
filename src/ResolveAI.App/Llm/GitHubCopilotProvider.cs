using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using ResolveAI.Contracts;

namespace ResolveAI.App.Llm;

/// <summary>
/// Live provider for GitHub's OpenAI-compatible model inference API. A GitHub token is kept server-side;
/// it is never included in an evidence packet or returned to the browser.
/// </summary>
public sealed class GitHubCopilotProvider : ILlmProvider
{
    private readonly HttpClient _http;
    private readonly string _model;

    public GitHubCopilotProvider(string token, string model, string baseUrl, HttpClient? http = null)
    {
        _model = model;
        _http = http ?? new HttpClient { Timeout = TimeSpan.FromSeconds(90) };
        _http.BaseAddress = new Uri(baseUrl.TrimEnd('/') + "/");
        _http.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", token);
        _http.DefaultRequestHeaders.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
    }

    public string Mode => "live";
    public string? Model => _model;
    public FollowUp? FollowUp => null;

    public Task<LlmResult<InvestigationOutput>> Investigate(EvidencePacket packet, CancellationToken ct) =>
        Call(Schemas.InvestigationJson, Schemas.ParseInvestigation, "investigation", Prompts.InvestigationSystem, Prompts.InvestigationUserMessage(packet), ct);

    public Task<LlmResult<RcaOutput>> DraftRca(RcaInput input, CancellationToken ct) =>
        Call(Schemas.RcaJson, Schemas.ParseRca, "rca", Prompts.RcaSystem, Prompts.RcaUserMessage(input), ct);

    private async Task<LlmResult<T>> Call<T>(string schemaJson, Func<string, T> parse, string schemaName, string system, string user, CancellationToken ct)
    {
        var schema = JsonSerializer.Deserialize<JsonElement>(schemaJson);
        var request = new
        {
            model = _model,
            temperature = 0.1,
            max_tokens = 16000,
            response_format = new
            {
                type = "json_schema",
                json_schema = new { name = schemaName, strict = true, schema },
            },
            messages = new[]
            {
                new { role = "system", content = system },
                new { role = "user", content = user },
            },
        };

        HttpResponseMessage response;
        try
        {
            response = await _http.PostAsync("chat/completions", new StringContent(JsonSerializer.Serialize(request), Encoding.UTF8, "application/json"), ct);
        }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested)
        {
            throw new LlmError("The GitHub model API timed out. Run the investigation again; the incident data is unchanged.");
        }
        catch (HttpRequestException)
        {
            throw new LlmError("Could not reach the GitHub model API. Check the server's network connection and try again.");
        }

        var responseText = await response.Content.ReadAsStringAsync(ct);
        if (!response.IsSuccessStatusCode)
        {
            var status = (int)response.StatusCode;
            throw new LlmError(status switch
            {
                401 or 403 => "The GitHub model API rejected the server's credentials. Check GITHUB_COPILOT_TOKEN.",
                429 => "The GitHub model API is rate limiting requests. Wait and run the investigation again.",
                _ => $"The GitHub model API returned an error ({status}). Try again shortly.",
            });
        }

        try
        {
            using var document = JsonDocument.Parse(responseText);
            var root = document.RootElement;
            var choice = root.GetProperty("choices")[0];
            var finishReason = choice.GetProperty("finish_reason").GetString();
            if (finishReason == "length") throw new LlmError("The GitHub model's answer was cut off before it finished.", retryable: true);
            var text = choice.GetProperty("message").GetProperty("content").GetString() ?? "";
            return new LlmResult<T>(parse(text), root.TryGetProperty("model", out var model) ? model.GetString() : _model, Usage(root));
        }
        catch (LlmError)
        {
            throw;
        }
        catch (JsonException)
        {
            throw new LlmError("The GitHub model returned output that did not match the expected format.", retryable: true);
        }
        catch (KeyNotFoundException)
        {
            throw new LlmError("The GitHub model returned an incomplete response.", retryable: true);
        }
    }

    private static Dictionary<string, long>? Usage(JsonElement root)
    {
        if (!root.TryGetProperty("usage", out var usage)) return null;
        return new Dictionary<string, long>
        {
            ["input_tokens"] = Number(usage, "prompt_tokens"),
            ["output_tokens"] = Number(usage, "completion_tokens"),
        };
    }

    private static long Number(JsonElement value, string name) =>
        value.TryGetProperty(name, out var item) && item.TryGetInt64(out var number) ? number : 0;
}
