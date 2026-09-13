// 校验 notes.txt 中的 typo 已修复
import { existsSync, readFileSync } from 'node:fs';

if (!existsSync('notes.txt')) {
  console.error('missing notes.txt');
  process.exit(1);
}
const text = readFileSync('notes.txt', 'utf8');
if (text.includes('teh ')) {
  console.error('typo "teh " still present');
  process.exit(1);
}
if (!text.includes('the quick brown fox')) {
  console.error('fixed phrase missing');
  process.exit(1);
}
console.log('ok');
