// Report integrity validator (RI-SPEC §3.1) — deterministic rules R1–R5.
//
// This module is pure and synchronous by design: regex/string/structure checks
// only (no LLM calls, no I/O). The orchestrator uses it to decide whether a
// sub-agent completion report may settle, or whether a bounded follow-up turn
// is required.

import type {
  CommandRunClaim,
  ReportFinding,
  RequiredSections,
  SubAgentResult,
} from './types.js';

/** Recommended default sections for a completion report (RI-SPEC R1). */
export const DEFAULT_REQUIRED_SECTIONS: string[] = [
  '交付物清单',
  '命令+退出码',
  '检查站作答',
];

type Requirements = RequiredSections | string[];

interface NormalizedRequirements {
  sections: string[];
  checkpoints: string[];
}

function normalizeRequirements(required?: Requirements): NormalizedRequirements {
  if (Array.isArray(required)) {
    return { sections: required, checkpoints: [] };
  }
  const sections =
    required?.requiredSections ?? required?.sections ?? required?.required ?? DEFAULT_REQUIRED_SECTIONS;
  return {
    sections: Array.isArray(sections) ? sections : DEFAULT_REQUIRED_SECTIONS,
    checkpoints: Array.isArray(required?.checkpoints) ? required!.checkpoints! : [],
  };
}

// ─── R1: required sections ───────────────────────────────────────────────

const DELIVERY_ALIASES = [
  '交付物',
  '交付清单',
  '文件清单',
  '产物清单',
  '变更文件',
  '修改文件',
  '新建文件',
  '删除文件',
  'deliverable',
  'deliverables',
  'file list',
  'files created',
  'files modified',
  'files changed',
  'artifacts',
];

const COMMAND_ALIASES = [
  '命令+退出码',
  '命令与退出码',
  '命令/退出码',
  '命令',
  '退出码',
  'exit code',
  'exit status',
  'command',
  'commands',
  'commands and exit',
  'command + exit code',
  'command and exit code',
  'commands + exit codes',
  'command runs',
];

const CHECKPOINT_ALIASES = [
  '检查站作答',
  '检查站',
  '探针作答',
  '探针',
  'checkpoint',
  'checkpoints',
  'probe answers',
  'checkpoint answers',
];

function includesAny(haystack: string, needles: string[]): boolean {
  const lower = haystack.toLowerCase();
  return needles.some((n) => lower.includes(n.toLowerCase()));
}

function hasDeliveryEvidence(output: string, claim: SubAgentResult['claim']): boolean {
  if (claim) {
    if (Array.isArray(claim.filesCreated) || Array.isArray(claim.filesModified)) return true;
  }
  return includesAny(output, DELIVERY_ALIASES);
}

function hasCommandEvidence(output: string, claim: SubAgentResult['claim']): boolean {
  if (claim && Array.isArray(claim.commands) && claim.commands.length > 0) {
    return claim.commands.some(
      (c): c is CommandRunClaim => Boolean(c) && typeof c.command === 'string' && typeof c.exitCode === 'number',
    );
  }
  const hasCommand = /(?:命令|command|\$ |npm |npx |pnpm |yarn |tsc\b|vitest\b|pytest\b)/i.test(output);
  const hasExitCode = /(?:退出码|返回码|状态码|exit\s*(?:code|status)|exitCode)/i.test(output);
  return hasCommand && hasExitCode;
}

const DEFLECTION_RE = /(?:作答\s*见消息开头|答案?\s*见消息开头|见消息开头|见前文|详见前文|already answered|answer(?:ed)? (?:at|in) (?:the )?(?:beginning|above)|as (?:stated|answered) above)/i;

