'use strict';

const $ = id => document.getElementById(id);
const number = new Intl.NumberFormat('zh-CN');
const date = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' });
const types = { pid: '按作品下载', uid: '按画师下载', bookmark: '同步收藏', follow: '同步关注画师', update: '更新已知画师', scan: '扫描旧图目录' };
const states = { queued: '排队中', running: '执行中', completed: '已完成', partial: '部分完成', failed: '失败', cancelled: '已取消' };
const sourceTypes = { download: 'WebUI 下载', scan: '目录扫描', manifest: '导入索引' };
const active = job => ['queued', 'running'].includes(job.status);
const emptyCounts = () => ({ active: 0, queued: 0 });
const viewLinks = [...document.querySelectorAll('[data-view]')];
const views = new Set(viewLinks.map(link => link.dataset.view));
let signedIn = false;
let polling = false;
let proxyPending = false;
let jobs = [];
let status = { pixiv: { configured: false, source: null }, queue: emptyCounts() };
let library = null;
let currentView = 'dispatch';
let noticeTimer;
let libraryText = '';
let jobsText = '';

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function notice(text, error = false) {
  clearTimeout(noticeTimer);
  $('notice').textContent = text;
  $('notice').classList.toggle('error', error);
  $('notice').hidden = !text;
  if (text && !error) noticeTimer = setTimeout(() => { $('notice').hidden = true; }, 6000);
}

async function api(path, { method = 'GET', body, file, guest = false } = {}) {
  const init = { method, headers: {}, credentials: 'same-origin', signal: AbortSignal.timeout(file ? 65_000 : 40_000) };
  if (body !== undefined || file) {
    init.headers['Content-Type'] = 'application/json';
    init.body = file ?? JSON.stringify(body);
  }
  let response;
  try { response = await fetch(path, init); }
  catch { throw new Error('无法连接服务器，请检查网络后重试。'); }
  if (response.status === 401 && !guest) {
    showSession(false);
    $('login-error').textContent = '登录已过期，请重新登录。';
    $('login-error').hidden = false;
  }
  const content = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(content.error ?? `服务器拒绝了请求（HTTP ${response.status}）。`);
  return content;
}

function showSession(authenticated) {
  signedIn = authenticated;
  $('login-view').hidden = authenticated;
  $('app-view').hidden = !authenticated;
  if (!authenticated) {
    notice('');
    jobs = [];
    library = null;
    libraryText = jobsText = '';
    status = { pixiv: { configured: false, source: null }, queue: emptyCounts() };
    $('jobs-list').replaceChildren();
    $('sources-list').replaceChildren();
    $('job-form').reset();
    $('import-form').reset();
    $('pixiv-form').reset();
    $('proxy-form').reset();
    $('proxy-result').hidden = true;
    $('queue-count').textContent = '0';
    $('assets-count').textContent = '—';
    $('works-count').textContent = '—';
  } else {
    $('login-error').hidden = true;
    route();
    setForm();
  }
}

