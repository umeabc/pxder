'use strict';

const fs = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const { createApp } = require('../server');

const PASSWORD = 'fake-test-password-not-for-deployment';
const TOKEN = 'fake-refresh-token-not-for-deployment';
const imageUrl = (pid, page) => `https://i.pximg.net/img-original/img/2024/01/01/00/00/00/${pid}_p${page}.jpg`;
const media = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);

function reply(status, payload, headers = {}) {
  const body = payload === undefined ? Buffer.alloc(0) : Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload));
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: name => headers[String(name).toLowerCase()] ?? (payload === undefined ? null : 'application/json') },
    body: Readable.from(body.length ? [body] : []),
    bytes: body,
  };
}

function illust(id, count = 1, uid = 88, pinned = false) {
  return {
    id, title: id === 42 ? '雨中邮局' : '树影', type: 'illust', page_count: count, is_pinned: pinned, user: { id: uid, name: '示例画师' },
    meta_pages: count > 1 ? Array.from({ length: count }, (_, i) => ({ image_urls: { original: imageUrl(id, i) } })) : [],
    meta_single_page: count === 1 ? { original_image_url: imageUrl(id, 0) } : {},
  };
}

async function fixture({ port = 0, withToken = false, artistFeed, assetStatus } = {}) {
  const parent = path.resolve(tmpdir());
  const root = await fs.mkdtemp(path.join(parent, 'pxder-test-'));
  const downloads = path.join(root, 'downloads');
  const legacy = path.join(root, 'old');
  const artist = path.join(legacy, '(88)示例画师');
  const data = path.join(root, 'data');
  await fs.mkdir(artist, { recursive: true });
  await fs.writeFile(path.join(artist, '(42)雨中邮局_p0.jpg'), media);
  await fs.writeFile(path.join(artist, '(57)空文件_p1.png'), '');
  await fs.writeFile(path.join(artist, '(77)动图@90ms.zip'), 'zip');
  await fs.writeFile(path.join(artist, '(57)动画_p0.gif'), 'gif');
  await fs.writeFile(path.join(artist, '43_p0.jpg.part'), media);
  const calls = [];
  const transport = async (input, options = {}) => {
    options.signal?.throwIfAborted();
    const url = new URL(input);
    calls.push({ host: url.hostname, path: url.pathname, query: url.search, auth: options.headers?.Authorization });
    if (url.hostname === 'oauth.secure.pixiv.net') {
      if (new URLSearchParams(options.body ?? '').get('refresh_token') !== TOKEN) return reply(400, { error: 'bad token' });
      return reply(200, { response: { refresh_token: TOKEN, access_token: 'fake-access-token', user: { id: 99 }, expires_in: 3600 } });
    }
    if (url.hostname === 'i.pximg.net') {
      const status = assetStatus?.(url);
      if (status && status !== 200) return reply(status, '');
      return {
        status: 200,
        ok: true,
        headers: { get: name => ({ 'content-type': 'image/jpeg', 'content-length': String(media.length) })[name] ?? null },
        body: Readable.from([media]),
      };
    }
    if (url.hostname !== 'app-api.pixiv.net' || options.headers.Authorization !== 'Bearer fake-access-token') return reply(401, '');
    if (url.pathname === '/v1/illust/detail') {
      const pid = Number(url.searchParams.get('illust_id'));
      if (pid === 420) {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, 1500);
          options.signal.addEventListener('abort', () => { clearTimeout(timer); reject(options.signal.reason); }, { once: true });
        });
      }
      return reply(200, { illust: illust(pid, pid === 42 ? 2 : 1) });
    }
    if (url.pathname === '/v1/user/bookmarks/illust') {
      return url.searchParams.has('offset') ? reply(200, { illusts: [illust(43)], next_url: null }) :
        reply(200, { illusts: [illust(42, 2)], next_url: 'https://app-api.pixiv.net/v1/user/bookmarks/illust?offset=30' });
    }
    if (url.pathname === '/v1/user/illusts') {
      const uid = Number(url.searchParams.get('user_id'));
      const offset = Number(url.searchParams.get('offset'));
      const feed = artistFeed?.(uid, offset) || { illusts: [illust(42, 2)], next_url: null };
      return reply(200, feed);
    }
    if (url.pathname === '/v1/user/following') return reply(200, { user_previews: [{ user: { id: 88 } }], next_url: null });
    if (url.pathname === '/' && options.method === 'HEAD') return reply(404, undefined);
    return reply(404, '');
  };
  const open = async (listenPort, tokenFlag) => {
    const app = await createApp({
      password: PASSWORD, dataDir: data, downloadDir: downloads, libraryDir: legacy,
      pixivTransport: transport, pixivToken: tokenFlag ? TOKEN : undefined,
    });
    await new Promise(resolve => app.server.listen(listenPort, '127.0.0.1', resolve));
    return { ...app, origin: `http://127.0.0.1:${app.server.address().port}` };
  };
  const app = await open(port, withToken);
  const clean = async () => {
    if (path.dirname(root) !== parent || !path.basename(root).startsWith('pxder-test-')) throw new Error('Scratch path is outside the test directory');
    await fs.rm(root, { recursive: true, force: true, maxRetries: 3 });
  };
  return { app, open, clean, calls, legacy, downloads };
}

module.exports = { fixture, illust, PASSWORD, TOKEN };
