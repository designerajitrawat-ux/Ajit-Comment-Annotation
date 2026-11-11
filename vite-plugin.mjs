// UI Comments as a Vite plugin: while the project's dev server or preview server runs, every page it
// serves carries the comment toolbar, in any browser, and the server itself stores the comments (in
// DATA_DIR, outside the project). Nothing is ever written into a build: `apply: 'serve'` keeps the plugin
// out of `vite build`, and on a preview server the toolbar is added to each page as it is sent.
//
// In a project's vite.config.js:  plugins: [..., uiComments()]
// Option `project`: the project folder, if it is not the Vite root or a registered parent of it.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as S from './lib.mjs';
import { handleApi, send } from './handlers.mjs';

const OVERLAY = path.join(path.dirname(fileURLToPath(import.meta.url)), 'overlay.js');
const MOUNT = '/__ui-comments/';

// Tunnel services that give this server a public https address, so reviewers on other computers can
// open the app and pin comments that are stored here. Vite refuses host names it doesn't know.
const TUNNEL_HOSTS = ['.ngrok-free.app', '.ngrok-free.dev', '.ngrok.app', '.ngrok.dev', '.ngrok.io'];

const firstOf = v => String(v || '').split(',')[0].trim();

// Who sent a request: null for this computer, or { host } for another one, through the network or a
// tunnel. A tunnel connects from this computer but always adds x-forwarded-for, so that counts as remote.
function senderOf(req) {
  const fwd = req.headers['x-forwarded-for'];
  const ip = firstOf(fwd || (req.socket && req.socket.remoteAddress));
  if (!fwd && /^(::1$|127\.|::ffff:127\.)/.test(ip)) return null;
  return { host: firstOf(req.headers['x-forwarded-host'] || req.headers.host) };
}

export default function uiComments(options = {}) {
  let config = null;
  let project = null;

  function setUp(server, kind) {
    const dir = options.project ? path.resolve(config.root, options.project) : config.root;
    // The registered project that holds this app (for example the repo root above app/),
    // or the app's own folder, registered on first use.
    project = S.findProjectForDir(dir) || S.registerProject(dir);
    server.config.logger.info(`  UI Comments: on for this ${kind} server, comments go to "${project.name}"`, { timestamp: false });
  }

  const scriptTag = () => `<script src="${config.base}__ui-comments/overlay.js?auto=1"></script>`;

  async function api(req, res, next) {
    const at = req.url.indexOf(MOUNT);
    if (at < 0) return next();
    const url = new URL(req.url.slice(at + MOUNT.length - 1), 'http://dev');
    try {
      if (url.pathname === '/overlay.js') {
        return send(res, 200, fs.readFileSync(OVERLAY, 'utf8'), { 'content-type': 'application/javascript; charset=utf-8' });
      }
      if (!url.pathname.startsWith('/api/')) return send(res, 404, { error: 'Not found' });
      // Same origin only: a page on another site must not be able to write comments here. Behind a
      // tunnel that rewrites the host header, the page's own address arrives as x-forwarded-host.
      const origin = req.headers.origin;
      const hosts = [req.headers.host, req.headers['x-forwarded-host']].filter(Boolean).map(firstOf);
      if (origin && (origin === 'null' || !hosts.includes(new URL(origin).host))) return send(res, 403, { error: 'Forbidden' });
      if ((req.method === 'POST' || req.method === 'PATCH') && !String(req.headers['content-type']).includes('application/json')) {
        return send(res, 415, { error: 'JSON only' });
      }
      const current = S.getProject(project.id) || project;
      const [status, body] = await handleApi(req, url.pathname.slice(4), url.searchParams, { project: current, from: senderOf(req) });
      return send(res, status, body);
    } catch (err) {
      return send(res, err.status || 500, { error: err.message || 'Server error' });
    }
  }

  // Serves the HTML pages under `dir` with the toolbar added: the built app on a preview server, and
  // prebuilt pages in public/ (such as another app copied into public/v4) on a dev server, which
  // Vite's transformIndexHtml never sees. With `spa`, unknown page paths get index.html, as Vite does.
  function pages(dir, spa) {
    const root = path.resolve(dir);
    const inside = f => f.startsWith(root + path.sep) && fs.existsSync(f) && fs.statSync(f).isFile();
    return (req, res, next) => {
      if ((req.method !== 'GET' && req.method !== 'HEAD') || !String(req.headers.accept).includes('text/html')) return next();
      let u;
      try { u = new URL(req.url, 'http://dev'); } catch { return next(); }
      const pathname = decodeURIComponent(u.pathname);
      const rel = pathname.startsWith(config.base) ? pathname.slice(config.base.length) : pathname.replace(/^\/+/, '');
      let file = null;
      if (rel.endsWith('.html')) file = inside(path.resolve(root, rel)) ? path.resolve(root, rel) : null;
      else if (!path.extname(rel)) {
        const index = path.resolve(root, rel, 'index.html');
        if (inside(index)) {
          // A folder's page needs the trailing slash, or its relative links point one level up.
          if (rel && !pathname.endsWith('/')) { res.writeHead(301, { location: pathname + '/' + u.search }); return res.end(); }
          file = index;
        } else if (spa && inside(path.join(root, 'index.html'))) file = path.join(root, 'index.html');
      }
      if (!file) return next();
      let html = fs.readFileSync(file, 'utf8');
      html = /<\/body>/i.test(html) ? html.replace(/<\/body>/i, () => scriptTag() + '</body>') : html + scriptTag();
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
      return res.end(req.method === 'HEAD' ? undefined : html);
    };
  }

  return {
    name: 'ui-comments',
    apply: 'serve',
    // Let tunnel addresses through the host check, unless the project already allows every host.
    // Preview falls back to the server's list when it has none of its own.
    config(user) {
      const s = user.server && user.server.allowedHosts;
      const p = user.preview && user.preview.allowedHosts;
      return {
        server: s === true ? {} : { allowedHosts: TUNNEL_HOSTS },
        preview: (p ?? s) === true ? {} : { allowedHosts: p ? TUNNEL_HOSTS : [...(s || []), ...TUNNEL_HOSTS] },
      };
    },
    configResolved(resolved) { config = resolved; },
    configureServer(server) {
      setUp(server, 'dev');
      server.middlewares.use(api);
      if (config.publicDir) server.middlewares.use(pages(config.publicDir, false));
    },
    configurePreviewServer(server) {
      setUp(server, 'preview');
      server.middlewares.use(api);
      server.middlewares.use(pages(path.resolve(config.root, config.build.outDir), true));
    },
    transformIndexHtml() {
      return [{ tag: 'script', attrs: { src: `${config.base}__ui-comments/overlay.js?auto=1` }, injectTo: 'body' }];
    },
  };
}