function route() {
  const target = location.hash.slice(1);
  currentView = views.has(target) ? target : 'dispatch';
  for (const link of viewLinks) {
    const selected = link.dataset.view === currentView;
    $(link.dataset.view).hidden = !selected;
    link.classList.toggle('is-active', selected);
    if (selected) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  if (signedIn && currentView === 'library') refreshLibrary().catch(error => { if (signedIn) notice(error.message, true); });
}

function openView(view) {
  if (location.hash !== `#${view}`) location.hash = view;
  else route();
}

function setForm() {
  const type = $('job-type').value;
  const withIds = ['pid', 'uid'].includes(type);
  $('value-field').hidden = !withIds;
  $('job-values').required = withIds;
  $('job-values').placeholder = type === 'pid' ? '作品 PID 或 Pixiv 作品链接' : '画师 UID 或 Pixiv 画师链接';
  $('scope-field').hidden = !['bookmark', 'follow'].includes(type);
  $('update-hint').hidden = type !== 'update';
  $('job-submit').textContent = $('job-dry').checked ? '开始筛选' : '加入下载队列';
}

function updateState() {
  const { pixiv, queue, proxy } = status;
  const locked = proxy?.source === 'env';
  $('proxy-state').textContent = (proxy?.value ?? ({ system: '使用系统代理', disable: '已关闭代理（直连）', direct: '直连（未设置代理）' })[proxy?.mode] ?? '正在读取代理设置。') + (locked ? '（由服务器管理）' : '');
  $('proxy-url').disabled = locked || proxyPending;
  $('proxy-form').querySelector('[type="submit"]').disabled = locked || proxyPending;
  $('test-proxy').disabled = proxyPending;
  $('remove-proxy').hidden = proxy?.source !== 'saved';
  $('remove-proxy').disabled = proxyPending;
  $('queue-count').textContent = number.format(queue.active + queue.queued);
  $('pixiv-state').classList.toggle('ok', pixiv.configured);
  $('pixiv-state').textContent = pixiv.source === 'env' ? '服务器已配置' : pixiv.configured ? '已保存' : '未配置';
  $('pixiv-token').disabled = pixiv.source === 'env';
  $('pixiv-form').querySelector('[type="submit"]').disabled = pixiv.source === 'env';
  $('remove-token').hidden = !pixiv.configured || pixiv.source === 'env';
  $('pixiv-help').hidden = pixiv.configured;
  $('scan-button').disabled = !library?.canScan || jobs.some(job => job.type === 'scan' && active(job));
  $('scan-hint').textContent = library?.canScan ? '读取服务器挂载的旧目录，只更新索引，不搬动图片。' : '若图片已在服务器上，配置 PXDER_LIBRARY_DIR 后可在这里扫描。';
}

function action(text, className, work) {
  const button = el('button', `btn ${className}`, text);
  button.type = 'button';
  button.addEventListener('click', async () => {
    button.disabled = true;
    try { await work(); }
    catch (error) { if (signedIn) notice(error.message, true); }
    finally { button.disabled = false; }
  });
  return button;
}

function progressBar(job, counters) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('class', 'job-proof');
  svg.setAttribute('viewBox', '0 0 1000 8');
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('aria-hidden', 'true');
  let start = 0;
  for (const [css, , value] of counters) {
    if (!value || !job.total) continue;
    const width = 1000 * value / job.total;
    const rect = document.createElementNS(ns, 'rect');
    rect.setAttribute('class', css);
    rect.setAttribute('x', String(start));
    rect.setAttribute('width', String(width));
    rect.setAttribute('height', '8');
    svg.append(rect);
    start += width;
  }
  return svg;
}

