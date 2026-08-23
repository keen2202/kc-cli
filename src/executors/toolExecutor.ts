// Tool executor - handles single and parallel tool execution with permission checks

import { randomBytes, createHmac, timingSafeEqual } from 'node:crypto';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ToolCall, ToolResult } from '../query/protocol';
import type { ToolDefinition, ToolUseContext, UserInteractionHandler } from '../tools/protocol';
import type {
  PermissionResult,
  PermissionAskDecision,
  UIPermissionRequest,
  UIPermissionRequestHandler,
  FilePatchPreview,
} from '../permissions/protocol';
import type { ToolExecutionState } from '../state/types';
import type { PluginHooks } from '../plugins/types';
import { hasPermissionsToUseTool } from '../permissions/engine';
import { isReadOnlyBashCommand } from '../permissions/readonlyCommands';
import { getState } from '../bootstrap/state';
import type { AgentToolRestriction } from '../orchestrator/protocol';
import { SandboxManager } from '../services/sandbox';
import { mergeSandboxPolicy } from '../services/sandbox-policy';
import { createLocalExecutionEnv } from '../services/execution-env-local';
import type { ExecutionEnv } from '../services/execution-env';
import { Semaphore } from '../utils/semaphore';
import { DEFAULT_TOOL_TIMEOUT_MS } from '../constants';
import { getErrorMessage } from '../utils/errors';
import { logger } from '../services/logger';
import { classifyToolError } from '../services/error-classifier';
import { getOperationAuditLog } from '../services/operation-audit-log';

/**
 * Key used to mark tool input that has already had its command
 * wrapped by the executor's sandbox. Tools check for this marker
 * to avoid double-wrapping.
 */
export const SANDBOX_WRAPPED_MARKER = '__sandboxWrapped' as const;

/**
 * Key used to store the HMAC signature on wrapped tool input.
 */
export const SANDBOX_SIGNATURE_KEY = '__sandboxSignature' as const;

/**
 * Session secret for HMAC signing. Generated once per process start.
 * Not persisted — each process gets a fresh secret.
 */
const SESSION_SECRET = randomBytes(32);

/**
 * Adapt a tool's typed checkPermissions function to the untyped signature
 * expected by hasPermissionsToUseTool. The input is checked against the
 * tool's Zod schema at the call site, so this adapter is type-safe at runtime.
 */
function createPermissionAdapter(tool: ToolDefinition): (
  input: Record<string, unknown>,
  context: import('../permissions/protocol').PermissionContext
) => import('../permissions/protocol').PermissionResult {
  return (input, context) =>
    tool.checkPermissions
      ? tool.checkPermissions(
          input as Record<string, unknown> as Parameters<NonNullable<typeof tool.checkPermissions>>[0],
          context as unknown as Parameters<NonNullable<typeof tool.checkPermissions>>[1]
        )
      : { behavior: 'passthrough' as const, message: 'No permission check defined' };
}

/**
 * Create an HMAC signature for a sandbox-wrapped tool ID.
 * Used to prevent external code from forging the sandbox marker.
 */
export function createSandboxSignature(toolId: string): string {
  return createHmac('sha256', SESSION_SECRET).update(toolId).digest('hex');
}

/**
 * Verify an HMAC signature for a sandbox-wrapped tool ID.
 * Uses timingSafeEqual to prevent timing attacks.
 */
export function verifySandboxSignature(toolId: string, signature: string): boolean {
  try {
    const expected = createHmac('sha256', SESSION_SECRET).update(toolId).digest('hex');
    const expectedBuf = Buffer.from(expected, 'hex');
    const signatureBuf = Buffer.from(signature, 'hex');
    if (expectedBuf.length !== signatureBuf.length) return false;
    return timingSafeEqual(expectedBuf, signatureBuf);
  } catch {
    return false;
  }
}

/**
 * Tool names whose input contains a `command` field that must be
 * sandbox-wrapped at the executor level to prevent tools from
 * accidentally or intentionally bypassing sandbox policy.
 */
const COMMAND_EXECUTING_TOOLS = new Set(['Bash', 'Run']);

/**
 * Maximum number of tools that can execute concurrently.
 * Can be overridden via config.
 */
const DEFAULT_MAX_CONCURRENT_TOOLS = 5;

/**
 * Tool names that spawn OS processes or make network calls.
 * These share a process-wide concurrency cap to prevent resource exhaustion
 * when multiple sub-agents (each with their own ToolExecutor) execute them.
 */
export const OS_NETWORK_TOOLS = new Set<string>(['Bash', 'Run', 'WebFetch', 'Sql']);

