'use strict';

const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomBytes, timingSafeEqual } = require('node:crypto');
const { Store } = require('./store');
const { Pixiv, PixivError } = require('./pixiv');
const { createTransport, proxySetting, probe, envProxy } = require('./httpclient');
const { JobRunner, RequestError, parseJob } = require('./jobs');
const { parseManifest, MAX_BYTES } = require('./library');

const SESSION = 'pxder_session';
const SESSION_AGE = 12 * 60 * 60;
const SAFE_METHODS = new Set(['GET', 'HEAD']);
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);
const STATIC = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
]);

const hash = value => createHash('sha256').update(value).digest();
const filePaths = {
  data: path.resolve(__dirname, '..', '.pxder-web'),
  downloads: path.resolve(__dirname, '..', 'downloads'),
};

function baseHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; form-action 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'");
}

function json(res, code, value) {
  const data = JSON.stringify(value);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(data) });
  res.end(data);
}

async function jsonBody(req, limit = 32 * 1024) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) throw new RequestError(415, '请发送 JSON 数据。');
  const tooLarge = () => new RequestError(413, '文件或请求过大。JSON 索引最大 32 MiB。');
  if (Number(req.headers['content-length']) > limit) throw tooLarge();
  let bytes = 0;
  const chunks = [];
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    bytes += chunk.length;
    if (bytes > limit) throw tooLarge();
    chunks.push(chunk);
  }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
  catch { throw new RequestError(400, '无法读取 JSON，请检查文件格式。'); }
}

function configuredOrigin(value) {
  if (!value) return null;
  const url = new URL(value);
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash || !['https:', 'http:'].includes(url.protocol)) {
    throw new Error('PXDER_ORIGIN must be a bare origin such as https://pxder.example.com (no path).');
  }
  return url.origin;
}

function sessionCookie(id, secure) {
  return `${SESSION}=${id}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${id ? SESSION_AGE : 0}${secure ? '; Secure' : ''}`;
}

function sessionId(req) {
  const match = /(?:^|;\s*)pxder_session=([A-Za-z0-9_-]{43})(?:;|$)/.exec(req.headers.cookie ?? '');
  return match?.[1];
}

function sameOrigin(req, origin) {
  if (typeof req.headers.origin !== 'string' || req.headers['sec-fetch-site'] === 'cross-site') return false;
  if (origin) return req.headers.origin === origin;
  try {
    const expected = new URL(`http://${req.headers.host}`);
    return LOOPBACK.has(expected.hostname) && req.headers.origin === expected.origin;
  } catch { return false; }
}

