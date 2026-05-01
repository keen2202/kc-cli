import chalk from 'chalk';

export interface InputState {
  text: string;
  cursorPos: number;
  historyIndex: number;
}

export function renderInputBox(state: InputState, prompt: string = 'kc>'): string {
  return chalk.cyan.bold(`${prompt} `) + state.text + chalk.gray('█');
}

export function createInputState(): InputState {
  return { text: '', cursorPos: 0, historyIndex: -1 };
}
