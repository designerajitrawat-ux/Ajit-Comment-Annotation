#!/usr/bin/env node
// UI Comments command line. Claude uses it to set projects up and to read and resolve comments.
//
//   register [folder] [--name N]  register the folder (default: here) as a project (Vite projects)
//   start [folder] [--name N]   register the folder (default: here) as a project, make it the one
//                               comments go to, and start the server if it is not running
//   list [--all] [--json]       open comments for this project (--all includes resolved)
//   show <n> [--json]           one comment in full
//   resolve <n...> [--note T]   mark done, with a note on what changed (shown on the pin)
//   ask <n> --note T            reply with a question; the pin turns amber until answered
//   reopen <n>                  mark open again
//   delete <n>                  remove a comment
//   attach <n> [--before F] [--after F]  pictures of the element before and after a change,
//                               which the user compares on the pin before choosing one
//   decisions                   comments the user has chosen new or previous on
//   export --out F.html         the whole comment history, with pictures and decisions, as one page
//   status | projects | open | stop
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as S from './lib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const [cmd = 'help', ...rest] = process.argv.slice(2);
const flags = {};
const args = [];
for (let i = 0; i < rest.length; i++) {
  const a = rest[i];
  if (a.startsWith('--')) {
    const k = a.slice(2);
    flags[k] = rest[i + 1] !== undefined && !rest[i + 1].startsWith('--') ? rest[++i] : true;
  } else args.push(a);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const fail = msg => { console.error(msg); process.exit(1); };

async function health() {
  try {
    const r = await fetch(S.BASE_URL + '/api/health', { signal: AbortSignal.timeout(1000) });
    const j = await r.json();
    return j.app === 'ui-comments' ? j : { foreign: true };
  } catch { return null; }
}

async function stopServer() {
  const token = S.getConfig().token;
  try {
    await fetch(S.BASE_URL + '/api/shutdown', { method: 'POST', headers: { 'x-ui-comments-token': token }, signal: AbortSignal.timeout(1500) });
  } catch {}
  for (let i = 0; i < 20; i++) { if (!(await health())) return; await sleep(100); }
}

async function ensureServer() {
  let h = await health();
  if (h && h.foreign) fail(`Port ${S.PORT} is used by another program. Set UI_COMMENTS_PORT to a free port.`);
  if (h && h.version !== S.VERSION) { await stopServer(); h = null; }
  if (h) return false;
  S.getConfig(); // create the token before the server needs it
  const child = spawn(process.execPath, [path.join(HERE, 'server.mjs')], { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
  for (let i = 0; i < 50; i++) { await sleep(100); if (await health()) return true; }
  fail(`The server did not start. See ${path.join(S.DATA_DIR, 'server.log')}`);
}

function projectHere() {
  if (flags.project) {
    const p = S.findProjectForDir(flags.project) || S.getProject(flags.project);
    if (!p) fail(`No UI Comments project matches "${flags.project}".`);
    return p;
  }
  const p = S.findProjectForDir(process.cwd());
  if (p) return p;
  const known = S.loadProjects().projects.map(x => `  ${x.name}: ${x.path}`).join('\n');
  fail(`No UI Comments project covers ${S.normPath(process.cwd())}.\nRun: node "${path.join(HERE, 'cli.mjs')}" start` +
    (known ? `\nRegistered projects:\n${known}` : ''));
}

function openBrowser(url) {
  const [bin, argv] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
    : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  spawn(bin, argv, { detached: true, stdio: 'ignore', windowsHide: true }).unref();
}

/* ---------- formatting for Claude ---------- */

const STATUS = { open: 'open', question: 'waiting for the user to answer', resolved: 'resolved' };

function rel(file, proj) {
  if (!file) return '';
  let f = String(file).replace(/\\/g, '/').replace(/^\/@fs\//, '');
  const base = proj.path.replace(/\\/g, '/');
  if (f.toLowerCase().startsWith(base.toLowerCase() + '/')) f = f.slice(base.length + 1);
  return f;
}
const loc = (s, proj) => `${rel(s.file, proj)}${s.line ? ':' + s.line : ''}${s.approx ? ' (approximate line)' : ''}`;
const pct = v => Math.round(v * 100) + '%';
const when = iso => new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

function format(c, proj) {
  const L = [];
  const p = c.page || {}, t = c.target || {};
  L.push(`## #${c.n}  (${STATUS[c.status] || c.status}, ${when(c.createdAt)})`);
  for (const line of String(c.text).split('\n')) L.push('> ' + line);
  L.push('');
  if (c.from) L.push(`- Sent from another computer, through ${c.from.host} (a reviewer with the shared link)`);
  if (c.changes && c.changes.length) {
    L.push(`- Changes the user tried live in Edit mode and liked (from > to)${c.similar ? `, previewed on this element and its ${c.similar} look-alike${c.similar > 1 ? 's' : ''} (same tag and classes)` : ''}:`);
    for (const x of c.changes) L.push(`  - ${x.prop}: ${x.from} > ${x.to}`);
  }
  const vp = p.viewport ? `viewport ${p.viewport.w}x${p.viewport.h}; the computer's colour preference is ${p.scheme || 'light'}` : '';
  L.push(`- Page: ${[p.heading || p.title, p.href].filter(Boolean).join('  ')}${vp ? `  (${vp})` : ''}`);
  if (t.section) L.push(`- Section: <${t.section.tag}${t.section.role ? ` role="${t.section.role}"` : ''}> "${t.section.label}"`);
  L.push(`- Element: ${t.html || '<' + t.tag + '>'}`);
  if (t.text) L.push(`- Text inside: "${t.text}"`);
  const src = t.source;
  if (src && src.element) L.push(`- Code: this element's markup is at ${loc(src.element, proj)}`);
  if (src && src.components && src.components.length) {
    L.push(`- Rendered by (${src.framework}): ` + src.components.map(x => x.source ? `${x.name} (used at ${loc(x.source, proj)})` : x.name).join(' < '));
  }
  if (src && src.contains) {
    const k = src.contains;
    const chain = (k.components || []).map(x => x.source ? `${x.name} (used at ${loc(x.source, proj)})` : x.name).join(' < ');
    L.push(`- Code: this element sits outside the app's components (a root or layout container). The first thing inside it is <${k.label}>` +
      (k.element ? ` at ${loc(k.element, proj)}` : '') + (chain ? `, rendered by ${chain}` : ''));
  }
  if (!src) L.push('- Code: no framework info on the page (production build or plain HTML); search by the classes and text above');
  if (t.rect) L.push(`- Box: ${t.rect.w}x${t.rect.h}px, at x ${t.rect.x}, y ${t.rect.y} in the viewport`);
  if (t.styles && Object.keys(t.styles).length) L.push('- Computed styles: ' + Object.entries(t.styles).map(([k, v]) => `${k}: ${v}`).join('; '));
  if (t.context && Object.keys(t.context).length) L.push('- Context attributes: ' + Object.entries(t.context).map(([k, v]) => `${k}="${v}"`).join(' '));
  if (p.htmlClass) L.push(`- <html class="${p.htmlClass}">`);
  if (c.kind === 'region' && c.region) {
    L.push(`- Area: the user dragged a ${c.region.px ? `${c.region.px.w}x${c.region.px.h}px ` : ''}box starting ${pct(c.region.x)} across and ${pct(c.region.y)} down this element`);
    const covers = c.region.covers || [];
    if (covers.length) {
      L.push('- The area covers:');
      for (const x of covers) L.push(`  - ${x.html}${x.text ? ` "${x.text}"` : ''}${x.source ? `  (${loc(x.source, proj)})` : ''}`);
    } else {
      L.push('- The area covers no elements of its own: it is empty space inside this element (think margins, padding, gaps)');
    }
  } else if (c.anchor) {
    L.push(`- Pin: ${pct(c.anchor.ox)} across, ${pct(c.anchor.oy)} down this element`);
  }
  if (c.clicked) {
    const what = `${c.clicked.html || '<' + c.clicked.tag + '>'} "${c.clicked.text}"`;
    L.push(c.kind === 'region'
      ? `- Element at the centre of the area: ${what}`
      : `- First clicked: ${what} (the user then widened the comment to the element above on purpose)`);
  }
  L.push(`- Selector: ${t.selector}`);
  if (t.path) L.push(`- DOM path: ${t.path}`);
  if (c.compare) L.push(`- Before and after pictures: ${['before', 'after'].filter(k => c.compare[k]).join(' and ') || 'none'}`);
  if (c.decision) L.push(`- User's decision after comparing: ${S.CHOICES[c.decision.choice]} (${when(c.decision.at)})${c.decision.choice === 'previous' ? '. Restore the previous design.' : ''}`);
  if (c.replies && c.replies.length) {
    L.push('- Thread:');
    for (const r of c.replies) L.push(`  - ${r.by === 'claude' ? 'Claude' : r.by === 'reviewer' ? 'Reviewer on another computer' : 'User'} (${when(r.at)}): ${r.text}`);
  }
  return L.join('\n');
}

function counts(cs) {
  const n = s => cs.filter(c => c.status === s).length;
  return `${n('open')} open, ${n('question')} waiting for the user, ${n('resolved')} resolved`;
}

/* ---------- commands ---------- */

function update(proj, refs, fn) {
  if (!refs.length) fail('Which comment? Give its number, like: resolve 3');
  for (const ref of refs) {
    const c = S.updateComment(proj.id, ref, fn);
    if (!c) fail(`No comment #${String(ref).replace(/^#/, '')} in ${proj.name}.`);
    console.log(`#${c.n} is now ${STATUS[c.status]}.`);
  }
}

switch (cmd) {
  case 'register': {
    const proj = S.registerProject(args[0] || process.cwd(), typeof flags.name === 'string' ? flags.name : undefined);
    console.log(`Project: ${proj.name} (${proj.path}). Comments: ${counts(S.loadComments(proj.id).comments)}`);
    break;
  }
  case 'start': {
    const proj = S.registerProject(args[0] || process.cwd(), typeof flags.name === 'string' ? flags.name : undefined);
    const started = await ensureServer();
    const cs = S.loadComments(proj.id).comments;
    console.log(`UI Comments server ${started ? 'started' : 'already running'} at ${S.BASE_URL}`);
    console.log(`Project: ${proj.name} (${proj.path}). New comments go here.`);
    console.log(`Comments: ${counts(cs)}`);
    if (!S.getConfig().installPageSeenAt) {
      console.log(`FIRST_RUN: the Comment bookmark is not installed yet. Open ${S.BASE_URL} (cli.mjs open) and drag the Comment button to the bookmarks bar.`);
    }
    break;
  }
  case 'list': {
    const proj = projectHere();
    const all = S.loadComments(proj.id).comments;
    const cs = flags.all ? all : all.filter(c => c.status !== 'resolved');
    if (flags.json) { console.log(JSON.stringify(cs, null, 2)); break; }
    console.log(`# UI comments for ${proj.name}\nProject folder: ${proj.path}\n${counts(all)}\n`);
    if (!cs.length) console.log(flags.all ? 'No comments yet.' : 'No open comments.');
    for (const c of cs) console.log(format(c, proj) + '\n');
    break;
  }
  case 'show': {
    const proj = projectHere();
    const c = S.findComment(S.loadComments(proj.id), args[0] || '');
    if (!c) fail(`No comment #${args[0]} in ${proj.name}.`);
    console.log(flags.json ? JSON.stringify(c, null, 2) : format(c, proj));
    break;
  }
  case 'resolve': {
    const proj = projectHere();
    update(proj, args, c => {
      c.status = 'resolved'; c.resolvedAt = S.now(); c.resolvedBy = 'claude';
      if (typeof flags.note === 'string') S.addReply(c, 'claude', flags.note);
    });
    break;
  }
  case 'ask': {
    const proj = projectHere();
    if (typeof flags.note !== 'string') fail('ask needs --note "your question"');
    update(proj, args.slice(0, 1), c => { c.status = 'question'; S.addReply(c, 'claude', flags.note); });
    break;
  }
  case 'reopen': {
    const proj = projectHere();
    update(proj, args, c => { c.status = 'open'; });
    break;
  }
  case 'delete': {
    const proj = projectHere();
    for (const ref of args) console.log(S.deleteComment(proj.id, ref) ? `Deleted #${ref}.` : `No comment #${ref}.`);
    break;
  }
  case 'attach': {
    const proj = projectHere();
    if (!args[0] || (typeof flags.before !== 'string' && typeof flags.after !== 'string')) fail('attach needs a comment number and --before and/or --after with a PNG file');
    for (const which of ['before', 'after']) {
      if (typeof flags[which] !== 'string') continue;
      const c = S.attachShot(proj.id, args[0], which, path.resolve(flags[which]));
      if (!c) fail(`No comment #${args[0]} in ${proj.name}.`);
      console.log(`#${c.n}: ${which} picture attached.`);
    }
    break;
  }
  case 'decisions': {
    const proj = projectHere();
    const cs = S.loadComments(proj.id).comments.filter(c => c.decision);
    if (!cs.length) console.log('No decisions yet.');
    for (const c of cs) console.log(`#${c.n}  ${S.CHOICES[c.decision.choice]}  (${when(c.decision.at)})  ${String(c.text).slice(0, 90)}`);
    break;
  }
  case 'export': {
    const proj = projectHere();
    if (typeof flags.out !== 'string') fail('export needs --out file.html');
    const fs = await import('node:fs');
    const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]);
    const img = (c, which) => { const b = S.readShot(proj.id, c.id, which); return b ? `<figure><figcaption>${which === 'before' ? 'Before' : 'After'}</figcaption><img src="data:image/png;base64,${b.toString('base64')}" alt=""></figure>` : '' };
    const cs = S.loadComments(proj.id).comments.slice().sort((a, b) => a.n - b.n);
    const rows = cs.map(c => `<article><h2>#${c.n} <span class="st ${c.status}">${esc(STATUS[c.status])}</span>${c.decision ? ` <span class="dec ${c.decision.choice}">${esc(S.CHOICES[c.decision.choice])}</span>` : ''}</h2>
      <p class="meta">${esc(when(c.createdAt))} · ${esc((c.page && (c.page.heading || c.page.title)) || '')} · ${esc(c.page && c.page.key)}${c.from ? ' · reviewer' : ''}</p>
      <blockquote>${esc(c.text)}</blockquote>
      ${(c.replies || []).map(r => `<p class="reply"><b>${r.by === 'claude' ? 'Claude' : r.by === 'reviewer' ? 'Reviewer' : 'You'}</b> ${esc(when(r.at))}: ${esc(r.text)}</p>`).join('')}
      ${c.compare ? `<div class="shots">${img(c, 'before')}${img(c, 'after')}</div>` : ''}</article>`).join('\n');
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(proj.name)} comment history</title>
<style>body{margin:0;background:#f5f5f7;color:#1b1b1f;font:14px/1.5 system-ui,sans-serif}main{max-width:960px;margin:0 auto;padding:32px 16px}h1{margin:0 0 4px}article{background:#fff;border:1px solid #e4e4ea;border-radius:12px;padding:16px 18px;margin:14px 0}h2{font-size:16px;margin:0 0 4px;display:flex;gap:8px;align-items:center;flex-wrap:wrap}.meta{color:#6b6b76;font-size:12px;margin:0 0 8px}blockquote{margin:0 0 8px;padding:8px 12px;background:#f5f5f7;border-radius:8px}.reply{margin:4px 0;color:#3a3a44}.st,.dec{font-size:11px;font-weight:600;padding:2px 8px;border-radius:999px;background:#ececf1}.st.resolved{background:#e8f6ee;color:#16683b}.st.question{background:#fff3d6;color:#8a5a00}.dec.new{background:#e5f0ff;color:#1d4fb8}.dec.previous{background:#fde8ee;color:#a3204e}.shots{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:10px}figure{margin:0}figcaption{font-size:12px;color:#6b6b76;margin-bottom:4px}img{max-width:100%;border:1px solid #e4e4ea;border-radius:8px}</style></head>
<body><main><h1>${esc(proj.name)}: comment history</h1><p class="meta">${esc(counts(cs))} · exported ${esc(when(S.now()))}</p>${rows}</main></body></html>`;
    fs.writeFileSync(path.resolve(flags.out), html);
    console.log(`Wrote ${cs.length} comments to ${path.resolve(flags.out)}`);
    break;
  }
  case 'status': {
    const h = await health();
    console.log(h && !h.foreign ? `Server running at ${S.BASE_URL} (pid ${h.pid}, version ${h.version})` : 'Server not running.');
    const d = S.loadProjects();
    for (const p of d.projects) console.log(`${p.id === d.active ? '* ' : '  '}${p.name}: ${counts(S.loadComments(p.id).comments)}  (${p.path})`);
    console.log(`Data folder: ${S.DATA_DIR}`);
    break;
  }
  case 'projects': {
    const d = S.loadProjects();
    for (const p of d.projects) console.log(`${p.id === d.active ? '* ' : '  '}${p.id}  ${p.name}  ${p.path}`);
    break;
  }
  case 'open': {
    if (!(await health())) await ensureServer();
    openBrowser(S.BASE_URL);
    console.log(`Opened ${S.BASE_URL}`);
    break;
  }
  case 'stop': {
    await stopServer();
    console.log('Server stopped.');
    break;
  }
  default: {
    const head = (await import('node:fs')).readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 13);
    console.log(head.map(l => l.replace(/^\/\/ ?/, '')).join('\n'));
  }
}
