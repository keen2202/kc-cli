// Startup performance tracking

interface ProfileCheckpoint {
  name: string;
  timestamp: number;
  delta: number;
}

let checkpoints: ProfileCheckpoint[] = [];
let startTime: number | null = null;

export function profileCheckpoint(name: string): void {
  const now = performance.now();

  if (!startTime) {
    startTime = now;
    checkpoints = [];
  }

  const lastCheckpoint = checkpoints.length > 0
    ? checkpoints[checkpoints.length - 1]!.timestamp
    : startTime;

  checkpoints.push({
    name,
    timestamp: now,
    delta: now - lastCheckpoint,
  });
}

export function getProfileReport(): string {
  if (!startTime || checkpoints.length === 0) {
    return 'No profile data';
  }

  const totalTime = checkpoints[checkpoints.length - 1]!.timestamp - startTime;

  const lines = [
    'Performance Profile:',
    '─'.repeat(50),
  ];

  for (const checkpoint of checkpoints) {
    const paddedName = checkpoint.name.padEnd(30);
    const delta = checkpoint.delta.toFixed(2).padStart(8);
    lines.push(`${paddedName} ${delta}ms`);
  }

  lines.push('─'.repeat(50));
  lines.push(`Total: ${totalTime.toFixed(2)}ms`.padStart(39));

  return lines.join('\n');
}

export function resetProfile(): void {
  startTime = null;
  checkpoints = [];
}