/**
 * Default maximum concurrent OS/network tool executions across the entire process.
 * Based on CPU count with a minimum of 4.
 */
const DEFAULT_GLOBAL_TOOL_CONCURRENCY = Math.max(4, os.cpus().length);

/**
 * Process-wide semaphore for OS/network tools shared across ALL ToolExecutor instances.
 * Prevents N sub-agents from collectively exceeding the global OS/network limit.
 * This is separate from the per-executor concurrencySemaphore.
 */
export const GLOBAL_TOOL_SEMAPHORE = new Semaphore(DEFAULT_GLOBAL_TOOL_CONCURRENCY);

/**
 * T6 (M1): high-risk tools whose executions are recorded to the unified
 * operation audit log (writes/deletes, command and network tools). Read-only
 * tools (FileRead/Grep/Glob/…) are intentionally excluded to avoid noise.
 */
const AUDITED_TOOLS = new Set<string>([
  'FileWrite', 'FileEdit', 'FileRestore', 'Bash', 'Run', 'Sql', 'WebFetch', 'Git',
]);

/**
 * Build a short, content-free summary of a tool's input for the audit log.
 * Only the operation target (path/command/url/args) is surfaced — never file
 * content — and the caller redacts + length-caps the result.
 */
function summarizeToolInput(toolName: string, input: Record<string, unknown>): string {
  switch (toolName) {
    case 'Bash':
    case 'Run':
      return String(input.command ?? '');
    case 'FileWrite':
      return String(input.path ?? '');
    case 'FileEdit':
      return String(input.file_path ?? '');
    case 'FileRestore':
      return `${String(input.action ?? '')} ${String(input.file ?? '')}`.trim();
    case 'Sql':
      return String(input.query ?? '');
    case 'WebFetch':
      return String(input.url ?? '');
    case 'Git':
      return String(input.args ?? '');
    default:
      return '';
  }
}

/** Longest operation detail surfaced to the confirmation dialog. */
const PERMISSION_DETAILS_MAX = 4000;

/**
 * Build the full, untruncated operation detail shown when the user expands a
 * pending authorization to review exactly what will run. Unlike
 * `summarizeToolInput` (a one-line, length-capped target), this surfaces the
 * complete command / query / argument list plus any other scalar inputs, so
 * the user can make an informed decision. File content is intentionally left
 * to the diff preview; only operation targets/arguments appear here.
 */
function describeToolInputDetails(toolName: string, input: Record<string, unknown>): string | undefined {
  const lines: string[] = [];
  const add = (label: string, value: unknown): void => {
    if (value === undefined || value === null) return;
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    if (text.trim() === '') return;
    lines.push(`${label}: ${text}`);
  };

  switch (toolName) {
    case 'Bash':
    case 'Run':
      if (String(input.command ?? '').trim()) lines.push(`Command:\n${String(input.command)}`);
      add('Working dir', input.cwd);
      add('Timeout (ms)', input.timeout);
      break;
    case 'FileWrite':
      add('File', input.path);
      add('Append', input.append);
      break;
    case 'FileEdit':
      add('File', input.file_path);
      if (Array.isArray(input.edits)) add('Edits', input.edits.length);
      break;
    case 'FileRestore':
      add('Action', input.action);
      add('File', input.file);
      break;
    case 'Sql':
      if (String(input.query ?? '').trim()) lines.push(`Query:\n${String(input.query)}`);
      break;
    case 'WebFetch':
      add('URL', input.url);
      break;
    case 'Git':
      add('Args', input.args);
      break;
    default: {
      // Unknown tool: surface every scalar argument so nothing is hidden.
      for (const [key, value] of Object.entries(input)) {
        if (typeof value !== 'object' || value === null) add(key, value);
      }
    }
  }

  if (lines.length === 0) return undefined;
  const text = lines.join('\n');
  return text.length > PERMISSION_DETAILS_MAX
    ? text.slice(0, PERMISSION_DETAILS_MAX) + '\n… (truncated)'
    : text;
}

/**
 * Tool executor that supports both sequential and parallel tool execution
 * with timeout protection and sandbox isolation to prevent infinite hangs.
 */
export class ToolExecutor {
  private tools: Map<string, ToolDefinition>;
  private cachedToolNames: string[]; // Cached since tools don't change after construction
  private cwd: string;
  private permissionConfig?: {
    alwaysDenyRules?: string[];
    alwaysAskRules?: string[];
    alwaysAllowRules?: string[];
  };
  private pluginHooks?: PluginHooks;
  private sandboxManager: SandboxManager;
  private concurrencySemaphore: Semaphore;
  private executionEnv: ExecutionEnv;
  private readonly defaultTimeoutMs = DEFAULT_TOOL_TIMEOUT_MS;