async function createApp(options = {}) {
  const { password, pixivToken, pixivTransport, origin } = options;
  const proxy = options.proxy?.trim();
  if (typeof password !== 'string' || password.length < 16 || password.length > 1024) throw new Error('Set PXDER_PASSWORD to a strong password (16–1024 characters).');
  if (pixivToken && !validToken(pixivToken)) throw new Error('PXDER_PIXIV_TOKEN has an invalid format.');
  if (proxy) proxySetting(proxy);
  const secret = hash(password);
  const expectedOrigin = configuredOrigin(origin);
  const secure = expectedOrigin?.startsWith('https://');
  const data = path.resolve(options.dataDir ?? filePaths.data);
  const downloads = path.resolve(options.downloadDir ?? filePaths.downloads);
  const library = options.libraryDir ? path.resolve(options.libraryDir) : null;
  await fs.mkdir(data, { recursive: true, mode: 0o700 });
  await fs.mkdir(downloads, { recursive: true, mode: 0o750 });
  const dbFile = path.join(data, 'library.sqlite');
  await (await fs.open(dbFile, 'a', 0o600)).close();
  if (process.platform !== 'win32') await fs.chmod(dbFile, 0o600);
  const store = new Store(dbFile);
  const sessions = new Map();
  const attempts = new Map();
  let tokenBusy = false;
  let proxyBusy = false;
  const tokenInfo = () => {
    const token = pixivToken || store.setting('pixiv_refresh');
    return { configured: Boolean(token), source: pixivToken ? 'env' : token ? 'saved' : null };
  };
  const getProxy = () => proxy || store.setting('pixiv_proxy');
  const proxyInfo = () => {
    const value = getProxy();
    const parsed = proxySetting(value);
    return { mode: parsed.kind === 'env' ? (envProxy() ? 'system' : 'direct') : parsed.kind,
      source: proxy ? 'env' : value ? 'saved' : null, value: parsed.display ?? null };
  };
  const transport = pixivTransport ?? createTransport({ getProxy });
  async function testProxy(value) {
    const tester = pixivTransport ?? createTransport({ getProxy: () => value });
    try { return await probe(tester, { signal: AbortSignal.timeout(12_000) }); }
    finally { if (!pixivTransport) tester.close(); }
  }
  function submittedProxy(body) {
    if (typeof body?.url !== 'string' || !body.url.trim()) throw new RequestError(400, '请输入代理地址或 disable。');
    try {
      const parsed = proxySetting(body.url);
      return parsed.kind === 'disable' ? 'disable' : parsed.url;
    } catch (error) { throw new RequestError(400, error.message); }
  }
  const pixiv = new Pixiv({
    getToken: () => pixivToken || store.setting('pixiv_refresh'),
    rotateToken: (current, replacement) => {
      if (pixivToken || store.setting('pixiv_refresh') !== current || !validToken(replacement)) return false;
      if (current !== replacement) store.setSetting('pixiv_refresh', replacement);
      return true;
    },
    transport,
  });
  const runner = new JobRunner({ store, downloads: await fs.realpath(downloads), library, pixiv, configured: () => tokenInfo().configured });
  const server = http.createServer({ requestTimeout: 60_000, headersTimeout: 10_000, keepAliveTimeout: 5_000, maxHeaderSize: 16_384 }, (req, res) => {
    baseHeaders(res);
    handle(req, res).catch(error => {
      if (res.headersSent || res.destroyed) return;
      if (error instanceof RequestError) {
        if (error.status === 413) res.setHeader('Connection', 'close');
        json(res, error.status, { error: error.message });
      } else if (error instanceof PixivError) {
        json(res, [400, 401, 403].includes(error.status) ? 422 : error.status === 429 ? 429 : 502, { error: error.message });
      } else {
        console.error('[pxder] Request could not complete.', error.code ?? error.name);
        json(res, 500, { error: '服务器无法完成请求。请查看服务日志。' });
      }
      if (!req.complete) req.resume();
    });
  });
  server.maxConnections = 64;

  async function handle(req, res) {
    if (!req.url.startsWith('/') || req.url.startsWith('//')) throw new RequestError(400, '无效的请求地址。');
    const url = new URL(req.url, 'http://localhost');
    const route = url.pathname;
    const method = req.method;
    if (route === '/healthz' && SAFE_METHODS.has(method)) return json(res, 200, { ok: true });
    if (STATIC.has(route) && SAFE_METHODS.has(method)) {
      const [file, type] = STATIC.get(route);
      const data = await fs.readFile(path.join(__dirname, 'public', file));
      res.writeHead(200, { 'Content-Type': type, 'Content-Length': data.length });
      return res.end(method === 'HEAD' ? undefined : data);
    }
    if (!route.startsWith('/api/')) throw new RequestError(404, '找不到该页面。');
    if (!SAFE_METHODS.has(method) && !sameOrigin(req, expectedOrigin)) throw new RequestError(403, '请求来源与站点不一致，请检查反向代理和 PXDER_ORIGIN。');
    const id = sessionId(req);
    const authenticated = Boolean(id && sessions.get(id) > Date.now());
    if (route === '/api/session' && method === 'GET') return json(res, 200, { authenticated });
    if (route === '/api/login' && method === 'POST') {
      const now = Date.now();
      for (const [key, info] of attempts) if (info.until <= now) attempts.delete(key);
      const ip = req.socket.remoteAddress ?? 'unknown';
      if (attempts.size >= 1024 || (attempts.get(ip)?.count ?? 0) >= 8) throw new RequestError(429, '登录尝试过多，请一分钟后再试。');
      const body = await jsonBody(req, 4096);
      const supplied = typeof body?.password === 'string' ? body.password : '';
      if (!timingSafeEqual(secret, hash(supplied))) {
        const previous = attempts.get(ip);
        attempts.set(ip, { count: (previous?.count ?? 0) + 1, until: previous?.until ?? now + 60_000 });
        throw new RequestError(401, '管理员密码不正确。');
      }
      attempts.delete(ip);
      for (const [key, end] of sessions) if (end <= now) sessions.delete(key);
      if (id) sessions.delete(id);
      if (sessions.size >= 32) sessions.delete(sessions.keys().next().value);
      const newId = randomBytes(32).toString('base64url');
      sessions.set(newId, now + SESSION_AGE * 1000);
      res.setHeader('Set-Cookie', sessionCookie(newId, secure));
      return json(res, 200, { authenticated: true });
    }
    if (!authenticated) throw new RequestError(401, '请先登录 WebUI。');
    if (route === '/api/logout' && method === 'POST') {
      await jsonBody(req);
      sessions.delete(id);
      res.setHeader('Set-Cookie', sessionCookie('', secure));
      return json(res, 200, { authenticated: false });
    }
    if (route === '/api/status' && method === 'GET') return json(res, 200, { pixiv: tokenInfo(), proxy: proxyInfo(), queue: store.queueCounts() });
    if (route === '/api/pixiv' && (method === 'POST' || method === 'DELETE')) {
      const body = method === 'POST' ? await jsonBody(req) : null;
      const queue = store.queueCounts();
      if (pixivToken) throw new RequestError(409, '凭据由服务器环境变量管理，请在服务器上修改。');
      if (tokenBusy || proxyBusy || queue.active || queue.queued) throw new RequestError(409, '请等待当前任务结束后修改 Pixiv 凭据。');
      if (method === 'DELETE') {
        store.setSetting('pixiv_refresh', null);
        pixiv.forget();
      } else {
        const token = typeof body?.token === 'string' ? body.token.trim() : '';
        if (!validToken(token)) throw new RequestError(400, '请输入有效的 Pixiv Refresh Token。');
        tokenBusy = true;
        try {
          const result = await pixiv.exchange(token);
          const saved = validToken(result.refreshToken) ? result.refreshToken : token;
          store.setSetting('pixiv_refresh', saved);
          pixiv.remember(result, saved);
        } finally { tokenBusy = false; }
      }
      return json(res, 200, tokenInfo());
    }
    if (route === '/api/proxy/test' && method === 'POST') {
      const body = await jsonBody(req, 8192);
      if (proxyBusy) throw new RequestError(409, '正在测试连接，请稍后再试。');
      const value = !proxy && body?.url !== undefined ? submittedProxy(body) : getProxy();
      proxyBusy = true;
      try { return json(res, 200, { checks: await testProxy(value) }); }
      finally { proxyBusy = false; }
    }
    if (route === '/api/proxy' && (method === 'POST' || method === 'DELETE')) {
      const body = method === 'POST' ? await jsonBody(req, 8192) : null;
      if (proxy) throw new RequestError(409, '代理由 PXDER_PROXY 管理，请在服务器上修改。');
      const queue = store.queueCounts();
      if (tokenBusy || proxyBusy || queue.active || queue.queued) throw new RequestError(409, '请等待当前操作和任务结束后修改代理。');
      if (method === 'DELETE') {
        store.setSetting('pixiv_proxy', null);
        return json(res, 200, proxyInfo());
      }
      const value = submittedProxy(body);
      proxyBusy = true;
      try {
        if (value !== 'disable') {
          const failed = (await testProxy(value)).filter(item => !item.reachable);
          if (failed.length) throw new RequestError(422, `${failed.map(item => item.label).join('、')} 未连通，原设置未变。`);
        }
        store.setSetting('pixiv_proxy', value);
        return json(res, 200, proxyInfo());
      } finally { proxyBusy = false; }
    }
    if (route === '/api/jobs' && method === 'GET') return json(res, 200, { jobs: store.jobs() });
    if (route === '/api/jobs' && method === 'POST') {
      const spec = parseJob(await jsonBody(req));
      if (tokenBusy || proxyBusy) throw new RequestError(409, '正在验证登录或代理，请稍后再试。');
      return json(res, 202, { job: runner.enqueue(spec) });
    }
    const operation = /^\/api\/jobs\/([a-f0-9-]{36})\/(cancel|retry)$/.exec(route);
    if (operation && method === 'POST') {
      await jsonBody(req);
      const job = store.job(operation[1]);
      if (!job) throw new RequestError(404, '找不到该任务。');
      if (operation[2] === 'cancel') return json(res, 200, { job: runner.cancel(job) });
      if (tokenBusy || proxyBusy || ['queued', 'running'].includes(job.status)) throw new RequestError(409, '任务尚未结束。');
      const { type, ids, scope, dryRun } = job;
      return json(res, 202, { job: runner.enqueue({ type, ids, scope, dryRun }) });
    }
    if (route === '/api/library' && method === 'GET') return json(res, 200, store.library(Boolean(library)));
    if (route === '/api/library/scan' && method === 'POST') {
      await jsonBody(req);
      return json(res, 202, { job: runner.enqueue({ type: 'scan', ids: [], scope: null, dryRun: false }) });
    }
    if (route === '/api/library/import' && method === 'POST') {
      const body = await jsonBody(req, MAX_BYTES);
      let manifest;
      try { manifest = parseManifest(body); } catch (error) { throw new RequestError(400, error.message); }
      const name = (url.searchParams.get('name') || '').replace(/[\x00-\x1f\x7f/\\\u202a-\u202e\u2066-\u2069]/gu, '').trim().slice(0, 120) || '旧图库索引';
      try { return json(res, 201, { source: store.importSource(name, manifest) }); }
      catch (error) { if (!error.code) throw new RequestError(409, error.message); throw error; }
    }
    const source = /^\/api\/library\/sources\/(mounted|manifest-[a-f0-9]{32})$/.exec(route);
    if (source && method === 'DELETE') {
      if (!store.removeSource(source[1])) throw new RequestError(404, '找不到该索引来源。');
      return json(res, 200, { ok: true });
    }
    throw new RequestError(404, '找不到该操作。');
  }

  return { server, async close() {
    const disconnect = new Promise(resolve => server.close(resolve));
    await runner.close();
    await disconnect;
    if (!pixivTransport) transport.close();
    store.close();
  } };
}

function validToken(token) { return typeof token === 'string' && /^[\x21-\x7e]{16,2048}$/.test(token); }

async function main() {
  const port = Number(process.env.PXDER_PORT || 8080);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('PXDER_PORT must be a valid port.');
  const host = process.env.PXDER_HOST || '127.0.0.1';
  const app = await createApp({
    password: process.env.PXDER_PASSWORD, origin: process.env.PXDER_ORIGIN, pixivToken: process.env.PXDER_PIXIV_TOKEN,
    proxy: process.env.PXDER_PROXY,
    dataDir: process.env.PXDER_DATA_DIR, downloadDir: process.env.PXDER_DOWNLOAD_DIR, libraryDir: process.env.PXDER_LIBRARY_DIR,
  });
  app.server.on('error', error => {
    console.error(`[pxder] Cannot start listener: ${error.code ?? 'unknown error'}`);
    app.close().finally(() => { process.exitCode = 1; });
  });
  app.server.listen(port, host, () => console.log(`[pxder] WebUI listening on ${host}:${port}`));
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => app.close());
}

if (require.main === module) main().catch(error => { console.error(`[pxder] ${error.message}`); process.exitCode = 1; });

module.exports = { createApp };
