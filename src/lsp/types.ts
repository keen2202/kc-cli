// LSP Type Definitions

export interface LSPPosition {
  line: number;
  character: number;
}

export interface LSPRange {
  start: LSPPosition;
  end: LSPPosition;
}

export interface LSPLocation {
  uri: string;
  range: LSPRange;
}

export interface LSPDiagnostic {
  range: LSPRange;
  severity: 1 | 2 | 3 | 4; // Error, Warning, Info, Hint
  message: string;
  source?: string;
  code?: string | number;
}

export interface LSPHover {
  contents: string | { value: string };
  range?: LSPRange;
}

export type LanguageId = 'typescript' | 'javascript' | 'go' | 'python' | 'rust' | 'unknown';