  // Optional tool block check for defense-in-depth phase restrictions
  private toolBlockCheck: ((toolName: string) => string | null) | null = null;
  // Agent-specific tool restrictions (e.g., read-only Bash for researcher)
  private agentToolRestrictions: AgentToolRestriction[] = [];
  // Optional interactive authorization handler (set by the UI). When present,
  // 'ask' permission decisions are routed to the user instead of silently
  // proceeding. In non-interactive (CLI) contexts this stays null.
  private permissionRequestHandler: UIPermissionRequestHandler | null = null;
  // Optional interactive clarification handler (set by the UI or a CLI stdin
  // implementation). When present, tools like AskUser route through it to
  // block for real user input. Null in non-interactive contexts.
  private userInteractionHandler: UserInteractionHandler | null = null;
  // T1 (H1): Fail-safe policy for 'ask' permission decisions when NO interactive
  // handler is registered (headless: ACP/IM/programmatic). Default 'deny' so
  // non-interactive runs never silently proceed on an 'ask'. 'allow'/'proceed'
  // require explicit opt-in (config or CLI --dangerously-skip-permissions) and
  // are treated as user-accepted risk with an explicit log record.
  private noninteractiveAskPolicy: 'deny' | 'allow' | 'proceed' = 'deny';

  constructor(
    tools: ToolDefinition[],
    cwd: string,
    permissionConfig?: {
      alwaysDenyRules?: string[];
      alwaysAskRules?: string[];
      alwaysAllowRules?: string[];
    },
    pluginHooks?: PluginHooks,
    sandboxOptions?: {
      enabled?: boolean;
      backend?: 'bubblewrap' | 'seccomp' | 'docker' | 'noop';
      allowNetwork?: boolean;
      maxMemoryMb?: number;
      cpuTimeLimitSec?: number;
      failIfNoSandbox?: boolean;
      policy?: Parameters<typeof mergeSandboxPolicy>[0];
    },
    concurrencyOptions?: {
      maxConcurrentTools?: number;
    }
  ) {
    this.tools = new Map(tools.map(tool => [tool.name, tool]));
    this.cachedToolNames = Array.from(this.tools.keys());
    this.cwd = cwd;
    this.permissionConfig = permissionConfig;
    this.pluginHooks = pluginHooks;

    // Initialize concurrency semaphore
    const maxConcurrent = concurrencyOptions?.maxConcurrentTools ?? DEFAULT_MAX_CONCURRENT_TOOLS;
    this.concurrencySemaphore = new Semaphore(maxConcurrent);

    // Initialize local execution environment
    this.executionEnv = createLocalExecutionEnv(cwd);

    // Initialize sandbox manager with config
    const policy = sandboxOptions?.policy ? mergeSandboxPolicy(sandboxOptions.policy) : undefined;
    this.sandboxManager = new SandboxManager({
      workDir: cwd,
      enabled: sandboxOptions?.enabled ?? true,
      backend: sandboxOptions?.backend ?? 'bubblewrap',
      allowNetwork: sandboxOptions?.allowNetwork ?? false,
      maxMemoryMb: sandboxOptions?.maxMemoryMb ?? 512,
      cpuTimeLimitSec: sandboxOptions?.cpuTimeLimitSec ?? 60,
      failIfNoSandbox: sandboxOptions?.failIfNoSandbox ?? true,
      policy,
    });
  }

  /**
   * Execute a single tool call with timeout protection.
   *
   * Public entry point: delegates to the implementation, then records a T6
   * operation-audit entry for high-risk tools (best-effort, never throws).
   */
  async executeSingle(
    toolCall: ToolCall,
    context: ToolUseContext
  ): Promise<ToolResult> {
    const startTime = Date.now();
    const result = await this.executeSingleImpl(toolCall, context);
    this.recordOperationAudit(toolCall, result, startTime);
    return result;
  }

