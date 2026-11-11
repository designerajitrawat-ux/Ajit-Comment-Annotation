#!/usr/bin/env node
// UI Comments server: serves the overlay script and stores comments for Claude to read.
// Listens on 127.0.0.1 only. Started by `cli.mjs start`; data lives in DATA_DIR (lib.mjs).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as S from './lib.mjs';
import { handleApi, send } from './handlers.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OVERLAY = path.join(HERE, 'overlay.js');
// Rejecting other Host headers stops a DNS-rebinding page from reading the token off "/".
const ALLOWED_HOSTS = new Set([`127.0.0.1:${S.PORT}`, `localhost:${S.PORT}`]);

function log(...parts) {
  try {
    fs.mkdirSync(S.DATA_DIR, { recursive: true });
    fs.appendFileSync(path.join(S.DATA_DIR, 'server.log'), `[${S.now()}] ${parts.join(' ')}\n`);
  } catch {}
}

const esc = s => String(s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);

async function api(req, url) {
  if (url.pathname === '/api/shutdown' && req.method === 'POST') {
    log('shutdown requested');
    setTimeout(() => process.exit(0), 50);
    return [200, { ok: true }];
  }
  return handleApi(req, url.pathname.slice(4), url.searchParams);
}

function installPage() {
  const cfg = S.getConfig();
  if (!cfg.installPageSeenAt) { cfg.installPageSeenAt = S.now(); S.saveConfig(cfg); }
  const loader = "(function(){if(window.__uiComments){window.__uiComments.toggle();return;}" +
    "var s=document.createElement('script');" +
    `s.src='${S.BASE_URL}/overlay.js?t=${cfg.token}&_='+Date.now();` +
    "s.onerror=function(){alert('UI Comments could not load. Either the comment server is not running (ask Claude to start it), or this page blocks outside scripts.');};" +
    '(document.head||document.documentElement).appendChild(s);})();';
  const href = 'javascript:' + encodeURIComponent(loader);
  const d = S.loadProjects();
  const rows = d.projects.map(p => {
    const cs = S.loadComments(p.id).comments;
    const n = s => cs.filter(c => c.status === s).length;
    const active = p.id === d.active;
    return `<tr><td>${esc(p.name)}${active ? ' <span class="tag">comments go here</span>' : ''}</td>` +
      `<td class="path">${esc(p.path)}</td><td>${n('open')}</td><td>${n('question')}</td><td>${n('resolved')}</td></tr>`;
  }).join('');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>UI Comments</title>
<style>
  :root { --ink: #1e1e1e; --muted: #6f6f6f; --rule: #e8e8e8; --blue: #0d99ff; --bg: #fafafa; --card: #fff; }
  @media (prefers-color-scheme: dark) { :root { --ink: #ededed; --muted: #a3a3a3; --rule: #333; --bg: #161616; --card: #1f1f1f; } }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--ink); font: 15px/1.55 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  main { max-width: 760px; margin: 0 auto; padding: 48px 20px 64px; }
  h1 { font-size: 26px; margin: 0 0 4px; }
  .lede { color: var(--muted); margin: 0 0 32px; }
  .step { background: var(--card); border: 1px solid var(--rule); border-radius: 14px; padding: 20px 22px; margin-bottom: 14px; }
  .step h2 { font-size: 15px; margin: 0 0 6px; }
  .step p { margin: 0; color: var(--muted); }
  .drag { display: inline-flex; align-items: center; gap: 8px; margin: 14px 0 8px; padding: 10px 16px; border-radius: 10px; background: #1e1e1e; color: #fff; text-decoration: none; font-weight: 600; cursor: grab; box-shadow: 0 4px 14px rgba(0,0,0,.18); }
  .drag svg { color: var(--blue); }
  kbd { font: 600 12px ui-monospace, Consolas, monospace; padding: 1px 6px; border: 1px solid var(--rule); border-bottom-width: 2px; border-radius: 5px; background: var(--card); }
  ul { margin: 8px 0 0; padding-left: 18px; color: var(--muted); }
  li { margin: 2px 0; }
  q { font-style: normal; color: var(--ink); font-weight: 600; }
  table { width: 100%; border-collapse: collapse; font-size: 14px; margin-top: 8px; }
  th, td { text-align: left; padding: 8px 6px; border-bottom: 1px solid var(--rule); vertical-align: top; }
  th { color: var(--muted); font-weight: 600; font-size: 12px; }
  td.path { color: var(--muted); font-size: 12px; word-break: break-all; }
  .tag { font-size: 11px; color: var(--blue); font-weight: 600; white-space: nowrap; }
  .wrap { overflow-x: auto; }
</style>
</head>
<body>
<main>
  <h1>UI Comments</h1>
  <p class="lede">Pin comments on your running app, the way you do in Figma. Claude reads them and makes the changes when you ask.</p>

  <section class="step">
    <h2>1. Drag this button to your bookmarks bar (once)</h2>
    <a class="drag" href="${esc(href)}" title="Drag me to the bookmarks bar"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M12 3.5a8.5 8.5 0 1 1-4.3 15.83L3.5 20.5l1.17-4.2A8.5 8.5 0 0 1 12 3.5Z"/></svg>Comment</a>
    <p>Bookmarks bar hidden? Press <kbd>Ctrl</kbd> + <kbd>Shift</kbd> + <kbd>B</kbd>.</p>
  </section>

  <section class="step">
    <h2>2. Comment on your app</h2>
    <p>Open your app in the browser and click the <b>Comment</b> bookmark. Then:</p>
    <ul>
      <li>Click a spot to comment on that element, or drag a box to comment on an area.</li>
      <li>Type your note and press <kbd>Enter</kbd> (<kbd>Shift</kbd> + <kbd>Enter</kbd> for a new line).</li>
      <li>The chips above the box let you widen the comment to a parent, such as the whole tab bar.</li>
      <li><kbd>C</kbd> turns comment mode on and off, so you can still use the app. <kbd>Esc</kbd> cancels.</li>
      <li>After a full page reload, click the bookmark again.</li>
    </ul>
  </section>

  <section class="step">
    <h2>3. Ask Claude</h2>
    <p>In Claude Code, in the same project, say <q>apply my comments</q>. Claude changes the code, then resolves each pin with a note on what it did. If something is unclear, the pin turns amber with Claude's question, and you can answer it right there.</p>
  </section>

  <section class="step">
    <h2>Projects</h2>
    <p>Comments go to the project you last started in Claude. You can switch in the toolbar.</p>
    <div class="wrap"><table>
      <thead><tr><th>Project</th><th>Folder</th><th>Open</th><th>Waiting on you</th><th>Resolved</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="5">None yet. In Claude, say: I want comment functionality in this project.</td></tr>'}</tbody>
    </table></div>
  </section>
</main>
</body>
</html>`;
}

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin;
  const cors = origin ? { 'access-control-allow-origin': origin, vary: 'Origin' } : {};
  try {
    if (!ALLOWED_HOSTS.has(req.headers.host)) return send(res, 403, 'Forbidden');
    const url = new URL(req.url, `http://${req.headers.host}`);
    const p = url.pathname;

    if (p === '/' && req.method === 'GET') return send(res, 200, installPage(), { 'content-type': 'text/html; charset=utf-8' });
    if (p === '/overlay.js' && req.method === 'GET') {
      return send(res, 200, fs.readFileSync(OVERLAY, 'utf8'), { 'content-type': 'application/javascript; charset=utf-8' });
    }
    if (!p.startsWith('/api/')) return send(res, 404, 'Not found');

    if (req.method === 'OPTIONS') {
      return send(res, 204, '', {
        ...cors,
        'access-control-allow-methods': 'GET, POST, PATCH, DELETE, OPTIONS',
        'access-control-allow-headers': 'content-type, x-ui-comments-token',
        'access-control-max-age': '600',
        ...(req.headers['access-control-request-private-network'] ? { 'access-control-allow-private-network': 'true' } : {}),
      });
    }
    if (p === '/api/health') return send(res, 200, { ok: true, app: 'ui-comments', version: S.VERSION, pid: process.pid }, cors);
    if (req.headers['x-ui-comments-token'] !== S.getConfig().token) return send(res, 401, { error: 'Bad token' }, cors);

    const [status, body] = await api(req, url);
    return send(res, status, body, cors);
  } catch (err) {
    if (!err.status) log('error', err.stack || err);
    return send(res, err.status || 500, { error: err.message || 'Server error' }, cors);
  }
});

server.on('error', err => {
  log('listen error', err.code || err.message);
  console.error(err.code === 'EADDRINUSE' ? `Port ${S.PORT} is already in use.` : err.message);
  process.exit(1);
});

server.listen(S.PORT, S.HOST, () => {
  log('started', `pid ${process.pid}`, `version ${S.VERSION}`, S.BASE_URL);
  console.log(`UI Comments running at ${S.BASE_URL}`);
});
