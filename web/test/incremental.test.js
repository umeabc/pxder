'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { setTimeout: sleep } = require('node:timers/promises');
const { fixture, illust, PASSWORD } = require('./fixture');

function page(uid, works, offset = null) {
  const next_url = offset === null ? null : `https://app-api.pixiv.net/v1/user/illusts?user_id=${uid}&offset=${offset}&type=illust`;
  return { illusts: works, next_url };
}

async function setup(t, options, artists, assets) {
  const f = await fixture({ withToken: true, ...options });
  t.after(async () => { await f.app.close(); await f.clean(); });
  const login = await fetch(`${f.app.origin}/api/login`, {
    method: 'POST', headers: { Origin: f.app.origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }),
  });
  assert.equal(login.status, 200);
  await login.json();
  const Cookie = login.headers.get('set-cookie').split(';')[0];
  async function request(route, body) {
    const response = await fetch(f.app.origin + route, {
      method: body ? 'POST' : 'GET', headers: { Origin: f.app.origin, Cookie, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await response.json();
    assert.ok(response.ok, JSON.stringify(data));
    return data;
  }
  await request('/api/library/import?name=history.json', { format: 'pxder-library-v1', assets, artists });
  async function run(spec) {
    f.calls.length = 0;
    const { job } = await request('/api/jobs', spec);
    for (let i = 0; i < 150; i++) {
      const { jobs } = await request('/api/jobs');
      const state = jobs.find(item => item.id === job.id);
      if (state && !['queued', 'running'].includes(state.status)) return state;
      await sleep(20);
    }
    assert.fail('job did not finish');
  }
  const activity = () => f.calls.flatMap(call => {
    if (call.path === '/v1/user/illusts') {
      const params = new URLSearchParams(call.query);
      return `page ${params.get('user_id')}:${params.get('offset') ?? 0}`;
    }
    if (call.host === 'i.pximg.net') return call.path.split('/').pop();
    return [];
  });
  return { run, activity };
}

const image = (pid, index = 0) => [String(pid), 'image', index];

test('incremental update skips old pages, ignores pinned cutoff, fills holes and switches artist', async t => {
  const options = { artistFeed(uid, offset) {
    if (uid === 88 && offset === 0) return page(uid, [illust(10, 1, uid, true), illust(66), illust(65, 2)], 30);
    if (uid === 88 && offset === 30) return page(uid, [illust(61, 2), illust(60)], 60);
    if (uid === 88) return page(uid, [illust(59)]);
    return page(uid, [illust(50, 1, uid), illust(49, 1, uid)], offset ? null : 30);
  } };
  const f = await setup(t, options, ['88', '89'], [image(10), image(65), image(61), image(61, 1), image(50)]);
  const dry = await f.run({ type: 'update', dryRun: true });
  assert.deepEqual([dry.status, dry.total, dry.skipped, dry.missing, dry.downloaded], ['completed', 7, 5, 2, 0]);
  assert.match(dry.message, /画师 2\/2，2 位命中/);
  assert.deepEqual(f.activity(), ['page 88:0', 'page 88:30', 'page 89:0']);

  const result = await f.run({ type: 'update' });
  assert.deepEqual([result.status, result.total, result.skipped, result.downloaded], ['completed', 7, 5, 2]);
  assert.deepEqual(f.activity(), ['page 88:0', 'page 88:30', '65_p1.jpg', '66_p0.jpg', 'page 89:0']);

  const again = await f.run({ type: 'update' });
  assert.equal(again.downloaded, 0);
  assert.deepEqual(f.activity(), ['page 88:0', 'page 89:0']);

  const full = await f.run({ type: 'uid', values: '88', dryRun: true });
  assert.equal(full.missing, 2);
  assert.deepEqual(f.activity(), ['page 88:0', 'page 88:30', 'page 88:60']);
});

test('an older download failure cannot hide missing latest works on the next update', async t => {
  let broken = true;
  const options = {
    artistFeed: (uid, offset) => offset ? page(uid, [illust(80)]) : page(uid, [illust(93), illust(92, 2), illust(91)], 30),
    assetStatus: url => broken && url.pathname.endsWith('/92_p1.jpg') ? 404 : 200,
  };
  const f = await setup(t, options, ['88'], [image(91)]);
  const failed = await f.run({ type: 'update' });
  assert.deepEqual([failed.status, failed.downloaded, failed.failed], ['partial', 1, 1]);
  assert.deepEqual(f.activity(), ['page 88:0', '92_p0.jpg', '92_p1.jpg']);
  broken = false;
  const retry = await f.run({ type: 'update' });
  assert.deepEqual([retry.status, retry.downloaded, retry.failed], ['completed', 2, 0]);
  assert.deepEqual(f.activity(), ['page 88:0', '92_p1.jpg', '93_p0.jpg']);
});

test('without a known work it follows the remaining pages', async t => {
  const f = await setup(t, { artistFeed: (uid, offset) => offset ? page(uid, [illust(94)]) : page(uid, [illust(95)], 30) }, ['88'], [image(200)]);
  const result = await f.run({ type: 'update', dryRun: true });
  assert.equal(result.missing, 2);
  assert.deepEqual(f.activity(), ['page 88:0', 'page 88:30']);
});