function isCheckpointAnswered(output: string, question: string): boolean {
  const q = question.trim();
  if (!q) return true;

  const idx = output.indexOf(q);
  if (idx === -1) {
    // Checkpoint IDs are also acceptable when the report maps them to
    // explicit answers, e.g. "1. ..." / "checkpoint-1: ...".
    const marker = q.slice(0, Math.min(q.length, 24)).toLowerCase();
    if (marker.length >= 4 && output.toLowerCase().includes(marker)) {
      const markerIdx = output.toLowerCase().indexOf(marker);
      const tail = output.slice(markerIdx + marker.length, markerIdx + marker.length + 300);
      if (!DEFLECTION_RE.test(tail) && /(?:答|回答|answer|结果|结论|是|否|采用|选择|通过|失败|完成|yes|no|pass|fail|✅|❌)/i.test(tail)) {
        return true;
      }
    }
    return false;
  }

  const tail = output.slice(idx + q.length, idx + q.length + 400);
  if (DEFLECTION_RE.test(tail)) return false;
  return /(?:答|回答|answer|结果|结论|是|否|采用|选择|通过|失败|完成|未完成|因为|since|yes|no|pass|fail|✅|❌)/i.test(tail);
}

function sectionSatisfied(
  section: string,
  result: SubAgentResult,
  checkpoints: string[],
): boolean {
  const output = result.output ?? '';
  const lower = section.trim().toLowerCase();
  if (!lower) return true;

  if (includesAny(section, DELIVERY_ALIASES)) {
    return hasDeliveryEvidence(output, result.claim);
  }

  if (includesAny(section, COMMAND_ALIASES)) {
    return hasCommandEvidence(output, result.claim);
  }

  if (includesAny(section, CHECKPOINT_ALIASES)) {
    if (checkpoints.length > 0) {
      return checkpoints.every((q) => isCheckpointAnswered(output, q));
    }
    if (DEFLECTION_RE.test(output)) return false;
    return includesAny(output, CHECKPOINT_ALIASES);
  }

  // Unknown custom section: accept exact output mention or matching claim key.
  return output.toLowerCase().includes(lower);
}

// ─── R2: numeric claims must cite evidence lines ─────────────────────────

interface NumericClaim {
  value: number;
  raw: string;
  index: number;
}

const COUNT_PATTERNS: RegExp[] = [
  // Chinese count + counter/object: "23 个用例", "21 项检查", "5 个文件"
  /(\d[\d,]*)\s*(?:个|条|项|例|轮|次|份|套)?\s*(?:测试)?(?:用例|案例|断言|检查|文件|命令|接口|问题|缺陷|测试|bug)s?/gi,
  // Verbs immediately followed by a count: "通过 21", "修改了 3", "新增 5 个"
  /(?:共|总计|合计|通过|失败|运行了?|执行了?|修改了?|创建了?|新增了?|删除了?|覆盖了?|有)\s*(\d[\d,]*)/g,
  // English numeric statements: "23 tests passed", "passed: 21"
  /\b(\d[\d,]*)\s*(?:tests?|test cases?|cases?|assertions?|checks?|files?|commands?|items?|examples?|errors?|failures?|passing|failing)\b/gi,
  /\b(?:passed|failed|ran|executed|modified|created|added|removed|total|passing|failing)\s*:?\s*(\d[\d,]*)/gi,
  /\b(\d[\d,]*)\s*(?:passed|failed|skipped|run|executed)\b/gi,
];

function extractNumericClaims(text: string): NumericClaim[] {
  if (!text) return [];
  const found: NumericClaim[] = [];
  const seen = new Set<number>();

  for (const pattern of COUNT_PATTERNS) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      const group = match[1];
      if (!group) continue;
      const value = Number(group.replace(/,/g, ''));
      if (!Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) continue;
      if (seen.has(value)) continue;
      seen.add(value);
      found.push({ value, raw: match[0].trim(), index: match.index });
      // Guard against pathological zero-length matches.
      if (match.index === pattern.lastIndex) pattern.lastIndex++;
    }
  }

  return found.sort((a, b) => a.index - b.index);
}

function extractEvidenceLines(result: SubAgentResult): string[] {
  const claim = result.claim;
  if (!claim || !Array.isArray(claim.commands)) return [];
  const lines: string[] = [];
  for (const command of claim.commands) {
    if (command && typeof command.evidenceLine === 'string' && command.evidenceLine.trim()) {
      lines.push(command.evidenceLine.trim());
    }
  }
  return lines;
}

