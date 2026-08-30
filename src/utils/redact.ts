// Secret redaction for log and error payloads — round4 §4 (O1)
//
// Provider error bodies occasionally echo request headers back (proxy misconfig,
// verbose upstream errors). Anything that reaches a log line or an error message
// is treated as potentially secret-bearing and passed through `redact`.

/** spec §4 统一要求：sk- keys / Bearer tokens / token= params / KC_* assignments. */
const SECRET_PATTERN = /(sk-|Bearer |token=|KC_[A-Z_]+=)[^\s"']+/gi;

/**
 * Replace secret-bearing substrings with `[REDACTED]`.
 * Safe to call on any string; non-string input is stringified first.
 */
export function redact(text: unknown): string {
  const str = typeof text === 'string' ? text : String(text ?? '');
  return str.replace(SECRET_PATTERN, '[REDACTED]');
}

/** `redact` + hard length cap for anything embedded in a log payload or error message. */
export function redactTruncated(text: unknown, maxLen = 500): string {
  return redact(text).slice(0, maxLen);
}
