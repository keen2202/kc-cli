import chalk from 'chalk';

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠗', '⠏'];

export class Spinner {
  private interval: ReturnType<typeof setInterval> | null = null;
  private frameIndex = 0;
  private startTime = 0;
  private text = '';

  start(text: string): void {
    this.text = text;
    this.startTime = Date.now();
    this.frameIndex = 0;

    if (!process.stdout.isTTY) {
      process.stdout.write(`${text}...`);
      return;
    }

    this.interval = setInterval(() => {
      const frame = FRAMES[this.frameIndex % FRAMES.length];
      const elapsed = ((Date.now() - this.startTime) / 1000).toFixed(1);
      process.stdout.write(`\r${chalk.cyan(frame)} ${this.text} ${chalk.gray(`${elapsed}s`)}`);
      this.frameIndex++;
    }, 80);
  }

  stop(finalText?: string): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }

    if (!process.stdout.isTTY) {
      if (finalText) process.stdout.write(` ${finalText}\n`);
      return;
    }

    const elapsed = ((Date.now() - this.startTime) / 1000).toFixed(1);
    const text = finalText || this.text;
    process.stdout.write(`\r${chalk.green('✓')} ${text} ${chalk.gray(`${elapsed}s`)}\n`);
  }

  fail(errorText?: string): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }

    const elapsed = ((Date.now() - this.startTime) / 1000).toFixed(1);
    const text = errorText || this.text;
    process.stdout.write(`\r${chalk.red('✗')} ${text} ${chalk.gray(`${elapsed}s`)}\n`);
  }
}
