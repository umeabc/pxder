'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { scanLibrary, parseManifest, MAX_BYTES } = require('./library');

async function main() {
  const [, , directory, output = 'pxder-library.json', extra] = process.argv;
  if (directory === '--help' || !directory || extra) {
    console.log('用法：node web/export-library.js "旧图目录" [pxder-library.json]');
    if (directory !== '--help') process.exitCode = 1;
    return;
  }
  const { manifest, scanned, skipped } = await scanLibrary(directory);
  const data = JSON.stringify(parseManifest(manifest)) + '\n';
  if (Buffer.byteLength(data) > MAX_BYTES) throw new Error('索引超过 32 MiB，请拆分目录导出。');
  await fs.writeFile(output, data, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  console.log(`已写入 ${path.resolve(output)}：${manifest.assets.length} 条记录，${manifest.artists.length} 个画师目录；检查 ${scanned} 个文件，忽略 ${skipped} 个。`);
}

main().catch(error => {
  const messages = { EEXIST: '输出文件已存在。请换一个文件名，现有文件未覆盖。', ENOENT: '找不到指定目录，请检查路径。', EACCES: '没有读写指定路径的权限。' };
  console.error(messages[error.code] || error.message);
  process.exitCode = 1;
});
