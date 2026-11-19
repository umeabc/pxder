'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { createWriteStream } = require('node:fs');
const { pipeline } = require('node:stream/promises');
const { randomUUID } = require('node:crypto');
const { PixivError, cdnUrl, retry } = require('./pixiv');
const { ID, IMAGE_EXT, MAX_PAGE } = require('./library');

const FILE_LIMIT = 256 * 1024 * 1024;

function filenamePart(value, bytes = 160) {
  const safe = String(value ?? '').replace(/[\x00-\x1f\x7f/\\:*?"<>|.&$\u202a-\u202e\u2066-\u2069]/gu, '');
  let result = '';
  let length = 0;
  for (const char of safe) {
    length += Buffer.byteLength(char);
    if (length > bytes) break;
    result += char;
  }
  return result.trimEnd();
}

function workAssets(illust) {
  const pid = String(illust?.id);
  if (!ID.test(pid)) throw new PixivError('Pixiv 未返回有效的作品 ID。');
  const title = filenamePart(illust.title);
  const single = illust.meta_single_page?.original_image_url;
  if (illust.type === 'ugoira') {
    let best;
    if (single) {
      const url = cdnUrl(single);
      best = url.pathname.startsWith('/img-original/') && new RegExp(`/${pid}_ugoira0\\.[a-z]+$`, 'i').test(url.pathname)
        ? url.href.replace('/img-original/', '/img-zip-ugoira/').replace(/_ugoira0\.[a-z]+(?=\?|$)/i, '_ugoira1920x1080.zip') : null;
    }
    return [{ key: [pid, 'ugoira', 0], name: `(${pid})${title}.zip`, url: best }];
  }
  const pages = Array.isArray(illust.meta_pages) ? illust.meta_pages : [];
  const urls = pages.length ? pages.map(page => page?.image_urls?.original) : [single];
  if (urls.length > MAX_PAGE + 1 || (Number(illust.page_count) > 0 && urls.length !== Number(illust.page_count))) {
    throw new PixivError('该作品的原图页数不完整。');
  }
  return urls.map((url, index) => {
    const parsed = cdnUrl(url);
    const extension = path.posix.extname(parsed.pathname).slice(1).toLowerCase();
    if (!IMAGE_EXT.test(extension) || !parsed.pathname.startsWith('/img-original/') || !new RegExp(`/${pid}_p${index}\\.${extension}$`, 'i').test(parsed.pathname)) {
      throw new PixivError('该作品的原图地址与作品页码不匹配。');
    }
    return { key: [pid, 'image', index], name: `(${pid})${title}${pages.length > 1 ? `_p${index}` : ''}.${extension}`, url: parsed.href };
  });
}

async function fileInfo(file) {
  try { return await fs.lstat(file); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function nonemptyFile(file) {
  const info = await fileInfo(file);
  return Boolean(info?.isFile() && info.size > 0);
}

class Destinations {
  constructor(root) { this.root = root; this.artists = new Map(); }

  async groups() {
    const entries = await fs.readdir(this.root, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const match = /^\(([1-9]\d{0,14})\)/.exec(entry.name);
      if (match && !this.artists.has(match[1])) this.artists.set(match[1], entry.name);
    }
    return [...this.artists.keys()];
  }

  group(spec, illust) {
    if (spec.type === 'pid') return 'PID';
    if (spec.type === 'bookmark') return spec.scope === 'private' ? '[bookmark] Private' : '[bookmark] Public';
    const uid = String(illust.user?.id);
    if (!ID.test(uid)) throw new PixivError('Pixiv 未返回该作品的画师 ID。');
    if (!this.artists.has(uid)) this.artists.set(uid, `(${uid})${filenamePart(String(illust.user?.name ?? '').split(/[@＠]/, 1)[0], 120)}`);
    return this.artists.get(uid);
  }

  async locate(group, name, create = false) {
    if (group === '.' || group === '..' || name === '.' || name === '..' || /[/\\]/.test(group) || /[/\\]/.test(name)) throw new Error('Invalid destination path');
    const folder = path.join(this.root, group);
    if (create) await fs.mkdir(folder, { mode: 0o750 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
    const info = await fileInfo(folder);
    if (info && !info.isDirectory()) throw new PixivError('下载目录不是普通目录，请检查服务器配置。', { stop: true });
    return { file: path.join(folder, name), relative: `${group}/${name}`, folder };
  }

  async existing(relative) {
    if (typeof relative !== 'string') return false;
    const parts = relative.split('/');
    if (parts.length !== 2 || !parts.every(Boolean)) return false;
    return nonemptyFile((await this.locate(...parts)).file);
  }
}

function wrapDisk(error) {
  if (error instanceof PixivError) return error;
  if (['ENOSPC', 'EDQUOT', 'EACCES', 'EPERM', 'EROFS', 'ENOTDIR', 'EXDEV', 'ENAMETOOLONG'].includes(error.code)) {
    return new PixivError('无法写入下载目录，请检查权限、文件系统和剩余空间。', { stop: true });
  }
  return new PixivError('下载不完整或连接中断。', { transient: true });
}

async function downloadOnce(pixiv, url, key, destination, signal) {
  const original = cdnUrl(url);
  if (key[1] === 'ugoira' && !new RegExp(`/${key[0]}_ugoira[0-9]+x[0-9]+\\.zip$`, 'i').test(original.pathname)) {
    throw new PixivError('Pixiv 未返回可用的动图压缩包。');
  }
  const { response, signal: transfer } = await pixiv.asset(original, signal);
  const type = response.headers.get('content-type')?.split(';')[0].toLowerCase();
  const encoded = response.headers.get('content-encoding');
  const length = encoded && encoded !== 'identity' ? null : response.headers.get('content-length');
  const accepts = key[1] === 'image' ? type?.startsWith('image/') : /^(?:application\/(?:zip|octet-stream|x-zip-compressed))$/.test(type ?? '');
  if (!accepts || !response.body || (length !== null && (Number(length) <= 0 || Number(length) > FILE_LIMIT))) {
    await response.body?.destroy?.();
    throw new PixivError('Pixiv 返回的文件类型或大小不符合预期。');
  }
  const temp = path.join(destination.folder, `.pxder-${randomUUID()}.part`);
  let bytes = 0;
  try {
    await pipeline(response.body, async function* (source) {
      for await (const chunk of source) {
        bytes += chunk.byteLength;
        if (bytes > FILE_LIMIT) throw new PixivError('文件超过 256 MiB 的下载上限。');
        yield chunk;
      }
    }, createWriteStream(temp, { flags: 'wx', mode: 0o640 }), { signal: transfer });
    if (bytes === 0 || (length !== null && Number(length) !== bytes)) throw new PixivError('文件未下载完整。', { transient: true });
    signal?.throwIfAborted();
    try { await fs.link(temp, destination.file); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (await nonemptyFile(destination.file)) return false;
      throw new PixivError('同名文件不可用或为零字节，请检查下载目录。');
    }
    return true;
  } catch (error) {
    signal?.throwIfAborted();
    throw wrapDisk(error);
  } finally {
    await fs.unlink(temp).catch(() => {});
  }
}

async function downloadAsset(pixiv, asset, destination, signal) {
  const { url, key } = asset;
  if (url) {
    try { return await retry(() => downloadOnce(pixiv, url, key, destination, signal), signal); }
    catch (error) { if (key[1] !== 'ugoira' || ![403, 404].includes(error.status)) throw error; }
  }
  if (key[1] !== 'ugoira') throw new PixivError('该作品没有可用的原图。');
  const metadata = await pixiv.get('/v1/ugoira/metadata', { illust_id: key[0] }, signal);
  const fallback = metadata?.ugoira_metadata?.zip_urls?.medium;
  return retry(() => downloadOnce(pixiv, fallback, key, destination, signal), signal);
}

module.exports = { workAssets, Destinations, downloadAsset };
