using System.Text;
using ResolveAI.Contracts;

namespace ResolveAI.App.Services;

public sealed class TeamsNotifier(HttpClient http, string? webhookUrl)
{
    private readonly HttpClient _http = http;
    private readonly string? _webhookUrl = string.IsNullOrWhiteSpace(webhookUrl) ? null : webhookUrl.Trim();

    public bool Enabled => !string.IsNullOrWhiteSpace(_webhookUrl);

    public async Task NotifyInvestigationCompleted(Incident incident, Investigation investigation, CancellationToken ct = default)
    {
        if (!Enabled) return;

        var top = investigation.Hypotheses.FirstOrDefault();
        var title = top?.Title ?? "No hypothesis generated";
        var confidence = top?.Confidence ?? "n/a";
        var status = investigation.Status;
        var summary = string.IsNullOrWhiteSpace(investigation.Summary) ? "(no summary)" : investigation.Summary;

        var summaryText = $"""
ResolveAI investigation completed
Incident: {incident.Key} - {incident.Title}
Service: {incident.ServiceName}
Severity: {incident.Severity}
Mode: {investigation.LlmMode}
Model: {investigation.ModelName ?? "recorded"}
Status: {status}
Top finding: {title} (confidence: {confidence})
Summary: {summary}
""";

        static string Clip(string value, int max) => value.Length <= max ? value : value[..max];

        var card = new Dictionary<string, object?>
        {
            ["type"] = "AdaptiveCard",
            ["$schema"] = "http://adaptivecards.io/schemas/adaptive-card.json",
            ["version"] = "1.4",
            ["body"] = new object[]
            {
                new { type = "TextBlock", size = "Medium", weight = "Bolder", text = "ResolveAI investigation completed", wrap = true },
                new { type = "TextBlock", text = $"Incident: {incident.Key} - {Clip(incident.Title, 200)}", wrap = true },
                new { type = "FactSet", facts = new object[]
                    {
                        new { title = "Service", value = Clip(incident.ServiceName, 100) },
                        new { title = "Severity", value = incident.Severity },
                        new { title = "Mode", value = investigation.LlmMode },
                        new { title = "Model", value = investigation.ModelName ?? "recorded" },
                        new { title = "Status", value = status },
                        new { title = "Top finding", value = Clip(title, 200) },
                        new { title = "Confidence", value = confidence },
                    }
                },
                new { type = "TextBlock", weight = "Bolder", text = "Summary", wrap = true },
                new { type = "TextBlock", text = Clip(summary, 1500), wrap = true },
                new { type = "TextBlock", spacing = "Small", isSubtle = true, text = DateTimeOffset.UtcNow.ToString("u"), wrap = true },
            }
        };

        using var req = new HttpRequestMessage(HttpMethod.Post, _webhookUrl)
        {
            Content = new StringContent(Json.Serialize(card), Encoding.UTF8, "application/json")
        };
        using var res = await _http.SendAsync(req, ct);
        if (!res.IsSuccessStatusCode)
        {
            var error = await res.Content.ReadAsStringAsync(ct);
            throw new InvalidOperationException($"Teams notification failed with {(int)res.StatusCode}: {error}");
        }
    }
}
