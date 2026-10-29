import type { InvestigationOutput, RcaOutput } from "@resolveai/shared";
import type { EvidencePacket } from "../pipeline/packet.js";

export interface RcaInput {
  packet: EvidencePacket;
  summary: string | null;
  hypotheses: {
    rank: number;
    title: string;
    explanation: string;
    confidence: string;
    speculative: boolean;
    evidence_ids: string[];
    helpful: boolean | null;
  }[];
  verified_root_cause: string | null;
  engineer_notes: string[];
  similar: { id: string; key: string; root_cause: string; resolution: string }[];
}

export interface LlmResult<T> {
  output: T;
  model: string | null;
  usage?: Record<string, number>;
}

export interface LlmProvider {
  readonly mode: "live" | "recorded";
  readonly model: string | null;
  investigate(packet: EvidencePacket): Promise<LlmResult<InvestigationOutput>>;
  draftRca(input: RcaInput): Promise<LlmResult<RcaOutput>>;
}

/** An error whose message is safe to show the user. `retryable` marks malformed-output failures. */
export class LlmError extends Error {
  constructor(message: string, readonly retryable = false) {
    super(message);
    this.name = "LlmError";
  }
}