  private async executeSingleImpl(
    toolCall: ToolCall,
    context: ToolUseContext
  ): Promise<ToolResult> {
    try {
      // 1. Find tool
      const tool = this.tools.get(toolCall.toolName);
      if (!tool) {
        return {
          toolCallId: toolCall.id,
          output: `Unknown tool: ${toolCall.toolName}`,
          isError: true,
        };
      }

      // 1b. Planning phase tool restriction (defense-in-depth)
      if (this.toolBlockCheck) {
        const blockMsg = this.toolBlockCheck(toolCall.toolName);
        if (blockMsg) {
          return {
            toolCallId: toolCall.id,
            output: blockMsg,
            isError: true,
          };
        }
      }

      // 1c. Agent tool restrictions (e.g., researcher read-only Bash)
      if (this.agentToolRestrictions.length > 0) {
        const restriction = this.agentToolRestrictions.find(r => r.toolName === toolCall.toolName);
        if (restriction) {
          if (restriction.restrictions.readOnly && toolCall.toolName === 'Bash') {
            const command = (toolCall.input as Record<string, unknown>).command as string;
            if (command && !isReadOnlyBashCommand(command)) {
              return {
                toolCallId: toolCall.id,
                output: `Agent restricted to read-only Bash commands. Blocked: ${command.slice(0, 100)}`,
                isError: true,
              };
            }
          }
        }
      }

      // 2. Plugin preToolUse hook (may modify input)
      let effectiveInput = toolCall.input;
      if (this.pluginHooks?.preToolUse) {
        try {
          const modifiedInput = await this.pluginHooks.preToolUse(toolCall.toolName, toolCall.input, context);
          if (modifiedInput === null) {
            return {
              toolCallId: toolCall.id,
              output: `Tool execution blocked by plugin hook`,
              isError: true,
            };
          }
          effectiveInput = modifiedInput;
        } catch (err) {
          logger.tools.error('[Plugin] preToolUse hook error: ' + String(err));
        }
      }

      // 3. Permission check
      const permissionResult = await this.checkPermission(toolCall, tool, context);
      if (permissionResult.behavior === 'deny') {
        return {
          toolCallId: toolCall.id,
          output: `Permission denied: ${permissionResult.message}`,
          isError: true,
        };
      }

      // 3a. Interactive authorization for 'ask' decisions.
      // When a UI handler is registered, the user explicitly approves or denies
      // each 'ask'. Without a handler (headless: ACP/IM/programmatic), T1's
      // fail-safe policy applies — default 'deny' so we never silently proceed.
      if (permissionResult.behavior === 'ask') {
        const isEditTool = toolCall.toolName === 'FileWrite' || toolCall.toolName === 'FileEdit';
        // acceptEdits mode approves file writes/edits without prompting (kept
        // for both interactive and headless paths).
        const autoAcceptEdits = isEditTool && this.getPermissionMode() === 'acceptEdits';
        if (!autoAcceptEdits) {
          if (this.permissionRequestHandler) {
            const request: UIPermissionRequest = {
              toolName: toolCall.toolName,
              inputSummary: permissionResult.message,
              details: describeToolInputDetails(
                toolCall.toolName,
                effectiveInput as Record<string, unknown>,
              ),
              diffs: await this.buildDiffPreview(toolCall.toolName, effectiveInput),
            };
            const decision = await this.permissionRequestHandler(request);
            if (decision === 'deny') {
              return {
                toolCallId: toolCall.id,
                output: `Permission denied by user: ${toolCall.toolName}`,
                isError: true,
              };
            }
            if (decision === 'allow_always') {
              this.addSessionAllowRule(toolCall.toolName);
            }
            // 'allow' / 'allow_always' fall through to execution.
          } else {
            // T1 (H1): no interactive handler → fail-safe by policy.
            const failSafe = this.resolveNoninteractiveAsk(toolCall, permissionResult);
            if (failSafe) {
              return failSafe;
            }
            // 'allow' / 'proceed' fall through to execution (explicit opt-in).
          }
        }
      }

      // 3b. Check sandbox requirement for command-based tools
      const sandboxDecision = this.sandboxManager.shouldSandboxTool(toolCall.toolName);
      if (sandboxDecision === 'deny') {
        return {
          toolCallId: toolCall.id,
          output: `Tool '${toolCall.toolName}' requires sandbox but no sandbox backend is available. ` +
            'Install bubblewrap (bwrap) or docker, or configure this tool as excluded.',
          isError: true,
        };
      }

      // 3c. Pre-wrap commands at the executor level for command-executing tools.
      // This is the authoritative sandbox enforcement point — tools MUST NOT
      // bypass this by creating their own SandboxManager. The wrapped command
      // is injected into input and marked to prevent double-wrapping.
      // An HMAC signature is attached to prevent external code from forging the marker.
      let effectiveInputWithWrap = effectiveInput;
      if (COMMAND_EXECUTING_TOOLS.has(toolCall.toolName) && sandboxDecision === 'run-sandboxed') {
        const wrappedCommand = this.sandboxManager.wrapCommand(
          (effectiveInput as Record<string, unknown>).command as string,
          toolCall.toolName
        );
        const signature = createSandboxSignature(toolCall.toolName);
        effectiveInputWithWrap = {
          ...effectiveInput,
          command: wrappedCommand,
          [SANDBOX_WRAPPED_MARKER]: true,
          [SANDBOX_SIGNATURE_KEY]: signature,
        } as Record<string, unknown> as typeof effectiveInput;
      }

      // 4. Execute tool with concurrency limit and timeout
      const timeoutMs = this.getToolTimeout(tool);

      // Inner execution function scoped to this executor's concurrency limiter.
      const runWithExecutorPermit = () =>
        this.concurrencySemaphore.withPermit(async () =>
          this.executeWithTimeout(tool, effectiveInputWithWrap, context, timeoutMs, toolCall.toolName, toolCall.id)
        );

      // OS/network tools also acquire the process-wide global semaphore.
      // The global cap is acquired first, then the per-executor cap,
      // ensuring N sub-agents don't collectively exceed the global limit.
      const result = OS_NETWORK_TOOLS.has(toolCall.toolName)
        ? await GLOBAL_TOOL_SEMAPHORE.withPermit(runWithExecutorPermit)
        : await runWithExecutorPermit();

      // 4b. Add sandbox metadata to result
      if (result.metadata) {
        result.metadata.sandboxed = this.sandboxManager.isAvailable() && sandboxDecision === 'run-sandboxed';
        result.metadata.sandboxBackend = this.sandboxManager.getBackendName();
      } else {
        result.metadata = {
          sandboxed: this.sandboxManager.isAvailable() && sandboxDecision === 'run-sandboxed',
          sandboxBackend: this.sandboxManager.getBackendName(),
        };
      }

      // 5. Plugin postToolUse hook (may override result)
      let finalResult = result;
      if (this.pluginHooks?.postToolUse) {
        try {
          const postResult = await this.pluginHooks.postToolUse(toolCall.toolName, effectiveInput, finalResult, context);
          if (postResult != null) {
            finalResult = postResult as ToolResult;
          }
        } catch (err) {
          logger.tools.error('[Plugin] postToolUse hook error: ' + String(err));
        }
      }

      return finalResult;
    } catch (error) {
      const classified = classifyToolError(error instanceof Error ? error : new Error(String(error)), toolCall.toolName, toolCall.id);
      let output = `Tool execution failed: ${getErrorMessage(error)}`;
      if (classified.repairSuggestion) {
        output += `\nSuggestion: ${classified.repairSuggestion}`;
      }
      return {
        toolCallId: toolCall.id,
        output,
        isError: true,
      };
    }
  }

