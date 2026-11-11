// The comment API, shared by the standalone server (server.mjs) and the Vite plugin (vite-plugin.mjs).
import * as S from './lib.mjs';

const MAX_BODY = 512 * 1024;

export function send(res, status, body, headers = {}) {
  if (Buffer.isBuffer(body)) {
    res.writeHead(status, { 'content-type': 'image/png', 'cache-control': 'no-store', ...headers });
    return res.end(body);
  }
  const text = typeof body === 'string';
  res.writeHead(status, {
    'content-type': text ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(text ? body : JSON.stringify(body));
}

export function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > MAX_BODY) { reject(Object.assign(new Error('Comment is too large'), { status: 413 })); req.destroy(); }
      else chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(Object.assign(new Error('Bad JSON'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

const fail = (status, message) => Object.assign(new Error(message), { status });

// route is the path after ".../api", such as "/state" or "/comments/c_123".
// With `project` set (the Vite plugin), every request belongs to that project; without it
// (the standalone server), the project is the active one or the one the request names.
// `from` is set when the request came from another computer (a shared or network link): its comments
// and replies are marked as a reviewer's, and it can't delete comments.
export async function handleApi(req, route, params, { project, from = null } = {}) {
  const m = req.method;
  const pick = id => {
    if (project) return project;
    const p = S.getProject(id);
    if (!p) throw fail(404, 'Unknown project. Reload the page.');
    return p;
  };

  if (route === '/state' && m === 'GET') {
    const d = S.loadProjects();
    const proj = project || d.projects.find(x => x.id === d.active) || null;
    return [200, {
      projects: (project ? [project] : d.projects).map(({ id, name, path }) => ({ id, name, path })),
      projectId: proj ? proj.id : null,
      projectName: proj ? proj.name : '',
      fixed: !!project,
      remote: !!from,
      comments: proj ? S.loadComments(proj.id).comments : [],
    }];
  }

  if (route === '/active' && m === 'POST') {
    if (project) throw fail(400, 'This dev server always uses its own project');
    const b = await readBody(req);
    S.setActive(String(b.projectId || ''));
    return [200, { ok: true }];
  }

  if (route === '/comments' && m === 'POST') {
    const b = await readBody(req);
    const proj = pick(b.project);
    if (!S.cleanText(b.text)) throw fail(400, 'Write something first');
    return [201, S.addComment(proj.id, { ...b, from })];
  }

  const shot = route.match(/^\/comments\/([\w-]+)\/shot\/(before|after)$/);
  if (shot && m === 'GET') {
    const proj = pick(params.get('project'));
    const img = S.readShot(proj.id, shot[1], shot[2]);
    return img ? [200, img] : [404, { error: 'No picture' }];
  }

  const one = route.match(/^\/comments\/([\w-]+)$/);
  if (one && m === 'PATCH') {
    const b = await readBody(req);
    const proj = pick(b.project);
    const c = S.updateComment(proj.id, one[1], c => {
      const by = from ? 'reviewer' : 'you';
      if (b.action === 'resolve') { c.status = 'resolved'; c.resolvedAt = S.now(); c.resolvedBy = by; }
      else if (b.action === 'reopen') { c.status = 'open'; }
      else if (b.action === 'reply') { S.addReply(c, by, b.text); if (c.status === 'question') c.status = 'open'; }
      // The final call after comparing before and after; the latest choice wins, and the thread keeps a record.
      else if (b.action === 'decide') {
        if (!S.CHOICES[b.choice]) throw fail(400, 'Choose new or previous');
        c.decision = { choice: b.choice, at: S.now(), by };
        S.addReply(c, by, S.CHOICES[b.choice] + '.');
      }
      else throw fail(400, 'Unknown action');
    });
    return c ? [200, c] : [404, { error: 'Comment not found' }];
  }
  if (one && m === 'DELETE') {
    if (from) throw fail(403, 'Comments can be deleted only on the computer that runs the app. Resolve it instead.');
    const proj = pick(params.get('project'));
    return S.deleteComment(proj.id, one[1]) ? [200, { ok: true }] : [404, { error: 'Comment not found' }];
  }

  return [404, { error: 'Not found' }];
}