function extractNumbers(text: string): number[] {
  const numbers: number[] = [];
  const re = /\d[\d,]*/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const value = Number(match[0].replace(/,/g, ''));
    if (Number.isFinite(value)) numbers.push(value);
  }
  return numbers;
}

function validateNumericClaims(result: SubAgentResult, findings: ReportFinding[]): void {
  const claims = extractNumericClaims(result.output ?? '');
  if (claims.length === 0) return;

  const evidenceLines = extractEvidenceLines(result);
  const parsedEvidence = evidenceLines.map((line) => extractNumbers(line));

  for (const claim of claims) {
    const matched = parsedEvidence.some((numbers) => numbers.includes(claim.value));
    if (matched) continue;

    const anyParseable = parsedEvidence.some((numbers) => numbers.length > 0);
    if (evidenceLines.length === 0) {
      findings.push({
        rule: 'R2',
        severity: 'blocker',
        code: 'numeric_claim_unsubstantiated',
        message: `Numeric claim "${claim.raw}" has no CommandRunClaim.evidenceLine.`,
        unsubstantiated: true,
        detail: String(claim.value),
      });
    } else if (anyParseable) {
      findings.push({
        rule: 'R2',
        severity: 'blocker',
        code: 'numeric_claim_mismatch',
        message: `Numeric claim "${claim.raw}" does not match the cited evidenceLine.`,
        unsubstantiated: true,
        detail: String(claim.value),
      });
    } else {
      // Evidence exists but is not machine-parseable: degrade to warning per
      // RI-T04 instead of blocking an otherwise honest report.
      findings.push({
        rule: 'R2',
        severity: 'warning',
        code: 'numeric_claim_unparseable_evidence',
        message: `Numeric claim "${claim.raw}" has evidenceLine text but no parseable number.`,
        detail: String(claim.value),
      });
    }
  }
}

// ─── R3: obligation citations ────────────────────────────────────────────