  /**
   * T6 (M1): record a high-risk tool operation to the unified audit log.
   * Best-effort and fully swallowed — auditing must never disrupt execution.
   */
  private recordOperationAudit(toolCall: ToolCall, result: ToolResult, startTime: number): void {
    if (!AUDITED_TOOLS.has(toolCall.toolName)) return;
    try {
      const metadata = (result.metadata ?? {}) as Record<string, unknown>;
      getOperationAuditLog().record({
        sessionId: this.getSessionIdSafe(),
        tool: toolCall.toolName,
        inputSummary: summarizeToolInput(
          toolCall.toolName,
          toolCall.input as Record<string, unknown>,
        ),
        permissionDecision: this.classifyAuditDecision(result),
        sandboxed: metadata.sandboxed === true,
        isError: result.isError === true,
        durationMs: Date.now() - startTime,
        backupPath: typeof metadata.backupPath === 'string' ? metadata.backupPath : undefined,
        timedOut: result.timedOut === true ? true : undefined,
      });
    } catch {
      // Auditing is best-effort; swallow all errors.
    }
  }

  /** Classify the permission-gate outcome from the tool result output. */
  private classifyAuditDecision(result: ToolResult): 'allow' | 'deny' {
    const out = typeof result.output === 'string' ? result.output : '';
    if (
      result.isError &&
      (out.startsWith('Permission denied') ||
        out.includes('requires sandbox but no sandbox backend'))
    ) {
      return 'deny';
    }
    return 'allow';
  }

  /** Read the active session ID, defaulting to 'unknown' when state is absent. */
  private getSessionIdSafe(): string {
    try {
      return getState().sessionId;
    } catch {
      return 'unknown';
    }
  }

