import { createProgram, type CLIDelegates } from './cli-config';
import { initLogLevel, runAgent, type RunAgentOptions } from './init-sequence';

export { VERSION } from './cli-config';
export { initLogLevel, runAgent, buildSystemPrompt } from './init-sequence';

export async function main(
  modeHandlers: Pick<RunAgentOptions, 'onInteractiveUI' | 'onRunREPL' | 'onExecutePrompt' | 'onRunJSONMode'> & {
    onShowConfig: () => Promise<void>;
    onListTools: () => Promise<void>;
  },
): Promise<void> {
  initLogLevel();

  const delegates: CLIDelegates = {
    onRunAgent: (prompt, opts) => runAgent({ ...modeHandlers, prompt, opts }),
    onShowConfig: modeHandlers.onShowConfig,
    onListTools: modeHandlers.onListTools,
  };

  const program = createProgram(delegates);
  await program.parseAsync(process.argv);
}
