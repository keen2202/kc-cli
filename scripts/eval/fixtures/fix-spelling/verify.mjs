// held-out：校验 draft.txt 拼写已修正
import { existsSync, readFileSync } from 'node:fs';

if (!existsSync('draft.txt')) {
  console.error('missing draft.txt');
  process.exit(1);
}
const text = readFileSync('draft.txt', 'utf8');
if (text.includes('recieve')) {
  console.error('misspelling "recieve" still present');
  process.exit(1);
}
if (!text.includes('receive')) {
  console.error('correct spelling missing');
  process.exit(1);
}
console.log('ok');