  /**
   * Execute tool with timeout protection using AbortSignal.
   * Returns a timeout result with the original toolCallId and timedOut flag.
   */
  private async executeWithTimeout(
    tool: ToolDefinition,
    input: Record<string, unknown>,
    context: ToolUseContext,
    timeoutMs: number,
    toolName: string,
    toolCallId?: string
  ): Promise<ToolResult> {
    // Create abort controller for this tool execution
    const toolAbortController = new AbortController();

    // PERF-01: Save abort listener reference for cleanup
    const onParentAbort = () => {
      toolAbortController.abort(context.abortController?.signal.reason);
    };

    // Merge with parent abort signal if available
    if (context.abortController?.signal) {
      context.abortController.signal.addEventListener('abort', onParentAbort, { once: true });
    }

    // Timeout promise - rejects after timeoutMs
    const timeoutError = new Error(`Tool '${toolName}' timed out after ${timeoutMs / 1000}s`);
    let timedOut = false;
    // PERF-02: Save setTimeout handle for cleanup
    let timeoutHandle: ReturnType<typeof setTimeout>;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        toolAbortController.abort(timeoutError);
        reject(timeoutError);
      }, timeoutMs);
    });

    // Create tool execution promise with abort signal, sandbox, and execution env
    const execPromise = tool.call(input, {
      ...context,
      abortController: toolAbortController,
      sandbox: this.sandboxManager,
      env: context.env ?? this.executionEnv,
      interaction: context.interaction ?? this.userInteractionHandler ?? undefined,
    });

    // Race between timeout and execution
    try {
      const result = await Promise.race([execPromise, timeoutPromise]);
      if (toolAbortController.signal.aborted) {
        throw timeoutError;
      }
      const toolResult = result as ToolResult;
      return {
        toolCallId: toolCallId || '',
        output: toolResult.output ?? '',
        isError: toolResult.isError || false,
        // T3/T6: preserve the tool's own metadata (path, oldContent, backupPath,
        // …) and message so the QueryEngine undo journal and the operation audit
        // log can consume them. Previously this object dropped metadata, leaving
        // the journal's backupPath/oldContent null in the real execution path.
        ...(toolResult.metadata !== undefined ? { metadata: toolResult.metadata } : {}),
        ...(toolResult.message !== undefined ? { message: toolResult.message } : {}),
      };
    } catch (error) {
      if (timedOut) {
        return {
          toolCallId: toolCallId || '',
          output: `Tool '${toolName}' timed out after ${timeoutMs / 1000}s`,
          isError: true,
          timedOut: true,
        };
      }
      throw error;
    } finally {
      // PERF-01: Remove abort listener to prevent leak
      if (context.abortController?.signal) {
        context.abortController.signal.removeEventListener('abort', onParentAbort);
      }
      // PERF-02: Clear timeout handle to prevent leak
      clearTimeout(timeoutHandle!);
    }
  }

  /**
   * Get timeout for a specific tool (uses tool's metadata or default)
   */
  private getToolTimeout(tool: ToolDefinition): number {
    // Check if tool has a custom timeout in its metadata
    const timeout = tool.timeout;
    if (typeof timeout === 'number' && Number.isFinite(timeout) && timeout > 0) {
      return timeout * 1000; // Convert seconds to ms
    }
    return this.defaultTimeoutMs;
  }

  /**
   * Execute multiple tool calls in parallel
   * Respects concurrency safety flags per tool
   */
  async executeParallel(
    toolCalls: ToolCall[],
    context: ToolUseContext
  ): Promise<Map<string, ToolResult | Error>> {
    const results = new Map<string, ToolResult | Error>();

    // Enrich context with sandbox manager and execution env
    const enrichedContext: ToolUseContext = {
      ...context,
      sandbox: this.sandboxManager,
      env: context.env ?? this.executionEnv,
      interaction: context.interaction ?? this.userInteractionHandler ?? undefined,
    };

    // Group tools by concurrency safety
    const concurrentTools: ToolCall[] = [];
    const sequentialTools: ToolCall[] = [];

    for (const toolCall of toolCalls) {
      const tool = this.tools.get(toolCall.toolName);
      if (tool?.isConcurrencySafe?.(toolCall.input) !== false) {
        concurrentTools.push(toolCall);
      } else {
        sequentialTools.push(toolCall);
      }
    }

    // Execute concurrent tools in parallel
    if (concurrentTools.length > 0) {
      const promises = concurrentTools.map(async (toolCall) => {
        try {
          const result = await this.executeSingle(toolCall, enrichedContext);
          return { toolCallId: toolCall.id, result };
        } catch (error) {
          return {
            toolCallId: toolCall.id,
            error: error instanceof Error ? error : new Error(String(error)),
          };
        }
      });

      const settled = await Promise.allSettled(promises);

      for (const result of settled) {
        if (result.status === 'fulfilled') {
          if ('error' in result.value && result.value.error) {
            results.set(result.value.toolCallId, result.value.error);
          } else {
            results.set(result.value.toolCallId, result.value.result);
          }
        }
      }
    }

    // Execute sequential tools one by one
    for (const toolCall of sequentialTools) {
      try {
        const result = await this.executeSingle(toolCall, enrichedContext);
        results.set(toolCall.id, result);
      } catch (error) {
        results.set(
          toolCall.id,
          error instanceof Error ? error : new Error(String(error))
        );
      }
    }

    return results;
  }

  /**
   * Extract content string from tool input for permission matching
   */
  private extractContentForPermission(toolName: string, input: Record<string, unknown>): string | undefined {
    // Extract the most relevant string for content-based permission rules
    switch (toolName) {
      case 'Bash':
        return input.command as string;
      case 'FileRead':
      case 'FileWrite':
      case 'Glob':
      case 'Grep':
        return input.path as string;
      case 'Git':
        return input.args as string;
      default:
        return undefined;
    }
  }

  /**
   * Batch permission check for multiple tool calls
   * Returns permission results for all tools before execution
   */
  async batchPermissionCheck(
    toolCalls: ToolCall[],
    context: ToolUseContext
  ): Promise<PermissionResult[]> {
    const results: PermissionResult[] = [];

    for (const toolCall of toolCalls) {
      const tool = this.tools.get(toolCall.toolName);
      if (!tool) {
        results.push({
          behavior: 'deny',
          message: `Unknown tool: ${toolCall.toolName}`,
        });
        continue;
      }

      const permission = await hasPermissionsToUseTool(toolCall.toolName, toolCall.input, {
        toolCheckPermissions: createPermissionAdapter(tool),
        content: this.extractContentForPermission(toolCall.toolName, toolCall.input),
        config: this.permissionConfig,
      });

      results.push(permission);
    }

    return results;
  }

  /**
   * Check permission for a single tool call
   */
  private async checkPermission(
    toolCall: ToolCall,
    tool: ToolDefinition,
    context: ToolUseContext
  ): Promise<PermissionResult> {
    return await hasPermissionsToUseTool(toolCall.toolName, toolCall.input, {
      toolCheckPermissions: createPermissionAdapter(tool),
      content: this.extractContentForPermission(toolCall.toolName, toolCall.input),
      config: this.permissionConfig,
    });
  }

  /**
   * Get registered tool names
   */
  getRegisteredTools(): string[] {
    return this.cachedToolNames;
  }

  /**
   * Check if a tool is registered
   */
  hasTool(toolName: string): boolean {
    return this.tools.has(toolName);
  }

  /**
   * Get tool definition by name
   */
  getTool(toolName: string): ToolDefinition | undefined {
    return this.tools.get(toolName);
  }

  /**
   * Get the execution environment for filesystem and shell access.
   */
  getExecutionEnv(): ExecutionEnv {
    return this.executionEnv;
  }

  /**
   * Get the sandbox manager for inspecting sandbox state.
   */
  getSandboxManager(): SandboxManager {
    return this.sandboxManager;
  }

  /**
   * Set an optional tool block check callback.
   * If set and returns a non-null string, the tool execution is blocked
   * with the returned message. Used for defense-in-depth phase restrictions
   * (e.g., blocking write/edit during planning phase).
   */
  setToolBlockCheck(check: ((toolName: string) => string | null) | null): void {
    this.toolBlockCheck = check;
  }

  /**
   * Register an interactive authorization handler. When set, tool 'ask'
   * decisions are routed to this handler (the UI) which resolves with the
   * user's decision. Pass null to detach (e.g., on UI teardown).
   */
  setPermissionRequestHandler(handler: UIPermissionRequestHandler | null): void {
    this.permissionRequestHandler = handler;
  }

  /**
   * T1 (H1): Configure the fail-safe policy applied to 'ask' permission
   * decisions in non-interactive contexts (no UI handler registered).
   * - 'deny'    (default): refuse the operation with an explicit reason.
   * - 'allow' / 'proceed': explicit opt-in to run the operation unattended
   *   (e.g. --dangerously-skip-permissions); logged as accepted risk.
   */
  setNoninteractiveAskPolicy(policy: 'deny' | 'allow' | 'proceed'): void {
    this.noninteractiveAskPolicy = policy;
  }

  /**
   * Resolve an 'ask' decision when there is no interactive handler.
   * Returns a deny ToolResult under the default fail-safe policy, or null to
   * let execution proceed when the operator has explicitly opted in.
   */
  private resolveNoninteractiveAsk(
    toolCall: ToolCall,
    permissionResult: PermissionAskDecision,
  ): ToolResult | null {
    const policy = this.noninteractiveAskPolicy;
    if (policy === 'deny') {
      logger.permissions.warn(
        `[perm] non-interactive 'ask' denied (fail-safe): ${toolCall.toolName}`,
        { tool: toolCall.toolName, policy, ts: Date.now() }
      );
      const reason = permissionResult.message || 'requires interactive approval';
      return {
        toolCallId: toolCall.id,
        output:
          `Permission denied (non-interactive): ${toolCall.toolName} ${reason}. ` +
          'No interactive approval handler is available in this context. ' +
          'Re-run with --dangerously-skip-permissions (accepts risk) or an explicit allow rule to proceed.',
        isError: true,
      };
    }
    // 'allow' | 'proceed' — explicit operator opt-in; record the bypass.
    logger.permissions.warn(
      `[perm] non-interactive 'ask' auto-approved by policy='${policy}': ${toolCall.toolName}`,
      { tool: toolCall.toolName, policy, ts: Date.now() }
    );
    return null;
  }

  /**
   * Register an interactive clarification handler (H4). When set, tools such as
   * AskUser route through it to block for real user input. Pass null to detach.
   */
  setUserInteractionHandler(handler: UserInteractionHandler | null): void {
    this.userInteractionHandler = handler;
  }

  /** Current permission mode from global state (defaults to 'default'). */
  private getPermissionMode(): string {
    try {
      return getState().permissionMode;
    } catch {
      return 'default';
    }
  }

  /**
   * Add a session-scoped allow rule for a tool so subsequent calls to the same
   * tool are auto-approved by the permission engine (Step 5 allow-rule match).
   */
  private addSessionAllowRule(toolName: string): void {
    if (!this.permissionConfig) this.permissionConfig = {};
    if (!this.permissionConfig.alwaysAllowRules) this.permissionConfig.alwaysAllowRules = [];
    if (!this.permissionConfig.alwaysAllowRules.includes(toolName)) {
      this.permissionConfig.alwaysAllowRules.push(toolName);
    }
  }

  /**
   * Build a diff preview for write-capable tools (FileWrite/FileEdit) so the
   * authorization dialog can show the user exactly what will change. Returns
   * undefined for tools that do not produce a file diff, or on read failure.
   */
  private async buildDiffPreview(
    toolName: string,
    input: Record<string, unknown>,
  ): Promise<FilePatchPreview[] | undefined> {
    try {
      const fs = this.executionEnv.fs;
      if (toolName === 'FileWrite') {
        const rel = input.path as string;
        if (!rel) return undefined;
        const filePath = path.resolve(this.cwd, rel);
        const exists = await fs.exists(filePath);
        const existing = exists ? await fs.readFile(filePath, 'utf-8') : null;
        const append = input.append === true;
        const content = String(input.content ?? '');
        return [{
          filePath: rel,
          oldContent: existing,
          newContent: append ? (existing ?? '') + content : content,
        }];
      }
      if (toolName === 'FileEdit') {
        const rel = input.file_path as string;
        if (!rel) return undefined;
        const filePath = path.resolve(this.cwd, rel);
        if (!(await fs.exists(filePath))) return undefined;
        const oldContent = await fs.readFile(filePath, 'utf-8');
        const edits = (input.edits as Array<{
          old_string: string;
          new_string: string;
          replace_all?: boolean;
        }>) || [];
        let newContent = oldContent;
        for (const edit of edits) {
          if (edit.replace_all) {
            newContent = newContent.split(edit.old_string).join(edit.new_string);
          } else if (newContent.includes(edit.old_string)) {
            newContent = newContent.replace(edit.old_string, edit.new_string);
          }
        }
        return [{ filePath: rel, oldContent, newContent }];
      }
      return undefined;
    } catch {
      // Best-effort preview: never block authorization on a read error.
      return undefined;
    }
  }

  /**
   * Set agent-specific tool restrictions for capability enforcement.
   * Used by the orchestrator to enforce read-only Bash, etc.
   */
  setAgentToolRestrictions(restrictions: AgentToolRestriction[]): void {
    this.agentToolRestrictions = restrictions;
  }

  /**
   * Verify that tool input has a valid sandbox signature.
   * Returns true if the input was properly sandbox-wrapped by this executor.
   */
  static verifySandboxInput(input: Record<string, unknown>, toolName: string): boolean {
    return isAlreadySandboxWrapped(input, toolName);
  }
}

/**
 * Check if tool input was already sandbox-wrapped by the executor.
 * Shared utility for tools to avoid double-wrapping commands.
 */
export function isAlreadySandboxWrapped(
  input: Record<string, unknown>,
  toolName: string
): boolean {
  const marker = input[SANDBOX_WRAPPED_MARKER];
  const signature = input[SANDBOX_SIGNATURE_KEY];

  if (marker !== true || typeof signature !== 'string') {
    return false;
  }

  return verifySandboxSignature(toolName, signature);
}
