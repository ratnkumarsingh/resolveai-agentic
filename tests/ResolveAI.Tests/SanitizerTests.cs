using ResolveAI.App.Pipeline;
using ResolveAI.App.Services;
using ResolveAI.Contracts;

namespace ResolveAI.Tests;

public sealed class SanitizerTests
{
    [Fact]
    public void Masks_common_pii_and_secret_formats()
    {
        var (text, redactions) = Sanitizer.Sanitize(
            "email=alex@example.com phone=+1 (415) 555-0134 ssn=123-45-6789 ip=192.168.10.24 token=eyJhbGciOiJIUzI1NiJ9.payload.signature");

        Assert.DoesNotContain("alex@example.com", text);
        Assert.DoesNotContain("415", text);
        Assert.DoesNotContain("123-45-6789", text);
        Assert.DoesNotContain("192.168.10.24", text);
        Assert.DoesNotContain("eyJhbGciOiJIUzI1NiJ9", text);
        Assert.Contains("[REDACTED_PII]", text);
        Assert.Contains("[IP_ADDRESS]", text);
        Assert.True(redactions >= 5);
    }

    [Fact]
    public void Masks_pii_in_tool_arguments_before_packet_exposure()
    {
        var call = new ToolCallRecord
        {
            Ref = "mcp:1",
            System = "files",
            Server = "files",
            Tool = "files_search",
            Args = new Dictionary<string, object?> { ["query"] = "email=alex@example.com ip=10.0.0.4" },
            Summary = "matching file",
            Rows = [],
            Ok = true,
        };

        var (item, redactions) = Packet.ToolItem(call);

        Assert.DoesNotContain("alex@example.com", item.Source);
        Assert.DoesNotContain("10.0.0.4", item.Source);
        Assert.True(redactions >= 2);
    }
}