function renderJobs() {
  const fingerprint = JSON.stringify(jobs);
  if (fingerprint === jobsText) return;
  jobsText = fingerprint;
  const list = $('jobs-list');
  const focus = list.contains(document.activeElement) ? document.activeElement.dataset.actionKey : null;
  if (!jobs.length) { list.replaceChildren(el('p', 'empty-state', '还没有任务。去「新建任务」试一次仅筛选。')); return; }
  const rows = jobs.map(job => {
    const row = el('article', 'job-row');
    const heading = el('div', 'job-head');
    const title = types[job.type] + (job.dryRun ? ' · 仅筛选' : '');
    heading.append(el('h3', '', title), el('span', `pill status-${job.status}`, states[job.status]));
    const desc = [];
    if (job.ids.length) desc.push(job.ids.slice(0, 5).join('、') + (job.ids.length > 5 ? ` 等 ${job.ids.length} 个 ID` : ''));
    if (job.scope) desc.push(job.scope === 'private' ? '私密' : '公开');
    desc.push(date.format(new Date(job.createdAt)));
    row.append(heading, el('p', 'row-meta', desc.join(' / ')));
    const isScan = job.type === 'scan';
    const counters = isScan ? [['processed', '已扫描', job.total], ['skipped', '已忽略', job.skipped], ['failed', '失败', job.failed]] : [
      ['downloaded', '已下载', job.downloaded], ['skipped', '已跳过', job.skipped],
      ...(job.dryRun ? [['missing', '缺失', job.missing]] : []), ['failed', '失败', job.failed],
    ];
    if (!isScan) row.append(progressBar(job, counters));
    const metric = el('dl', 'job-counts');
    if (!isScan) counters.unshift(['processed', '已发现', job.total]);
    for (const [css, label, value] of counters) {
      const unit = el('div', `count-${css}`);
      unit.append(el('dt', '', label), el('dd', '', number.format(value)));
      metric.append(unit);
    }
    row.append(metric);
    if (job.message) row.append(el('p', 'job-message', job.message));
    const actions = el('div', 'row-actions');
    const add = (key, text, style, callback) => {
      const button = action(text, style, callback);
      button.dataset.actionKey = `${job.id}-${key}`;
      actions.append(button);
    };
    if (active(job)) {
      add('cancel', '取消', 'btn-secondary', async () => {
        await api(`/api/jobs/${job.id}/cancel`, { method: 'POST', body: {} });
        notice('已请求取消任务。');
        await refresh();
      });
    } else {
      if (['partial', 'failed', 'cancelled'].includes(job.status)) {
        add('retry', '重试', 'btn-secondary', async () => {
          await api(`/api/jobs/${job.id}/retry`, { method: 'POST', body: {} });
          notice('已加入重试队列。');
          await refresh();
        });
      }
      if (job.dryRun && job.missing && ['partial', 'completed'].includes(job.status)) {
        add('download', '补齐缺失图片', 'btn-primary', async () => {
          await enqueue({ type: job.type, values: job.ids.join(','), scope: job.scope, dryRun: false });
        });
      }
    }
    if (actions.childElementCount) row.append(actions);
    return row;
  });
  list.replaceChildren(...rows);
  if (focus) [...list.querySelectorAll('[data-action-key]')].find(button => button.dataset.actionKey === focus)?.focus({ preventScroll: true });
}

async function refreshLibrary() {
  const latest = await api('/api/library');
  if (!signedIn) return;
  library = latest;
  updateState();
  const fingerprint = JSON.stringify(library);
  if (fingerprint === libraryText) return;
  libraryText = fingerprint;
  $('assets-count').textContent = number.format(library.assets);
  $('works-count').textContent = number.format(library.works);
  $('sources-list').replaceChildren(...library.sources.map(source => {
    const row = el('article', 'source-row');
    const desc = el('div', 'source-detail');
    desc.append(el('h4', '', source.name), el('p', 'row-meta', `${sourceTypes[source.kind]} / ${number.format(source.count)} 条记录`));
    row.append(desc);
    if (source.kind !== 'download') {
      row.append(action('移除索引', 'btn-secondary', async () => {
        if (!confirm('移除此来源的索引？原始图片不会被删除。')) return;
        await api(`/api/library/sources/${source.id}`, { method: 'DELETE' });
        await refreshLibrary();
        notice('已移除索引，未改动图片。');
      }));
    }
    return row;
  }));
}

async function refresh() {
  if (!signedIn || polling) return;
  polling = true;
  try {
    const [nextStatus, nextJobs] = await Promise.all([api('/api/status'), api('/api/jobs')]);
    if (!signedIn) return;
    status = nextStatus;
    jobs = nextJobs.jobs;
    updateState();
    renderJobs();
    if (currentView === 'library') await refreshLibrary();
  } finally { polling = false; }
}

async function formAction(form, callback, errorField) {
  const submit = form.querySelector('[type="submit"]');
  if (submit.disabled) return;
  submit.disabled = true;
  try {
    if (errorField) errorField.hidden = true;
    await callback();
  } catch (error) {
    if (errorField) {
      errorField.textContent = error.message;
      errorField.hidden = false;
    } else if (signedIn) notice(error.message, true);
  } finally { submit.disabled = false; if (signedIn) updateState(); }
}

async function enqueue(spec) {
  await api('/api/jobs', { method: 'POST', body: spec });
  openView('queue');
  notice(spec.dryRun ? '筛选任务已排队，不会下载图片。' : '已加入下载队列。');
  await refresh();
}

