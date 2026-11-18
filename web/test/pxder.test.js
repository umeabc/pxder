'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs/promises');
const { setTimeout: sleep } = require('node:timers/promises');
const { fileAsset, scanLibrary, parseManifest } = require('../library');
const { parseJob } = require('../jobs');
const { feedUrl } = require('../pixiv');
const { fixture, PASSWORD, TOKEN } = require('./fixture');

const manifest = assets => ({ format: 'pxder-library-v1', assets });

test('old filenames retain media kind and page number', () => {
  assert.deepEqual(fileAsset('(101)作品_p2.jpg'), ['101', 'image', 2]);
  assert.deepEqual(fileAsset('(101)作品_p0.gif'), ['101', 'image', 0]);
  assert.deepEqual(fileAsset('(101)作品.jpg'), ['101', 'image', 0]);
  assert.deepEqual(fileAsset('(101)作品@65ms.zip'), ['101', 'ugoira', 0]);
  assert.deepEqual(fileAsset('101_ugoira1920x1080.zip'), ['101', 'ugoira', 0]);
  assert.deepEqual(fileAsset('101_p3.PNG'), ['101', 'image', 3]);
  for (const name of ['101_ugoira0.jpg', '(101)作品.jpg.part', '101.jpg', '101_p0_master1200.jpg', '(101)作品_p10000.jpg']) assert.equal(fileAsset(name), null);
  assert.throws(() => parseManifest(manifest([['small', 'image', 0]])), /无效/);
  assert.throws(() => parseManifest(manifest([['101', 'ugoira', 1]])), /无效/);
  assert.deepEqual(parseManifest(manifest([['101', 'image', 2], ['101', 'image', 2]])).assets, [['101', 'image', 2]]);
});

test('parse only Pixiv IDs and constrain pagination to the same endpoint', () => {
  assert.deepEqual(parseJob({ type: 'pid', values: '42, https://www.pixiv.net/en/artworks/42；https://www.pixiv.net/artworks/43' }).ids, ['42', '43']);
  assert.deepEqual(parseJob({ type: 'uid', values: 'https://www.pixiv.net/member.php?id=88' }).ids, ['88']);
  assert.throws(() => parseJob({ type: 'uid', values: 'https://www.pixiv.net/artworks/42' }), /UID/);
  assert.throws(() => parseJob({ type: 'pid', values: 'https://example.org/artworks/42' }), /PID/);
  assert.throws(() => feedUrl('https://elsewhere.example/v1/user/illusts', '/v1/user/illusts'), /分页/);
});

test('authenticated queue: import, scan, screen, fill missing page, cancel and restart', async t => {
  const f = await fixture();
  let app = f.app;
  t.after(async () => { await app.close(); await f.clean(); });
  let cookie = '';
  const request = async (route, { method = 'GET', body, origin = app.origin, noCookie = false } = {}) => {
    const headers = { Origin: origin };
    if (cookie && !noCookie) headers.Cookie = cookie;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(app.origin + route, { method, body: body === undefined ? undefined : JSON.stringify(body), headers });
    if (res.headers.has('set-cookie')) cookie = res.headers.get('set-cookie').split(';')[0];
    const data = await res.json();
    return [res.status, data];
  };
  const login = async () => (await request('/api/login', { method: 'POST', body: { password: PASSWORD } }))[0];
  const post = async (url, body = {}) => (await request(url, { method: 'POST', body }))[1];
  const settle = async id => {
    for (let i = 0; i < 100; i++) {
      const [, { jobs }] = await request('/api/jobs');
      const job = jobs.find(job => job.id === id);
      if (job && !['running', 'queued'].includes(job.status)) return job;
      await sleep(25);
    }
    assert.fail('job did not finish');
  };

  assert.equal((await request('/api/library'))[0], 401);
  assert.equal((await request('/api/login', { method: 'POST', origin: 'https://example.org', body: { password: PASSWORD } }))[0], 403);
  assert.equal(await login(), 200);
  assert.equal((await request('/api/jobs', { method: 'POST', body: { type: 'pid', values: '42' } }))[0], 409);
  const fromDisk = await scanLibrary(f.legacy);
  assert.equal(fromDisk.scanned, 5);
  assert.deepEqual(fromDisk.manifest.assets, [['42', 'image', 0], ['57', 'image', 0], ['77', 'ugoira', 0]]);
  assert.deepEqual(fromDisk.manifest.artists, ['88']);
  const imported = await post('/api/library/import?name=old.json', fromDisk.manifest);
  assert.equal(imported.source.count, 3);
  assert.equal((await post('/api/library/import', fromDisk.manifest)).source.id, imported.source.id);
  assert.equal((await request('/api/library/import', { method: 'POST', body: manifest([['42', 'gif', 0]]) }))[0], 400);
  const scan = await settle((await post('/api/library/scan')).job.id);
  assert.equal(scan.status, 'completed');
  assert.equal(scan.skipped, 2);
  assert.equal((await request('/api/library'))[1].assets, 3);
  const tokenResult = await post('/api/pixiv', { token: TOKEN });
  assert.deepEqual(tokenResult, { configured: true, source: 'saved' });
  const dry = await settle((await post('/api/jobs', { type: 'pid', values: '42', dryRun: true })).job.id);
  assert.deepEqual([dry.status, dry.skipped, dry.missing, dry.downloaded, dry.failed], ['completed', 1, 1, 0, 0]);
  const real = await settle((await post('/api/jobs', { type: 'pid', values: '42' })).job.id);
  assert.deepEqual([real.status, real.skipped, real.missing, real.downloaded, real.failed], ['completed', 1, 0, 1, 0]);
  assert.deepEqual(await fs.readdir(path.join(f.downloads, 'PID')), ['(42)雨中邮局_p1.jpg']);
  const bookmark = await settle((await post('/api/jobs', { type: 'bookmark', scope: 'private', dryRun: true })).job.id);
  assert.deepEqual([bookmark.status, bookmark.skipped, bookmark.missing], ['completed', 2, 1]);
  assert.ok(f.calls.some(call => call.path === '/v1/user/bookmarks/illust' && call.query.includes('restrict=private')));
  const follow = await settle((await post('/api/jobs', { type: 'follow', scope: 'public', dryRun: true })).job.id);
  assert.deepEqual([follow.status, follow.skipped, follow.missing], ['completed', 2, 0]);
  const update = await settle((await post('/api/jobs', { type: 'update', dryRun: true })).job.id);
  assert.equal(update.skipped, 2);
  assert.equal(f.calls.filter(call => call.host === 'i.pximg.net').length, 1);
  const cancel = (await post('/api/jobs', { type: 'pid', values: '420' })).job;
  await post(`/api/jobs/${cancel.id}/cancel`);
  assert.equal((await settle(cancel.id)).status, 'cancelled');
  const [removed] = await request(`/api/library/sources/${imported.source.id}`, { method: 'DELETE' });
  assert.equal(removed, 200);
  assert.equal((await request('/api/library'))[1].assets, 4);

  await app.close();
  app = await f.open(0, false);
  assert.equal((await request('/api/status'))[0], 401);
  assert.equal(await login(), 200);
  assert.deepEqual((await request('/api/status'))[1].pixiv, { configured: true, source: 'saved' });
  assert.equal((await request('/api/library'))[1].assets, 4);
  assert.equal((await request('/api/logout', { method: 'POST', body: {} }))[0], 200);
  assert.equal((await request('/api/jobs'))[0], 401);
});
