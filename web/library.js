'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

const FORMAT = 'pxder-library-v1';
const MAX_ASSETS = 500_000;
const MAX_BYTES = 32 * 1024 * 1024;
const MAX_PAGE = 9_999;
const ID = /^[1-9][0-9]{0,14}$/;
const IMAGE_EXT = /^(?:jpe?g|png|gif|webp|bmp|avif)$/i;

function assetKey([pid, kind, page]) {
  return `${pid}:${kind}:${page}`;
}

function fileAsset(name) {
  const ext = path.extname(name).slice(1).toLowerCase();
  const stem = name.slice(0, -(ext.length + 1));
  const old = /^\(([1-9]\d{0,14})\)(.*)$/su.exec(stem);
  if (old) {
    if (ext === 'zip' || (/^(?:gif|mp4|webm)$/.test(ext) && /(?:@\d+ms|_ugoira)$/i.test(old[2]))) {
      return [old[1], 'ugoira', 0];
    }
    if (!IMAGE_EXT.test(ext)) return null;
    const page = /_p(\d+)$/i.exec(old[2]);
    const index = page ? Number(page[1]) : 0;
    return index <= MAX_PAGE ? [old[1], 'image', index] : null;
  }
  const zip = /^([1-9]\d{0,14})_ugoira(?:\d+x\d+)?$/i.exec(stem);
  if (zip && /^(?:zip|gif|mp4|webm)$/.test(ext)) return [zip[1], 'ugoira', 0];
  const raw = /^([1-9]\d{0,14})_p(\d+)$/i.exec(stem);
  if (IMAGE_EXT.test(ext) && raw && Number(raw[2]) <= MAX_PAGE) return [raw[1], 'image', Number(raw[2])];
  return null;
}

async function scanLibrary(root, { signal, progress = () => {} } = {}) {
  const absolute = await fs.realpath(root);
  const assets = new Map();
  const artists = new Set();
  const queue = [[absolute, true]];
  let scanned = 0;
  let skipped = 0;
  const report = () => progress({ scanned, skipped, count: assets.size });
  while (queue.length) {
    signal?.throwIfAborted();
    const [dir, top] = queue.pop();
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (let offset = 0; offset < entries.length; offset += 64) {
      signal?.throwIfAborted();
      // Limit concurrent stats. Paths and file names never leave this process.
      await Promise.all(entries.slice(offset, offset + 64).map(async entry => {
        if (entry.name.startsWith('.') || entry.isSymbolicLink()) return;
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          const artist = top ? /^\(([1-9]\d{0,14})\)/.exec(entry.name) : null;
          if (artist) artists.add(artist[1]);
          queue.push([file, false]);
        } else if (entry.isFile()) {
          scanned++;
          const asset = fileAsset(entry.name);
          if (asset) {
            let info;
            try { info = await fs.lstat(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
            if (info?.isFile() && info.size > 0 && !assets.has(assetKey(asset))) {
              assets.set(assetKey(asset), asset);
              if (assets.size > MAX_ASSETS) throw new Error('扫描超过 50 万条，请将旧库拆成几个目录导出。');
              return;
            }
          }
          skipped++;
        }
      }));
      report();
    }
  }
  report();
  const sorted = [...assets.values()].sort(compareAsset);
  return { manifest: { format: FORMAT, assets: sorted, artists: [...artists].sort() }, scanned, skipped };
}

function compareAsset(a, b) {
  return (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0) || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0) || (a[2] - b[2]);
}

function parseManifest(input) {
  if (input?.format !== FORMAT || !Array.isArray(input.assets) || !input.assets.length) {
    throw new Error('需要由 pxder 导出的有效 JSON 索引（至少一条记录）。');
  }
  if (input.assets.length > MAX_ASSETS) throw new Error('索引超过 50 万条，请拆分后导入。');
  const assets = new Map();
  for (const item of input.assets) {
    if (!Array.isArray(item) || item.length !== 3 || typeof item[0] !== 'string' || !ID.test(item[0]) || !['image', 'ugoira'].includes(item[1]) ||
      !Number.isInteger(item[2]) || item[2] < 0 || item[2] > MAX_PAGE || (item[1] === 'ugoira' && item[2] !== 0)) {
      throw new Error('索引包含无效的作品 ID、媒体类型或页码。');
    }
    assets.set(assetKey(item), item);
  }
  const artists = input.artists ?? [];
  if (!Array.isArray(artists) || artists.length > MAX_ASSETS || artists.some(id => typeof id !== 'string' || !ID.test(id))) {
    throw new Error('索引包含无效的画师 ID。');
  }
  return { format: FORMAT, assets: [...assets.values()].sort(compareAsset), artists: [...new Set(artists)].sort() };
}

module.exports = { FORMAT, ID, IMAGE_EXT, MAX_PAGE, MAX_BYTES, MAX_ASSETS, assetKey, fileAsset, scanLibrary, parseManifest };