const CITATION_RE = /^(?:[#]?\d+[.。]?|(?:msg|message|消息|第|section|sec|节|段|segment|环节|checkpoint|probe|q)\s*[-#:：_]?\s*\d+\s*[条个]?[.。]?|(?:section|sec|节|段|segment|环节)\s*[\w:.#/-]+|[\w.-]+\s*[-#:：/]\s*\d+[.。]?)$/i;

function validateObligationCitations(result: SubAgentResult, findings: ReportFinding[]): void {
  const citations = result.claim?.obligationCitations;
  if (!Array.isArray(citations) || citations.length === 0) {
    findings.push({
      rule: 'R3',
      severity: 'warning',
      code: 'missing_obligation_citations',
      message: 'Completion claim does not cite the source of each process obligation.',
      unsubstantiated: true,
    });
    return;
  }

  const bad = citations.filter((c) => typeof c !== 'string' || !CITATION_RE.test(c.trim()));
  if (bad.length > 0) {
    findings.push({
      rule: 'R3',
      severity: 'warning',
      code: 'unlocatable_obligation_citation',
      message: 'One or more obligation citations cannot be located to an obligation source.',
      unsubstantiated: true,
      detail: bad.map((c) => String(c).slice(0, 80)).join(', '),
    });
  }
}

// ─── R4: boundary attestation (declared files vs execution trace) ───────

function toPosixPath(value: string): string {
  return value.replace(/\\/g, '/').trim();
}

function normalizeTracePath(value: string, cwd?: string): string {
  let path = toPosixPath(value).replace(/^\.\/+/, '');
  path = path.replace(/\/{2,}/g, '/');
  if (cwd) {
    const c = toPosixPath(cwd).replace(/\/+$/, '');
    if (c && path.startsWith(`${c}/`)) path = path.slice(c.length + 1);
  }
  return path;
}

function isTraceExempt(path: string): boolean {
  const p = toPosixPath(path);
  return (
    /(?:^|\/)\.kc-cli\/backups\//.test(p) ||
    /(?:^|\/)node_modules\//.test(p) ||
    /(?:^|\/)\.tmp-/.test(p) ||
    /(?:^|\/)(?:tmp|temp)\//i.test(p)
  );
}

function declaredPaths(result: SubAgentResult): { created: string[]; modified: string[] } {
  const claim = result.claim;
  return {
    created: Array.isArray(claim?.filesCreated)
      ? claim!.filesCreated.filter((p): p is string => typeof p === 'string' && p.trim().length > 0)
      : [],
    modified: Array.isArray(claim?.filesModified)
      ? claim!.filesModified.filter((p): p is string => typeof p === 'string' && p.trim().length > 0)
      : [],
  };
}

function validateBoundary(result: SubAgentResult, findings: ReportFinding[]): void {
  const trace = result.meta?.executionTrace ?? result.meta?.trace;
  if (!trace || !Array.isArray(trace.fileWrites)) return;

  const cwd = trace.cwd;
  const declared = declaredPaths(result);
  const declaredAll = new Set(
    [...declared.created, ...declared.modified].map((p) => normalizeTracePath(p, cwd)),
  );

  const observed = trace.fileWrites
    .filter((w) => Boolean(w) && typeof w.path === 'string')
    .filter((w) => !isTraceExempt(w.path))
    .map((w) => ({ path: normalizeTracePath(w.path, cwd), kind: w.kind }));

  if (observed.length === 0 && declaredAll.size === 0) return;

  const observedAll = new Set(observed.map((w) => w.path));

  // Undeclared writes: the execution trace observed a write the claim omitted.
  for (const write of observed) {
    if (!declaredAll.has(write.path)) {
      findings.push({
        rule: 'R4',
        severity: 'blocker',
        code: 'undeclared_write',
        message: `ExecutionEnv observed a write to "${write.path}" that was not declared in the completion claim.`,
        unsubstantiated: true,
        detail: write.kind,
      });
    }
  }

  // Declared-but-unobserved writes indicate a fabricated boundary claim.
  for (const declaredPath of declaredAll) {
    if (!observedAll.has(declaredPath)) {
      findings.push({
        rule: 'R4',
        severity: 'blocker',
        code: 'declared_write_not_traced',
        message: `Completion claim declares a write to "${declaredPath}" but the execution trace contains no matching write.`,
        unsubstantiated: true,
        detail: declaredPath,
      });
    }
  }
}

// ─── R5: environment-claim cross-check ──────────────────────────────────

function validateEnvironmentClaims(result: SubAgentResult, findings: ReportFinding[]): void {
  const trace = result.meta?.executionTrace ?? result.meta?.trace;
  const output = result.output ?? '';
  if (!trace || !Array.isArray(trace.commands) || trace.commands.length === 0) return;

  const stdoutNotCapturedRe =
    /(?:stdout|标准输出|命令输出|输出)[^。\n]{0,24}(?:未|没有|无法|not|cannot|wasn't|was not|isn't)[^。\n]{0,12}(?:捕获|captur|记录|看到|查看|见|visible)/i;
  const outputInvisibleRe =
    /(?:stdout|标准输出|命令输出|输出)[^。\n]{0,12}(?:不可见|看不到|无法查看)|(?:不可见|看不到)[^。\n]{0,12}(?:stdout|标准输出|命令输出|输出)/i;
  if ((stdoutNotCapturedRe.test(output) || outputInvisibleRe.test(output)) && trace.commands.some((c) => c.stdout?.trim())) {
    findings.push({
      rule: 'R5',
      severity: 'warning',
      code: 'stdout_claim_conflict',
      message: 'Report claims command output was not captured, but the execution trace contains stdout.',
      detail: trace.commands.find((c) => c.stdout?.trim())?.command?.slice(0, 120),
    });
  }

  const commandFailedRe = /(?:命令|command)[^。\n]{0,24}(?:失败|failed|crashed)|(?:failed|crash)[^。\n]{0,16}(?:command|命令)/i;
  if (commandFailedRe.test(output)) {
    const hasFailure = trace.commands.some((c) => c.exitCode !== 0);
    if (!hasFailure) {
      findings.push({
        rule: 'R5',
        severity: 'warning',
        code: 'command_failure_claim_conflict',
        message: 'Report claims a command failed, but all traced commands exited with code 0.',
        detail: trace.commands.map((c) => `${c.command}:${c.exitCode}`).slice(0, 5).join(', '),
      });
    }
  }
}

// ─── Public API ──────────────────────────────────────────────────────────

/**
 * Deterministically validate one sub-agent completion report.
 *
 * @param result   Sub-agent result (output plus optional `claim`/`meta`).
 * @param required Required sections and controller checkpoints. Also accepts a
 *                 plain `string[]` for convenience.
 * @returns Findings in rule order (R1–R5), each marked blocker or warning.
 */
export function validateReport(
  result: SubAgentResult,
  required?: Requirements,
): ReportFinding[] {
  const findings: ReportFinding[] = [];
  if (!result || typeof result !== 'object') return findings;

  const requirements = normalizeRequirements(required);

  // R1 — required sections.
  for (const section of requirements.sections) {
    if (includesAny(section, CHECKPOINT_ALIASES) && requirements.checkpoints.length > 0) {
      const unanswered = requirements.checkpoints.filter(
        (q) => !isCheckpointAnswered(result.output ?? '', q),
      );
      if (unanswered.length === 0) continue;
      const deflected = DEFLECTION_RE.test(result.output ?? '');
      findings.push({
        rule: 'R1',
        severity: 'blocker',
        code: deflected ? 'checkpoint_deflection' : 'checkpoint_not_answered',
        section,
        message: deflected
          ? `Controller checkpoint is answered with a deflection ("作答见消息开头" is not a checkpoint answer).`
          : `Controller checkpoint question(s) are not answered explicitly: ${unanswered.join(' | ')}`,
        unsubstantiated: true,
        detail: unanswered.join(' | ').slice(0, 240),
      });
      continue;
    }

    if (!sectionSatisfied(section, result, requirements.checkpoints)) {
      findings.push({
        rule: 'R1',
        severity: 'blocker',
        code: 'missing_section',
        section,
        message: `Required report section "${section}" is missing or not claim-backed.`,
        unsubstantiated: true,
      });
    }
  }

  // R2 — numeric claims bind to evidenceLine.
  validateNumericClaims(result, findings);

  // R3 — process obligation citations.
  validateObligationCitations(result, findings);

  // R4/R5 — execution trace cross-checks (only when a trace was supplied).
  validateBoundary(result, findings);
  validateEnvironmentClaims(result, findings);

  return findings;
}

/**
 * Build the bounded follow-up message sent when blocker findings remain.
 * Kept here (pure) so the orchestrator and tests share one rendering.
 */
export function buildReportFollowUpMessage(
  findings: ReportFinding[],
  options: { checkpoints?: string[] } = {},
): string {
  const blockers = findings.filter((f) => f.severity === 'blocker');
  const lines = [
    '[Report integrity gate] Your previous completion report failed deterministic validation.',
    'Rewrite the completion report and satisfy every blocker below; do not restate unsupported counts.',
    '',
  ];

  blockers.forEach((finding, index) => {
    lines.push(`${index + 1}. [${finding.rule}] ${finding.message}`);
    if (finding.detail) lines.push(`   detail: ${finding.detail}`);
  });

  if (options.checkpoints && options.checkpoints.length > 0) {
    lines.push('');
    lines.push('Checkpoint questions that must be answered explicitly in the final report:');
    options.checkpoints.forEach((q, index) => lines.push(`${index + 1}. ${q}`));
  }

  lines.push('');
  lines.push(
    'Required sections: 交付物清单, 命令+退出码, 检查站作答. Every numeric conclusion must cite a verbatim CommandRunClaim.evidenceLine; every process obligation must cite its source (message index / section id).',
  );
  return lines.join('\n');
}
