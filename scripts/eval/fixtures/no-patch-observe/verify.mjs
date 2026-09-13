// no-patch 任务：期望不存在 marker 文件（mock 不产 patch 时不跑本命令）
import { existsSync } from 'node:fs';

if (existsSync('marker.txt')) {
  console.error('marker.txt should not exist');
  process.exit(1);
}
console.log('ok');
