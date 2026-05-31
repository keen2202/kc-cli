import chalk from 'chalk';

export interface InputState {
  text: string;
  cursorPos: number;
  historyIndex: number;
  /** When true, the input is sent as a steer message instead of a new turn */
  steerMode?: boolean;
}

export function renderInputBox(state: InputState, prompt: string = 'kc>'): string {
  const prefix = state.steerMode
    ? chalk.yellow.bold('steer> ')
    : chalk.cyan.bold(`${prompt} `);
  return prefix + state.text + chalk.gray('█');
}

export function createInputState(): InputState {
  return { text: '', cursorPos: 0, historyIndex: -1, steerMode: false };
}

/**
 * Toggle steer mode on an input state.
 * When steer mode is active, submitted input is sent as a steer message
 * instead of starting a new conversation turn.
 */
export function toggleSteerMode(state: InputState): InputState {
  return { ...state, steerMode: !state.steerMode };
}
