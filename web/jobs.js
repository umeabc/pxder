'use strict';

const { ID, assetKey, scanLibrary, MAX_ASSETS } = require('./library');
const { Destinations, workAssets, downloadAsset } = require('./assets');
const { PixivError } = require('./pixiv');
const { initialCounts } = require('./store');

const TYPES = new Set(['pid', 'uid', 'bookmark', 'follow', 'update']);
const MAX_QUEUE_SIZE = 32;

class RequestError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function idFromInput(input, type) {
  if (ID.test(input)) return input;
  let url;
  try { url = new URL(input); } catch { return null; }
  if (!['https:', 'http:'].includes(url.protocol) || !['www.pixiv.net', 'pixiv.net'].includes(url.hostname) || url.username || url.password || url.port) return null;
  const modern = type === 'pid' ? '(artworks|i)' : '(users|u)';
  const match = new RegExp(`^/(?:[a-z]{2}(?:-[a-z]{2})?/)?${modern}/(\\d+)/?$`, 'i').exec(url.pathname);
  const legacyPath = type === 'pid' ? '/member_illust.php' : '/member.php';
  const id = match?.[2] ?? (url.pathname === legacyPath ? url.searchParams.get(type === 'pid' ? 'illust_id' : 'id') : '');
  return id && ID.test(id) ? id : null;
}

function parseJob(body) {
  if (!TYPES.has(body?.type)) throw new RequestError(400, '请选择下载类型。');
  const { type, scope, values, dryRun } = body;
  let ids = [];
  if (type === 'pid' || type === 'uid') {
    if (typeof values !== 'string' || values.length > 20_000) throw new RequestError(400, '请输入作品或画师 ID。');
    const parts = values.trim().split(/[\s,，、;；]+/u).filter(Boolean);
    if (!parts.length || parts.length > 100) throw new RequestError(400, '每个任务请输入 1 到 100 个 ID 或链接。');
    ids = [...new Set(parts.map(part => idFromInput(part, type)))];
    if (ids.includes(null)) throw new RequestError(400, type === 'pid' ? '只接受作品 PID 或 Pixiv 作品链接。' : '只接受画师 UID 或 Pixiv 画师链接。');
  }
  const visibility = type === 'bookmark' || type === 'follow' ? (scope ?? 'public') : null;
  if (visibility !== null && visibility !== 'public' && visibility !== 'private') throw new RequestError(400, '请选择公开或私密。');
  if (dryRun !== undefined && typeof dryRun !== 'boolean') throw new RequestError(400, '筛选模式无效。');
  return { type, ids, scope: visibility, dryRun: dryRun === true };
}

async function* collect(pixiv, spec, artists, signal) {
  if (spec.type === 'pid') {
    for (const pid of spec.ids) {
      try { yield { illust: (await pixiv.get('/v1/illust/detail', { illust_id: pid }, signal)).illust }; }
      catch (error) { signal.throwIfAborted(); yield { error, label: `作品 ${pid}` }; }
    }
    return;
  }
  const auth = await pixiv.authorize(signal);
  if (['bookmark', 'follow'].includes(spec.type) && !ID.test(auth.userId)) throw new PixivError('无法读取 Pixiv 账号 ID。', { stop: true });
  if (spec.type === 'bookmark') {
    for await (const illust of pixiv.pages('/v1/user/bookmarks/illust', { user_id: auth.userId, restrict: spec.scope }, 'illusts', signal)) yield { illust };
    return;
  }
  const ids = spec.type === 'uid' ? spec.ids : artists;
  async function* authorIds() {
    if (spec.type !== 'follow') { yield* ids; return; }
    for await (const item of pixiv.pages('/v1/user/following', { user_id: auth.userId, restrict: spec.scope }, 'user_previews', signal)) {
      const id = String(item?.user?.id);
      if (ID.test(id) && id !== '11') yield id;
    }
  }
  const seen = new Set();
  for await (const uid of authorIds()) {
    if (seen.has(uid)) continue;
    if (seen.size >= 10_000) throw new PixivError('任务画师过多，请拆分后重试。', { stop: true });
    seen.add(uid);
    try {
      for await (const illust of pixiv.pages('/v1/user/illusts', { user_id: uid, type: 'illust' }, 'illusts', signal)) yield { illust };
    } catch (error) { signal.throwIfAborted(); yield { error, label: `画师 ${uid}` }; }
  }
}

function describe(error) {
  if (error instanceof PixivError) return error.message;
  if (['ENOENT', 'EACCES', 'EPERM', 'ENOTDIR'].includes(error?.code)) return '无法访问服务器目录，请检查挂载和文件权限。';
  return '任务未完成，请检查服务器配置后重试。';
}

class JobRunner {
  constructor({ store, pixiv, downloads, library, configured }) {
    Object.assign(this, { store, pixiv, downloads, library, configured });
    this.store.recoverJobs();
    this.kick();
  }

