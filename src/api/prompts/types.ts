// Prompt template types for provider-specific system prompts

export type TaskType = 'code-gen' | 'debugging' | 'refactoring' | 'documentation' | 'creative' | 'general';

export interface PromptTemplate {
  /** Base system prompt for this provider */
  system: string;
  /** Tool use instructions */
  toolUse: string;
  /** Code generation instructions */
  codeGen: string;
  /** Debugging instructions */
  debugging: string;
  /** Refactoring instructions */
  refactoring: string;
  /** Documentation instructions */
  documentation: string;
  /** Reasoning instructions */
  reasoning: string;
  /** Planning phase instructions (3-phase workflow) */
  planning?: string;
  /** Build/test command hints for language-specific projects */
  build?: string;
}
