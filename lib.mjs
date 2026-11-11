// Shared storage for UI Comments, used by the server and the CLI.
// Everything lives in DATA_DIR, outside every project, so nothing here can reach a repo.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

export const VERSION = 1;
export const PORT = Number(process.env.UI_COMMENTS_PORT) || 7717;
export const HOST = '127.0.0.1';
export const BASE_URL = `http://${HOST}:${PORT}`;
export const DATA_DIR = process.env.UI_COMMENTS_HOME || path.join(os.homedir(), '.claude', 'ui-comments');

const WIN = process.platform === 'win32';
const sleepSync = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const now = () => new Date().toISOString();

export function readJson(file, fallback) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return fallback; throw e; }
  try { return JSON.parse(raw); } catch { throw new Error(`${file} is not valid JSON. Fix or remove it.`); }
}

// Write to a temp file and rename over the target, so a reader never sees half a file.
export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n');
  for (let i = 0; ; i++) {
    try { fs.renameSync(tmp, file); return; } catch (e) {
      if (i >= 8 || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) { try { fs.unlinkSync(tmp); } catch {} throw e; }
      sleepSync(25 * (i + 1)); // Windows: the file may be open in another process for a moment
    }
  }
}

/* ---------- config (the bookmarklet's token) ---------- */

const configFile = () => path.join(DATA_DIR, 'config.json');

export function getConfig() {
  let cfg = readJson(configFile(), null);
  if (!cfg || !cfg.token) {
    cfg = { token: crypto.randomBytes(18).toString('hex'), createdAt: now() };
    writeJson(configFile(), cfg);
  }
  return cfg;
}

export function saveConfig(cfg) { writeJson(configFile(), cfg); }

/* ---------- projects ---------- */

const projectsFile = () => path.join(DATA_DIR, 'projects.json');

export function normPath(p) {
  let s = path.resolve(p).replace(/\\/g, '/').replace(/^([a-z]):/, (m, d) => d.toUpperCase() + ':');
  if (s.length > 3) s = s.replace(/\/+$/, '');
  return s;
}
const fold = s => (WIN ? s.toLowerCase() : s);
const isInside = (child, parent) => fold(child) === fold(parent) || fold(child).startsWith(fold(parent) + '/');

export function loadProjects() {
  const d = readJson(projectsFile(), {});
  return { active: d.active || null, projects: d.projects || [] };
}

export function saveProjects(d) { writeJson(projectsFile(), d); }

// Adds the folder as a project (or finds it) and makes it the one new comments go to.
export function registerProject(dir, name) {
  const d = loadProjects();
  const p = normPath(dir);
  let proj = d.projects.find(x => fold(x.path) === fold(p));
  if (!proj) {
    const label = name || path.basename(p);
    const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'project';
    const hash = crypto.createHash('sha1').update(fold(p)).digest('hex').slice(0, 6);
    proj = { id: `${slug}-${hash}`, name: label, path: p, createdAt: now() };
    d.projects.push(proj);
  } else {
    proj.path = p;
    if (name) proj.name = name;
  }
  d.active = proj.id;
  saveProjects(d);
  return proj;
}

export function setActive(id) {
  const d = loadProjects();
  if (!d.projects.some(x => x.id === id)) throw Object.assign(new Error('Unknown project'), { status: 404 });
  d.active = id;
  saveProjects(d);
}

export const getProject = id => loadProjects().projects.find(x => x.id === id) || null;

export function activeProject() {
  const d = loadProjects();
  return d.projects.find(x => x.id === d.active) || null;
}

// The registered project that contains this folder (the deepest one, if they nest).
export function findProjectForDir(dir) {
  const p = normPath(dir);
  return loadProjects().projects
    .filter(x => isInside(p, x.path))
    .sort((a, b) => b.path.length - a.path.length)[0] || null;
}

/* ---------- comments ---------- */

const commentsFile = id => path.join(DATA_DIR, 'projects', id, 'comments.json');

export function loadComments(id) {
  const d = readJson(commentsFile(id), null);
  return d && Array.isArray(d.comments) ? d : { next: 1, comments: [] };
}

export function saveComments(id, d) { writeJson(commentsFile(id), d); }

const cleanText = (s, max = 5000) => String(s == null ? '' : s).replace(/\r\n/g, '\n').trim().slice(0, max);

export function addComment(id, input) {
  const d = loadComments(id);
  const at = now();
  const c = {
    id: 'c_' + crypto.randomBytes(5).toString('hex'),
    n: d.next++,
    status: 'open',
    text: cleanText(input.text),
    createdAt: at,
    updatedAt: at,
    kind: input.kind === 'region' ? 'region' : 'point',
    page: input.page || {},
    target: input.target || {},
    clicked: input.clicked || null,
    anchor: input.anchor || null,
    region: input.region || null,
    pagePoint: input.pagePoint || null,
    // Style changes the user previewed live in Edit mode: [{ prop, from, to }].
    changes: Array.isArray(input.changes) && input.changes.length
      ? input.changes.slice(0, 60).map(x => ({ prop: String(x.prop).slice(0, 80), from: String(x.from).slice(0, 300), to: String(x.to).slice(0, 300) }))
      : null,
    similar: Math.max(0, Math.floor(Number(input.similar) || 0)),
    // Set by the server, never the page: the address another computer opened the app at.
    from: input.from && input.from.host ? { host: String(input.from.host).slice(0, 200) } : null,
    replies: [],
  };
  d.comments.push(c);
  saveComments(id, d);
  return c;
}

export function findComment(d, ref) {
  const s = String(ref).replace(/^#/, '');
  return d.comments.find(c => c.id === s || String(c.n) === s) || null;
}

export function updateComment(id, ref, fn) {
  const d = loadComments(id);
  const c = findComment(d, ref);
  if (!c) return null;
  fn(c);
  c.updatedAt = now();
  saveComments(id, d);
  return c;
}

export function deleteComment(id, ref) {
  const d = loadComments(id);
  const c = findComment(d, ref);
  if (!c) return false;
  d.comments = d.comments.filter(x => x !== c);
  saveComments(id, d);
  return true;
}

/* ---------- before and after pictures (compare a change, then choose) ---------- */

// Pictures of the commented element before and after Claude changed it, so the user can compare on the
// pin and pick one. Stored beside the comments, never in the project.
const SHOT_KINDS = ['before', 'after'];
export const shotFile = (id, commentId, which) => path.join(DATA_DIR, 'projects', id, 'shots', `${commentId}-${which}.png`);

export function attachShot(id, ref, which, src) {
  if (!SHOT_KINDS.includes(which)) throw new Error(`Picture must be ${SHOT_KINDS.join(' or ')}`);
  const d = loadComments(id);
  const c = findComment(d, ref);
  if (!c) return null;
  const file = shotFile(id, c.id, which);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.copyFileSync(src, file);
  c.compare = { ...(c.compare || {}), [which]: now() };
  c.updatedAt = now();
  saveComments(id, d);
  return c;
}

export function readShot(id, commentId, which) {
  if (!SHOT_KINDS.includes(which) || !/^[\w-]+$/.test(commentId)) return null;
  try { return fs.readFileSync(shotFile(id, commentId, which)); } catch { return null; }
}

// The user's final call on a change: keep the new design, or bring back the previous one.
export const CHOICES = { new: 'Keep the new design', previous: 'Bring back the previous design' };

export function addReply(c, by, text) {
  const t = cleanText(text);
  if (!t) throw Object.assign(new Error('Empty reply'), { status: 400 });
  (c.replies ||= []).push({ by, text: t, at: now() });
}

export { cleanText, now };
