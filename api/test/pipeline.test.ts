import { describe, expect, it } from "vitest";
import { run } from "../src/db/index.js";
import { stableId } from "../src/db/seed.js";
import { loadEvidence } from "../src/pipeline/evidence.js";
import { buildPacket } from "../src/pipeline/packet.js";
import { sanitize } from "../src/pipeline/sanitize.js";
import { findSimilar } from "../src/pipeline/similar.js";
import { findIncident } from "../src/services/incidents.js";
import { makeApp } from "./helpers.js";

describe("sanitize", () => {
  it("redacts bearer tokens, API keys, passwords, URL credentials and emails", () => {
    const input =
      "Authorization: Bearer sk_test_FAKEDEMOKEYNOTREAL0000000 smtp://mailer:password=hunter2-FAKE@relay:587 password=hunter2 jane.doe@example.com api_key=abc123";
    const { text, redactions } = sanitize(input);
    expect(text).not.toContain("sk_test_FAKEDE");
    expect(text).not.toContain("hunter2");
    expect(text).not.toContain("jane.doe@example.com");
    expect(text).not.toContain("abc123");
    expect(text).toContain("[EMAIL]");
    expect(redactions).toBeGreaterThanOrEqual(4);
  });

  it("leaves ordinary log text alone", () => {
    const line = "payment-api: database connection acquisition timed out after 5000ms; request_id=req-781";
    expect(sanitize(line)).toEqual({ text: line, redactions: 0 });
  });
});

describe("evidence pipeline", () => {
  it("finds INC-0881 as the top similar incident for INC-1042", () => {
    const { db } = makeApp();
    const evidence = loadEvidence(db, findIncident(db, "INC-1042")!);
    const similar = findSimilar(db, evidence);
    expect(similar[0]?.historical.key).toBe("INC-0881");
    expect(similar[0]?.matched_terms.length).toBeGreaterThan(1);
  });

  it("builds a packet with typed IDs, deduplicated logs and no raw secrets", () => {
    const { db } = makeApp();
    const evidence = loadEvidence(db, findIncident(db, "INC-1042")!);
    const packet = buildPacket(evidence, findSimilar(db, evidence), null);
    const serialized = JSON.stringify(packet);
    expect(serialized).not.toContain("sk_test_FAKEDE");
    expect(packet.redactions).toBeGreaterThan(0);
    expect(packet.items.every((i) => /^(log|dep|met|doc|hist|tl):/.test(i.id))).toBe(true);
    // Three timeouts differ only by request_id and collapse into one group.
    const timeouts = packet.items.filter((i) => i.excerpt.includes("acquisition timed out"));
    expect(timeouts).toHaveLength(1);
    expect(timeouts[0].occurrences).toBe(3);
  });

  it("keeps raw log rows immutable", () => {
    const { db } = makeApp();
    expect(() => run(db, "UPDATE log_events SET message = 'x' WHERE id = ?", stableId("log:INC-1042:secret"))).toThrow(/immutable/);
  });
});
