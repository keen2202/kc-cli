// held-out：校验 farewell.txt
import { existsSync, readFileSync } from 'node:fs';

const expected = 'Farewell from held-out\n';
if (!existsSync('farewell.txt')) {
  console.error('missing farewell.txt');
  process.exit(1);
}
const actual = readFileSync('farewell.txt', 'utf8');
if (actual !== expected) {
  console.error(`expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  process.exit(1);
}
console.log('ok');
