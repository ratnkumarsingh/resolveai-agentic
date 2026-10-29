import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { InvestigationOutput, RcaOutput } from "@resolveai/shared";
import type { z } from "zod";
import type { EvidencePacket } from "../pipeline/packet.js";
import { INVESTIGATION_SYSTEM, investigationUserMessage, RCA_SYSTEM, rcaUserMessage } from "./prompts.js";
import { LlmError, type LlmProvider, type LlmResult, type RcaInput } from "./provider.js";

/** Live provider: calls Claude server-side with a structured-output schema. */
export class ClaudeProvider implements LlmProvider {
  readonly mode = "live" as const;
  private readonly client: Anthropic;

  constructor(apiKey: string, readonly model: string) {
    this.client = new Anthropic({ apiKey, maxRetries: 2, timeout: 90_000 });
  }

  investigate(packet: EvidencePacket) {
    return this.call(InvestigationOutput, INVESTIGATION_SYSTEM, investigationUserMessage(packet));
  }

  draftRca(input: RcaInput) {
    return this.call(RcaOutput, RCA_SYSTEM, rcaUserMessage(input));
  }

  private async call<S extends z.ZodType>(schema: S, system: string, content: string): Promise<LlmResult<z.infer<S>>> {
    let res;
    try {
      res = await this.client.beta.messages.parse({
        model: this.model,
        max_tokens: 16000,
        // Route safety-classifier refusals to a fallback model chosen server-side.
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        output_config: { effort: "medium", format: betaZodOutputFormat(schema) },
        system,
        messages: [{ role: "user", content }],
      });
    } catch (err) {
      throw toLlmError(err);
    }

    if (res.stop_reason === "refusal") {
      throw new LlmError("The model declined to analyse this evidence. Review the packet for unusual content and try again.");
    }
    if (res.stop_reason === "max_tokens") {
      throw new LlmError("The model's answer was cut off before it finished.", true);
    }
    if (!res.parsed_output) {
      throw new LlmError("The model returned output that did not match the expected format.", true);
    }
    const u = res.usage;
    return {
      output: res.parsed_output as z.infer<S>,
      model: res.model,
      usage: {
        input_tokens: u.input_tokens,
        output_tokens: u.output_tokens,
        cache_read_input_tokens: u.cache_read_input_tokens ?? 0,
      },
    };
  }
}

function toLlmError(err: unknown): LlmError {
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
    return new LlmError("The Claude API rejected the server's credentials. Check ANTHROPIC_API_KEY on the server.");
  }
  if (err instanceof Anthropic.RateLimitError) {
    return new LlmError("The Claude API is rate limiting requests. Wait a minute and run the investigation again.");
  }
  if (err instanceof Anthropic.APIConnectionTimeoutError) {
    return new LlmError("The Claude API timed out. Run the investigation again; the incident data is unchanged.");
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return new LlmError("Could not reach the Claude API. Check the server's network connection and try again.");
  }
  if (err instanceof Anthropic.BadRequestError) {
    return new LlmError(`The Claude API rejected the request: ${err.message}`);
  }
  if (err instanceof Anthropic.APIError) {
    return new LlmError(`The Claude API returned an error (${err.status ?? "unknown"}). Try again shortly.`);
  }
  // JSON/schema parse failures from the parse helper (not HTTP errors, handled above).
  if (err instanceof Anthropic.AnthropicError || err instanceof SyntaxError || (err instanceof Error && err.name === "ZodError")) {
    return new LlmError("The model returned output that could not be parsed.", true);
  }
  return new LlmError("Unexpected error while calling the model.");
}
