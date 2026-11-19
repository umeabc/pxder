'use strict';

const https = require('node:https');
const { ProxyAgent } = require('proxy-agent');

const ENV_NAMES = ['all_proxy', 'https_proxy', 'http_proxy'].flatMap(name => [name, name.toUpperCase()]);
const SCHEMES = new Set(['http:', 'https:', 'socks4:', 'socks4a:', 'socks5:', 'socks5h:']);
const TARGETS = [
  ['api', 'Pixiv API', 'https://app-api.pixiv.net/'],
  ['oauth', 'Pixiv 登录', 'https://oauth.secure.pixiv.net/auth/token'],
  ['cdn', '图片 CDN', 'https://i.pximg.net/'],
];

function proxySetting(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) return { kind: 'env' };
  if (text === 'disable') return { kind: 'disable' };
  let parsed;
  try {
    if (text.length > 2048 || /[\s\\]/u.test(text)) throw new Error();
    parsed = new URL(text.includes('://') ? text : `http://${text}`);
  } catch { throw new Error('代理地址格式不正确，例如 http://proxy.example.com:8080。'); }
  if (!SCHEMES.has(parsed.protocol)) throw new Error('仅支持 HTTP、HTTPS 和 SOCKS4/5 代理。');
  if (!parsed.hostname || (parsed.pathname !== '/' && parsed.pathname !== '') || parsed.search || parsed.hash) {
    throw new Error('代理地址不能包含路径、查询参数或片段。');
  }
  return { kind: 'proxy', url: parsed.href, display: `${parsed.protocol}//${parsed.host}` };
}

function envProxy() {
  return ENV_NAMES.some(name => Boolean(process.env[name]));
}

// Same library as the CLI; each transport owns its connections so it can close them.
function createTransport({ getProxy = () => null } = {}) {
  const agents = new Map();
  const direct = new https.Agent({ keepAlive: true, maxSockets: 8 });
  const transport = function (url, { method = 'GET', headers = {}, body, signal } = {}) {
    return new Promise((resolve, reject) => {
      signal?.throwIfAborted();
      const target = new URL(url);
      if (target.protocol !== 'https:') throw new Error('只允许通过 HTTPS 访问 Pixiv。');
      const setting = proxySetting(getProxy());
      const useProxy = setting.kind === 'proxy' || (setting.kind === 'env' && envProxy());
      const key = setting.url ?? 'env';
      if (useProxy && !agents.has(key)) {
        if (agents.size >= 4) {
          const oldest = agents.keys().next().value;
          agents.get(oldest).destroy();
          agents.delete(oldest);
        }
        agents.set(key, new ProxyAgent(setting.url ? { getProxyForUrl: () => setting.url } : undefined));
      }
      const options = { method, headers: { ...headers }, agent: useProxy ? agents.get(key) : direct, signal };
      if (body != null) options.headers['Content-Length'] = Buffer.byteLength(body);
      const request = https.request(target, options, res => {
        // CONNECT rejection can surface as a synthetic HTTP response, without target TLS.
        if (res.socket?.encrypted !== true || res.socket?.authorized !== true) {
          res.destroy();
          reject(new Error('代理未能建立到 Pixiv 的 HTTPS 连接。'));
          return;
        }
        resolve({
          status: res.statusCode,
          ok: res.statusCode >= 200 && res.statusCode < 300,
          headers: { get: name => res.headers[String(name).toLowerCase()] ?? null },
          body: res,
        });
      });
      request.on('error', error => {
        reject(signal?.aborted ? signal.reason : useProxy ? new Error('无法通过代理连接 Pixiv，请检查地址和网络。', { cause: error }) : error);
      });
      request.setTimeout(125_000, () => request.destroy(new Error('连接超时。')));
      request.end(body);
    });
  };
  transport.close = () => {
    for (const agent of agents.values()) agent.destroy();
    agents.clear();
    direct.destroy();
  };
  return transport;
}

async function probe(transport, { signal } = {}) {
  return Promise.all(TARGETS.map(async ([id, label, url]) => {
    try {
      const response = await transport(url, { method: 'HEAD', signal, headers: { 'User-Agent': 'pxder-webui/1' } });
      response.body?.destroy?.();
      return { id, label, reachable: response.status >= 200 && response.status < 500 && response.status !== 407, status: response.status };
    } catch {
      return { id, label, reachable: false, status: null };
    }
  }));
}

module.exports = { createTransport, proxySetting, probe, envProxy };
