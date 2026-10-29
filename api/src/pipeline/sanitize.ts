/**
 * Redacts secrets and obvious personal identifiers before text is sent to the model.
 * Raw rows are never modified; this runs when the evidence packet is built.
 */

const RULES: [pattern: RegExp, replacement: string][] = [
  // Credentials embedded in URLs: scheme://user:pass@host
  [/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, "$1[REDACTED]@"],
  // Authorization headers
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/g, "$1 [REDACTED]"],
  // Provider-style API keys
  [/\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{8,}/g, "[REDACTED_KEY]"],
  [/\bsk-ant-[A-Za-z0-9_-]{8,}/g, "[REDACTED_KEY]"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED_KEY]"],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, "[REDACTED_KEY]"],
  // key=value / key: value secrets
  [/\b(password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|client[_-]?secret)(\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s,;&@]+)/gi, "$1$2[REDACTED]"],
  // Email addresses
  [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, "[EMAIL]"],
  // Card-like numbers (13–19 digits, optional separators)
  [/\b(?:\d[ -]?){12,18}\d\b/g, "[CARD]"],
];

export interface SanitizeResult {
  text: string;
  redactions: number;
}

export function sanitize(input: string): SanitizeResult {
  let text = input;
  let redactions = 0;
  for (const [pattern, replacement] of RULES) {
    text = text.replace(pattern, (...args) => {
      redactions++;
      // Re-run the replacement for this single match so $1-style groups resolve.
      return (args[0] as string).replace(new RegExp(pattern.source, pattern.flags.replace("g", "")), replacement);
    });
  }
  return { text, redactions };
}
