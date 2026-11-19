'use strict';

const { createHash } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { BASE_URL, CLIENT_ID, CLIENT_SECRET, HASH_SECRET } = require('../src/pixiv-api-config');
const TOKEN_URL = 'https://oauth.secure.pixiv.net/auth/token';
const CDN_HOSTS = new Set(['i.pximg.net', 'i-f.pximg.net', 'i-cf.pximg.net']);
const JSON_LIMIT = 8 * 1024 * 1024;

class PixivError extends Error {
  constructor(message, { status = 0, transient = false, stop = false } = {}) {
    super(message);
    this.status = status;
    this.transient = transient;
    this.stop = stop;
  }
}

function apiHeaders() {
  const time = new Date().toISOString().replace(/\.\d{3}Z$/, '+00:00');
  return {
    'App-OS': 'android', 'App-OS-Version': '9.0', 'App-Version': '5.0.234',
    'User-Agent': 'PixivAndroidApp/5.0.234 (Android 9.0; Pixel 3)', 'Accept-Language': 'en-us',
    'X-Client-Time': time, 'X-Client-Hash': createHash('md5').update(time + HASH_SECRET).digest('hex'),
  };
}

function cdnUrl(value) {
  let url;
  try { url = new URL(value); } catch {}
  if (!url || url.protocol !== 'https:' || !CDN_HOSTS.has(url.hostname) || url.username || url.password || url.port || url.hash) {
    throw new PixivError('Pixiv 未提供可用的原图地址。');
  }
  return url;
}

function feedUrl(value, expectedPath) {
  let url;
  try { url = new URL(value, BASE_URL); } catch {}
  if (!url || url.origin !== BASE_URL || url.pathname !== expectedPath || url.username || url.password || url.hash) {
    throw new PixivError('Pixiv 返回了无法识别的分页地址。', { stop: true });
  }
  return url;
}

async function bytesJson(response) {
  let size = 0;
  const chunks = [];
  for await (const chunk of response.body ?? []) {
    size += chunk.byteLength;
    if (size > JSON_LIMIT) throw new PixivError('Pixiv 返回的数据过大。', { stop: true });
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new PixivError('Pixiv 返回了无法识别的数据。'); }
}

async function discard(response) {
  try { response.body?.destroy?.(); } catch {}
}

function responseError(status, mode) {
  if (status === 429) return new PixivError('Pixiv 限制了请求频率，请稍后重试。', { status, stop: true });
  if (mode === 'token' && [400, 401, 403].includes(status)) return new PixivError('Pixiv 拒绝了 Refresh Token，请重新获取。', { status, stop: true });
  if (status === 401) return new PixivError('Pixiv 登录已失效，请检查 Refresh Token。', { status, stop: true });
  if (status === 404) return new PixivError('作品、画师或资源不存在，或对该账号不可见。', { status });
  if (status === 403) return new PixivError('Pixiv 不允许访问此作品或资源。', { status });
  return new PixivError(`Pixiv 返回 HTTP ${status}。`, { status, transient: status >= 500 });
}

async function retry(operation, signal, retries = 1) {
  for (let attempt = 0; ; attempt++) {
    signal?.throwIfAborted();
    try { return await operation(); }
    catch (error) {
      signal?.throwIfAborted();
      if (!error.transient || attempt === retries) throw error;
      await delay(750 * (attempt + 1), undefined, { signal });
    }
  }
}

class Pixiv {
  constructor({ getToken, rotateToken, transport }) {
    this.getToken = getToken;
    this.rotateToken = rotateToken;
    this.transport = transport;
  }

  forget() { this.auth = null; }

  remember(auth, token) { this.auth = { ...auth, configuredToken: token }; }

  async request(url, init, signal, mode = 'api') {
    signal?.throwIfAborted();
    const timeout = AbortSignal.timeout(mode === 'asset' ? 120_000 : 25_000);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      const response = await this.transport(url, { ...init, signal: combined });
      if (!response.ok) {
        // The legacy endpoint sometimes signals its rate limit with a 400 JSON error.
        if (mode === 'api' && response.status === 400) {
          const body = await bytesJson(response).catch(() => null);
          if (body && /rate[ _-]limit/i.test(JSON.stringify(body))) throw responseError(429, mode);
        } else await discard(response);
        throw responseError(response.status, mode);
      }
      if (mode === 'asset') return { response, signal: combined };
      return await bytesJson(response);
    } catch (error) {
      signal?.throwIfAborted();
      if (error instanceof PixivError) throw error;
      throw new PixivError('无法连接 Pixiv，请检查服务器网络。', { transient: true });
    }
  }

  async exchange(token, signal) {
    const body = new URLSearchParams({
      client_id: CLIENT_ID, client_secret: CLIENT_SECRET, get_secure_url: 'true', include_policy: 'true',
      grant_type: 'refresh_token', refresh_token: token,
    });
    const data = await this.request(TOKEN_URL, {
      method: 'POST',
      headers: { ...apiHeaders(), 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    }, signal, 'token');
    const auth = data?.response ?? data;
    if (typeof auth?.access_token !== 'string' || !auth.access_token) throw new PixivError('Pixiv 未返回登录凭据，请重新获取 Refresh Token。', { stop: true });
    const expires = Number(auth.expires_in);
    return {
      accessToken: auth.access_token,
      refreshToken: typeof auth.refresh_token === 'string' && auth.refresh_token ? auth.refresh_token : token,
      userId: String(auth.user?.id ?? ''),
      expiresAt: Date.now() + 1000 * (Number.isFinite(expires) && expires > 0 ? Math.min(expires, 3600) : 3000),
    };
  }

  async authorize(signal, force = false) {
    const token = this.getToken();
    if (!token) throw new PixivError('请先在设置中配置 Pixiv Refresh Token。', { stop: true });
    const same = this.auth?.configuredToken === token;
    if (!force && same && this.auth.expiresAt - 90_000 > Date.now()) return this.auth;
    const auth = await retry(() => this.exchange(same ? this.auth.refreshToken : token, signal), signal);
    const saved = this.rotateToken(token, auth.refreshToken);
    this.remember(auth, saved ? auth.refreshToken : token);
    return this.auth;
  }

  async get(path, params, signal, next) {
    const url = next ? feedUrl(next, path) : new URL(`${path}?${new URLSearchParams(params)}`, BASE_URL);
    const grab = async force => {
      const auth = await this.authorize(signal, force);
      return this.request(url, { headers: { ...apiHeaders(), Authorization: `Bearer ${auth.accessToken}` } }, signal);
    };
    return retry(async () => {
      try { return await grab(false); }
      catch (error) { if (error.status !== 401) throw error; return grab(true); }
    }, signal);
  }

  async *pages(path, params, listField, signal) {
    let next;
    const seen = new Set();
    do {
      signal?.throwIfAborted();
      const data = await this.get(path, params, signal, next);
      if (!Array.isArray(data?.[listField])) throw new PixivError('Pixiv 返回了无法读取的列表。', { stop: true });
      yield* data[listField];
      next = data.next_url;
      if (next && (typeof next !== 'string' || seen.has(next) || seen.size >= 10_000)) {
        throw new PixivError('Pixiv 分页重复或超出上限，任务已停止。', { stop: true });
      }
      if (next) seen.add(next);
    } while (next);
  }

  async asset(url, signal) {
    return this.request(cdnUrl(url), { headers: {
      Referer: 'https://www.pixiv.net/', 'Accept-Encoding': 'identity', 'User-Agent': 'pxder-webui/1',
    } }, signal, 'asset');
  }
}

module.exports = { Pixiv, PixivError, cdnUrl, feedUrl, retry };
