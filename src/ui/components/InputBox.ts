import chalk from 'chalk';
import type { Theme } from '../theme';

export interface InputState {
  text: string;
  cursorPos: number;
  historyIndex: number;
  /** When true, the input is sent as a steer message instead of a new turn */
  steerMode?: boolean;
}

export function renderInputBox(state: InputState, prompt: string = 'kc>', theme?: Theme): string {
  const tokens = theme?.resolve();
  const prefix = state.steerMode
    ? (tokens ? tokens['input.steer']('steer> ') : chalk.yellow.bold('steer> '))
    : (tokens ? tokens['input.prompt'](`${prompt} `) : chalk.cyan.bold(`${prompt} `));
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
