'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createTransport, proxySetting, probe } = require('../httpclient');

test('normalize proxy settings and keep credentials out of the display value', () => {
  assert.deepEqual(proxySetting(' proxy.example.com:8080 '), { kind: 'proxy', url: 'http://proxy.example.com:8080/', display: 'http://proxy.example.com:8080' });
  const auth = proxySetting('http://user:secret@proxy.example.com:8080');
  assert.match(auth.url, /user:secret@/);
  assert.equal(auth.display, 'http://proxy.example.com:8080');
  assert.equal(proxySetting('socks5h://localhost:1080').kind, 'proxy');
  assert.equal(proxySetting('disable').kind, 'disable');
  assert.equal(proxySetting('').kind, 'env');
  for (const bad of ['ftp://localhost:1080', 'http://test/path', 'http://test/?x=1', 'http://test/#fragment']) assert.throws(() => proxySetting(bad), /代理/);
});

test('uses CONNECT and does not count proxy errors as reachable', { timeout: 6000 }, async () => {
  const server = http.createServer();
  const sockets = new Set();
  const hosts = [];
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  server.on('connect', (req, socket) => {
    hosts.push(req.url);
    socket.end('HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\n\r\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const transport = createTransport({ getProxy: () => `http://127.0.0.1:${server.address().port}` });
  try {
    const checks = await probe(transport, { signal: AbortSignal.timeout(3000) });
    assert.deepEqual(hosts.sort(), ['app-api.pixiv.net:443', 'i.pximg.net:443', 'oauth.secure.pixiv.net:443']);
    assert.ok(checks.every(item => !item.reachable && item.status === null));
  } finally {
    transport.close();
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  }
});
