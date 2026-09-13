// 校验 greeting.txt 内容是否与任务期望一致
import { existsSync, readFileSync } from 'node:fs';

const expected = 'Hello from held-in\n';
if (!existsSync('greeting.txt')) {
  console.error('missing greeting.txt');
  process.exit(1);
}
const actual = readFileSync('greeting.txt', 'utf8');
if (actual !== expected) {
  console.error(`expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  process.exit(1);
}
console.log('ok');