$('login-form').addEventListener('submit', event => {
  event.preventDefault();
  formAction(event.currentTarget, async () => {
    await api('/api/login', { method: 'POST', guest: true, body: { password: $('login-password').value } });
    $('login-password').value = '';
    showSession(true);
    await refresh();
  }, $('login-error'));
});
$('logout-button').addEventListener('click', async () => {
  try { await api('/api/logout', { method: 'POST', body: {} }); showSession(false); $('login-password').focus(); }
  catch (error) { if (signedIn) notice(error.message, true); }
});
$('job-type').addEventListener('change', setForm);
$('job-dry').addEventListener('change', setForm);
$('job-form').addEventListener('submit', event => {
  event.preventDefault();
  formAction(event.currentTarget, () => enqueue({ type: $('job-type').value, values: $('job-values').value, scope: $('job-scope').value, dryRun: $('job-dry').checked }));
});
$('scan-button').addEventListener('click', async () => {
  $('scan-button').disabled = true;
  try {
    await api('/api/library/scan', { method: 'POST', body: {} });
    openView('queue');
    notice('扫描任务已排队。');
    await refresh();
  } catch (error) { if (signedIn) notice(error.message, true); }
  finally { updateState(); }
});
$('import-form').addEventListener('submit', event => {
  event.preventDefault();
  formAction(event.currentTarget, async () => {
    const file = $('manifest-file').files[0];
    if (!file || !file.name.toLowerCase().endsWith('.json')) throw new Error('请选择导出的 JSON 索引。');
    if (file.size > 32 * 1024 * 1024) throw new Error('索引超过 32 MiB，请拆成多个目录分别导出。');
    const { source } = await api(`/api/library/import?name=${encodeURIComponent(file.name)}`, { method: 'POST', file });
    $('import-form').reset();
    await refreshLibrary();
    notice(`已导入索引：${number.format(source.count)} 条记录。`);
  });
});
async function proxyAction(work) {
  if (proxyPending) return;
  const result = $('proxy-result');
  proxyPending = true;
  updateState();
  result.textContent = '正在处理…';
  result.hidden = false;
  try { result.textContent = await work(); }
  catch (error) { result.textContent = error.message; }
  finally { proxyPending = false; if (signedIn) updateState(); }
}

$('proxy-form').addEventListener('submit', event => {
  event.preventDefault();
  proxyAction(async () => {
    const url = $('proxy-url').value.trim();
    if (!url) throw new Error('请输入代理地址或 disable。');
    status.proxy = await api('/api/proxy', { method: 'POST', body: { url } });
    $('proxy-form').reset();
    return url === 'disable' ? '已关闭代理，改用直连。' : '代理已保存。';
  });
});
$('test-proxy').addEventListener('click', () => proxyAction(async () => {
  const url = $('proxy-url').value.trim();
  const { checks } = await api('/api/proxy/test', { method: 'POST', body: url ? { url } : {} });
  return checks.map(item => `${item.label}：${item.reachable ? '已连通' : '未连通'}`).join('；');
}));
$('remove-proxy').addEventListener('click', () => proxyAction(async () => {
  status.proxy = await api('/api/proxy', { method: 'DELETE' });
  $('proxy-form').reset();
  return '已恢复系统代理设置。';
}));

$('pixiv-form').addEventListener('submit', event => {
  event.preventDefault();
  formAction(event.currentTarget, async () => {
    status.pixiv = await api('/api/pixiv', { method: 'POST', body: { token: $('pixiv-token').value } });
    $('pixiv-form').reset();
    notice('Pixiv 凭据已验证并保存。');
  });
});
$('remove-token').addEventListener('click', async () => {
  try {
    status.pixiv = await api('/api/pixiv', { method: 'DELETE' });
    $('pixiv-form').reset();
    updateState();
    notice('已清除 Pixiv 凭据。');
  } catch (error) { if (signedIn) notice(error.message, true); }
});

window.addEventListener('hashchange', route);
setInterval(() => {
  if (signedIn && !document.hidden) refresh().catch(error => { if (signedIn) notice(error.message, true); });
}, 3000);
api('/api/session', { guest: true }).then(async session => {
  showSession(session.authenticated);
  if (session.authenticated) await refresh();
}).catch(error => {
  $('login-error').textContent = error.message;
  $('login-error').hidden = false;
});
