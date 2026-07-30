// Windows compatibility detection for Unix-style shell commands.
//
// LocalShell executes commands via Node's child_process.exec, which uses
// cmd.exe on Windows. Unix commands either don't exist there (grep, awk, …)
// or resolve to a Windows binary with completely different semantics:
// `find` resolves to C:\Windows\System32\FIND.EXE (a text-search tool), so
// Unix invocations like `find . -name "*.ts"` fail with the confusing
// "FIND: Parameter format not correct" instead of a clear diagnosis.
//
// This module powers two guards in BashTool/RunTool:
// 1. detectUnixFindOnWindows — pre-execution block for Unix `find` syntax
//    (guaranteed to misbehave because FIND.EXE shadows it).
// 2. getWindowsCommandHint — post-failure hint appended to the error message
//    when a known Unix-only command fails (not pre-blocked, because Git for
//    Windows / MSYS may legitimately provide these binaries on PATH).

/** Unix `find` flags that FIND.EXE can never understand. */
const UNIX_FIND_FLAGS =
  /\s-(?:name|iname|type|path|ipath|maxdepth|mindepth|mtime|newer|size|perm|user|exec|delete|print0?|regex)\b/;

/** Leading `find <path>` form (find . / find / / find src …). */
const UNIX_FIND_START = /^find\s+(?:\.|\/|~|"[^"]*"|'[^']*'|[\w.\-\\/]+)/;

/**
 * Detect Unix-style `find` usage that will break on Windows (cmd.exe).
 * Returns an actionable message, or null when the command is fine.
 */
export function detectUnixFindOnWindows(command: string, platform: NodeJS.Platform = process.platform): string | null {
  if (platform !== 'win32') return null;
  const trimmed = command.trim();
  if (!UNIX_FIND_START.test(trimmed) || !UNIX_FIND_FLAGS.test(trimmed)) return null;
  return (
    "Unix 'find' is not available on Windows: cmd.exe resolves `find` to FIND.EXE (a text-search tool), " +
    'so Unix flags like -name/-type fail with "FIND: Parameter format not correct". ' +
    'Use the Glob tool for file-name patterns, the Grep tool for content search, ' +
    'or PowerShell: Get-ChildItem -Recurse -Filter "<pattern>".'
  );
}

/** Unix-only commands with their Windows-native replacements. */
const UNIX_COMMAND_HINTS: Record<string, string> = {
  find: 'use the Glob tool, or PowerShell Get-ChildItem -Recurse -Filter "<pattern>"',
  grep: 'use the Grep tool, or PowerShell Select-String',
  awk: 'use PowerShell ForEach-Object / -split',
  sed: 'use the FileEdit tool, or PowerShell -replace',
  ls: 'use cmd `dir`, or PowerShell Get-ChildItem',
  which: 'use `where` (cmd) or Get-Command (PowerShell)',
  touch: 'use PowerShell New-Item -ItemType File',
  head: 'use PowerShell Get-Content -TotalCount N',
  tail: 'use PowerShell Get-Content -Tail N',
  cat: 'use cmd `type`, the FileRead tool, or PowerShell Get-Content',
  xargs: 'use PowerShell ForEach-Object',
};

/**
 * If a failed command starts with a known Unix-only utility, return a hint
 * for the Windows-native equivalent. Intended to be appended to the error
 * message after a real execution failure ("is not recognized …").
 */
export function getWindowsCommandHint(command: string, platform: NodeJS.Platform = process.platform): string | null {
  if (platform !== 'win32') return null;
  const first = command.trim().split(/\s+/, 1)[0];
  if (!first) return null;
  const hint = UNIX_COMMAND_HINTS[first.toLowerCase()];
  if (!hint) return null;
  return `Hint: '${first}' is a Unix command that may not exist on Windows — ${hint}.`;
}

/** Matches cmd.exe / PowerShell "command not found" stderr signatures. */
export function isCommandNotFoundOutput(output: string): boolean {
  return /is not recognized as an internal or external command|is not recognized as the name of a cmdlet|command not found/i.test(
    output,
  );
}
