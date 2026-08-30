/**
 * view-protocol — the UI's data contracts (spec §3.3.1, T6).
 *
 * Single home for the view-model types (and their pure helpers) shared
 * between the event pipeline (useStreamingEvents), the session mapper and the
 * ink components. Live code imports contracts from HERE only; the legacy
 * string-rendering component files re-export from this module for backward
 * compatibility until T7 retires them. Keeping contracts in a neutral module
 * unties live paths from dead files so cleanup is never high-risk again (F8).
 */

// ── Sidebar ──

export type SidebarSection = 'files' | 'tools' | 'tasks' | 'memory';

export interface SidebarFile {
  path: string;
  hasError?: boolean;
  hasWarning?: boolean;
}

export interface SidebarTool {
  /** Engine tool-call id — correlates completion with the right entry under parallel same-name calls. */
  id?: string;
  name: string;
  status: 'running' | 'completed' | 'failed' | 'pending';
  duration?: string;
  /** Brief input summary (e.g. target path or command), truncated for display. */
  detail?: string;
  /** Wall-clock start, used to derive `duration` when the tool completes. */
  startTime?: number;
}

export interface SidebarTask {
  id: string;
  title: string;
  status: 'pending' | 'in_progress' | 'completed' | 'blocked';
}

export interface SidebarData {
  /** Currently active section */
  activeSection: SidebarSection;
  /** File tree items */
  files: SidebarFile[];
  /** Recent tool calls */
  tools: SidebarTool[];
  /** Task list items */
  tasks: SidebarTask[];
  /** Memory items */
  memories: Array<{ name: string; type: string }>;
  /** Whether sidebar is visible */
  visible: boolean;
}

/**
 * Default sidebar data.
 */
export function createSidebarData(): SidebarData {
  return {
    activeSection: 'tools',
    files: [],
    tools: [],
    tasks: [],
    memories: [],
    visible: true,
  };
}

// ── Tool calls ──

/** Input keys most likely to identify what a tool call is operating on. */
const TOOL_INPUT_SUMMARY_KEYS = [
  'file_path', 'path', 'command', 'query', 'pattern', 'url', 'regex', 'prompt',
];

/**
 * Summarize a tool call's input for compact display (sidebar / status strips):
 * prefers well-known keys, falls back to the first string value, truncated.
 */
export function summarizeToolInput(input: unknown, maxLen = 40): string | undefined {
  if (input === null || typeof input !== 'object') return undefined;
  const record = input as Record<string, unknown>;
  let value: string | undefined;
  for (const key of TOOL_INPUT_SUMMARY_KEYS) {
    if (typeof record[key] === 'string' && (record[key] as string).trim()) {
      value = record[key] as string;
      break;
    }
  }
  if (value === undefined) {
    value = Object.values(record).find(
      (v): v is string => typeof v === 'string' && v.trim().length > 0,
    );
  }
  if (value === undefined) return undefined;
  const oneLine = value.replace(/\s+/g, ' ').trim();
  return oneLine.length > maxLen ? oneLine.slice(0, maxLen - 1) + '…' : oneLine;
}

export interface ToolCallData {
  /** Engine tool-call id — correlates completion with the right card under parallel same-name calls. */
  id?: string;
  toolName: string;
  /** One-line display summary of the input (collapsed card / sidebar). */
  input?: string;
  /** Full raw input args, rendered by the expanded card (Ctrl+O). */
  rawInput?: Record<string, unknown>;
  output?: string;
  status: 'running' | 'completed' | 'failed';
  startTime?: number;
  endTime?: number;
}

// ── Chat ──

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string | null;
  timestamp: number;
  toolCalls?: ToolCallData[];
}

// ── Thinking chain ──

export type ThinkingStepLabel = 'analyze' | 'decide' | 'plan' | 'execute' | 'think';

export interface ThinkingStep {
  label: ThinkingStepLabel;
  content: string;
}

export interface ThinkingChain {
  steps: ThinkingStep[];
  rawContent: string;
  folded: boolean;
  startTime: number;
  /** Set when the turn completes; freezes the displayed duration. Absent while streaming. */
  endTime?: number;
}

/**
 * The in-flight thinking chain of the streaming assistant bubble. Kept separate
 * from the frozen chain map: streaming deltas re-key this object every flush,
 * and folding it into a whole-map identity would invalidate ChatView's cached
 * history rows (full transcript re-flatten) on every tick.
 */
export interface LiveThinkingChain {
  id: string;
  chain: ThinkingChain;
}

/**
 * Classify raw thinking text into structured steps by keyword heuristics.
 * Returns steps with labels based on content patterns.
 */
export function classifyThinkingSteps(raw: string): ThinkingStep[] {
  // Split on paragraph boundaries or sentence boundaries for step detection
  const segments = raw.split(/\n{2,}|(?<=\.)\s+/).filter(s => s.trim().length > 0);
  const steps: ThinkingStep[] = [];

  for (const segment of segments) {
    const lower = segment.toLowerCase();
    let label: ThinkingStepLabel = 'think';

    if (/analyz|look at|examin|consider|review|check/.test(lower)) {
      label = 'analyze';
    } else if (/decid|choos|select|pick|determin/.test(lower)) {
      label = 'decide';
    } else if (/plan|step|first|then|next|approach|strateg/.test(lower)) {
      label = 'plan';
    } else if (/execut|run|call|use|apply|perform/.test(lower)) {
      label = 'execute';
    }

    steps.push({ label, content: segment.trim() });
  }

  return steps.length > 0 ? steps : [{ label: 'think', content: raw }];
}
