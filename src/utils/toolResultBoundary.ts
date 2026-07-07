// Untrusted-content boundary wrapping for tool results (S7 prompt-injection mitigation).
//
// Content fetched from external sources (web pages, arbitrary files) may contain
// prompt-injection attempts. Wrapping such content in an explicit boundary marker
// + marking it `trusted=false` lets the model distinguish tool-produced data from
// genuine instructions. A matching constraint in the system prompt instructs the
// model not to execute instructions found inside tool results.

/**
 * Wrap tool output that originates from an untrusted/external source with a
 * boundary marker so the model treats it as data, not instructions.
 *
 * @param output  The tool output to wrap (non-strings are returned unchanged).
 * @param opts    `trusted: false` marks the content as untrusted; `source` tags
 *                the originating tool (e.g. "WebFetch") for traceability.
 * @returns The wrapped string, or the input unchanged when trusted.
 */
export function formatToolResultContent(
  output: unknown,
  opts: { trusted?: boolean; source?: string } = {}
): unknown {
  if (opts.trusted === false && typeof output === 'string') {
    const sourceTag = opts.source ? ` source=${opts.source}` : '';
    return `<<tool_result trusted=false${sourceTag}>>\n${output}\n<</tool_result>>`;
  }
  return output;
}

/**
 * Tool names whose output is treated as untrusted external content.
 * WebFetch / WebSearch return fetched web content; FileRead returns arbitrary
 * file contents which may carry injected instructions.
 */
export const UNTRUSTED_SOURCE_TOOLS = new Set(['WebFetch', 'WebSearch', 'FileRead']);

/**
 * Convenience: wrap output for a given tool name if that tool is an untrusted source.
 */
export function wrapIfUntrustedSource(output: unknown, toolName: string): unknown {
  if (UNTRUSTED_SOURCE_TOOLS.has(toolName)) {
    return formatToolResultContent(output, { trusted: false, source: toolName });
  }
  return output;
}