  enqueue(spec) {
    if (this.closing) throw new RequestError(503, '服务器正在停止。');
    const { queued } = this.store.queueCounts();
    if (queued >= MAX_QUEUE_SIZE) throw new RequestError(409, '待处理队列已满，请稍后再试。');
    if (spec.type === 'scan') {
      if (!this.library) throw new RequestError(409, '请先在服务器上配置旧目录挂载。');
      if (this.store.jobs().some(job => job.type === 'scan' && ['queued', 'running'].includes(job.status))) throw new RequestError(409, '已有旧目录扫描任务。');
    } else if (!this.configured()) throw new RequestError(409, '请先配置 Pixiv Refresh Token。');
    const job = this.store.addJob(spec);
    this.kick();
    return job;
  }

  cancel(job) {
    if (job.status === 'queued') {
      this.store.updateJob(job.id, 'cancelled', initialCounts(), '任务已取消。');
    } else if (job.status === 'running' && this.active?.id === job.id) {
      this.active.controller.abort();
    } else throw new RequestError(409, '该任务已结束，无需取消。');
    return this.store.job(job.id);
  }

  kick() {
    if (this.scheduled || this.active || this.closing) return;
    this.scheduled = true;
    setImmediate(() => {
      this.scheduled = false;
      if (this.closing) return;
      const job = this.store.next();
      if (!job) return;
      const controller = new AbortController();
      const promise = this.execute(job, controller.signal).catch(() => {
        console.error('[pxder] Could not persist job state.');
      }).finally(() => { this.active = null; this.kick(); });
      this.active = { id: job.id, controller, promise };
    });
  }

  async execute(job, signal) {
    const counts = initialCounts();
    let message = null;
    let last = 0;
    const write = (status = 'running') => this.store.updateJob(job.id, status, counts, message);
    const checkpoint = () => {
      const now = Date.now();
      if (now - last < 400) return;
      last = now;
      write();
    };
    write();
    try {
      if (job.type === 'scan') {
        const { manifest, scanned, skipped } = await scanLibrary(this.library, { signal, progress: info => {
          counts.total = info.scanned;
          counts.skipped = info.skipped;
          message = `已识别 ${info.count} 条记录，正在扫描旧目录。`;
          checkpoint();
        } });
        signal.throwIfAborted();
        counts.total = scanned;
        counts.skipped = skipped;
        this.store.replaceSource('mounted', '服务器旧图目录', 'scan', manifest);
        message = `已收录 ${manifest.assets.length} 条记录。未搬动任何图片。`;
        write('completed');
        return;
      }
      const destination = new Destinations(this.downloads);
      const groups = await destination.groups();
      const artists = [...new Set([...groups, ...this.store.artistIds()])];
      if (job.type === 'update' && !artists.length) throw new PixivError('暂无画师目录。请先按 UID 下载，或导入带画师目录的旧图库索引。');
      const seen = new Set();
      const fail = (error, label) => {
        signal.throwIfAborted();
        counts.failed++;
        message = `${label}：${describe(error)}`;
        checkpoint();
      };
      for await (const { illust, error, label } of collect(this.pixiv, job, artists, signal)) {
        signal.throwIfAborted();
        if (error) {
          counts.total++;
          fail(error, label);
          if (error.stop) break;
          continue;
        }
        let files;
        let group;
        try { files = workAssets(illust); group = destination.group(job, illust); }
        catch (error) { counts.total++; fail(error, '无法识别作品'); continue; }
        for (const file of files) {
          signal.throwIfAborted();
          const key = assetKey(file.key);
          if (seen.has(key)) continue;
          if (seen.size >= MAX_ASSETS) throw new PixivError('任务超过 50 万个文件，请拆分后重试。', { stop: true });
          seen.add(key);
          counts.total++;
          try {
            if (this.store.archived(file.key)) counts.skipped++;
            else {
              const target = await destination.locate(group, file.name);
              const existing = this.store.downloaded(file.key);
              const found = await destination.existing(existing) ? existing : (await destination.existing(target.relative) ? target.relative : null);
              if (found) {
                counts.skipped++;
                if (!job.dryRun) this.store.markDownloaded(file.key, found);
              } else if (job.dryRun) counts.missing++;
              else {
                const result = await downloadAsset(this.pixiv, file, await destination.locate(group, file.name, true), signal);
                this.store.markDownloaded(file.key, target.relative);
                if (result) counts.downloaded++; else counts.skipped++;
              }
            }
          } catch (error) {
            fail(error, `作品 ${file.key[0]}`);
            if (error.stop) {
              write(counts.downloaded || counts.skipped || counts.missing ? 'partial' : 'failed');
              return;
            }
          }
          checkpoint();
        }
      }
      const working = counts.downloaded || counts.skipped || counts.missing;
      if (!counts.total) message = '没有找到符合条件的作品。';
      write(counts.failed ? (working ? 'partial' : 'failed') : 'completed');
    } catch (error) {
      if (signal.aborted) {
        message = this.closing ? '服务器停止，重启后将自动继续。' : '任务已取消，已写入的文件仍然保留。';
        write(this.closing ? 'queued' : 'cancelled');
      } else {
        message = describe(error);
        counts.failed++;
        counts.total++;
        write(counts.downloaded || counts.skipped || counts.missing ? 'partial' : 'failed');
      }
    }
  }

  async close() {
    this.closing = true;
    this.active?.controller.abort();
    await this.active?.promise;
  }
}

module.exports = { RequestError, JobRunner, idFromInput, parseJob };
