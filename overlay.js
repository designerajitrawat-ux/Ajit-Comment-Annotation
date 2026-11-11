/*
 * UI Comments overlay.
 * Loaded into a page by the "Comment" bookmarklet, from the local comment server (server.mjs).
 * Pins Figma-style comments to a spot or an area of the page. Each comment is saved with the
 * page, the element, its box and styles and, in React, Vue or Svelte dev builds, the source
 * file that renders it, so Claude can find exactly what to change.
 * All of the UI lives in a shadow root, so the page's styles and these never mix.
 */
(() => {
  'use strict';

  if (window.__uiComments) { window.__uiComments.toggle(); return; }

  const self = document.currentScript;
  const scriptUrl = new URL(self && self.src ? self.src : 'http://127.0.0.1:7717/overlay.js');
  const TOKEN = scriptUrl.searchParams.get('t') || '';
  // The API sits next to this script: /api on the comment server, /__ui-comments/api on a dev server.
  const API = new URL('api', scriptUrl).href;
  // Loaded by a dev server on every page (vite-plugin.mjs), rather than by a click on the bookmarklet.
  const AUTO = scriptUrl.searchParams.has('auto');
  if (self) self.remove();

  const PIN = 28;
  // Events we stop from reaching the page: all of them while commenting, and any that start in our UI.
  const STOP = ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click', 'dblclick', 'auxclick',
    'contextmenu', 'touchstart', 'touchend', 'keydown', 'keyup', 'keypress', 'focusin', 'focusout'];
  const STATUS = { open: 'Open', question: 'Claude has a question', resolved: 'Resolved' };

  /* ---------- helpers ---------- */

  function h(tag, attrs, ...kids) {
    const n = document.createElement(tag);
    if (attrs) for (const k in attrs) {
      const v = attrs[k];
      if (v == null || v === false) continue;
      if (k === 'class') n.className = v;
      else n.setAttribute(k, v === true ? '' : String(v));
    }
    for (const k of kids.flat(Infinity)) if (k != null && k !== false) n.append(k.nodeType ? k : String(k));
    return n;
  }
  const clip = (s, n) => {
    s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
    return s.length > n ? s.slice(0, n - 1) + '…' : s;
  };
  const per = (a, b) => (b ? a / b : 0);
  const r3 = v => Math.round(v * 1000) / 1000;
  const pageKey = () => location.pathname + location.search + location.hash;
  const storage = get => ({
    get(k) { try { return get().getItem('uiComments:' + k); } catch (e) { return null; } },
    set(k, v) { try { v == null ? get().removeItem('uiComments:' + k) : get().setItem('uiComments:' + k, v); } catch (e) {} },
  });
  const session = storage(() => sessionStorage);
  const local = storage(() => localStorage);

  function ago(iso) {
    const s = (Date.now() - new Date(iso).getTime()) / 1000;
    if (s < 60) return 'just now';
    if (s < 3600) return Math.floor(s / 60) + 'm ago';
    if (s < 86400) return Math.floor(s / 3600) + 'h ago';
    return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  }

  async function api(method, path, body) {
    let res;
    try {
      res = await fetch(API + path, {
        method,
        cache: 'no-store',
        headers: { 'content-type': 'application/json', 'x-ui-comments-token': TOKEN },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (e) {
      throw Object.assign(new Error(AUTO ? 'Cannot reach the dev server. Is it still running?' : 'The comment server is not running. Ask Claude to start it.'), { offline: true });
    }
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) {
      throw Object.assign(new Error(`Your Comment bookmark is out of date. Open ${scriptUrl.origin} and drag it to the bookmarks bar again.`), { auth: true });
    }
    if (!res.ok) throw new Error(data.error || 'Request failed (' + res.status + ')');
    return data;
  }

  /* ---------- what an element is, and where it comes from ---------- */

  function fiberOf(el) {
    for (let n = el; n; n = n.parentElement) {
      const k = Object.keys(n).find(k => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$'));
      if (k) return n[k];
    }
    return null;
  }
  function compName(t) {
    if (!t || typeof t === 'string') return null;
    if (typeof t === 'function') return t.displayName || t.name || null;
    if (typeof t === 'object') return t.displayName || compName(t.render) || compName(t.type) || null;
    return null;
  }
  // React 19 drops _debugSource; its _debugStack points at the JSX call site in the served file.
  function stackLoc(stack) {
    const s = stack && (stack.stack || String(stack));
    if (!s) return null;
    for (const line of s.split('\n')) {
      const m = line.match(/(https?:\/\/[^\s()]+?):(\d+):(\d+)/);
      if (!m || /node_modules|\/@vite\/|\/@react-refresh|\/\.vite\/deps\//.test(m[1])) continue;
      try {
        const u = new URL(m[1]);
        return { file: decodeURIComponent(u.pathname).replace(/^\/@fs\//, ''), line: +m[2], col: +m[3], approx: true };
      } catch (e) {}
    }
    return null;
  }
  const fiberLoc = f => (f._debugSource
    ? { file: f._debugSource.fileName, line: f._debugSource.lineNumber, col: f._debugSource.columnNumber }
    : f._debugStack ? stackLoc(f._debugStack) : null);

  // A container outside the app's components (such as React's #root) has no source of its own,
  // so report the first component it holds instead.
  function sourceOf(el) {
    const own = ownSource(el);
    if (own) return own;
    let i = 0;
    for (const child of el.querySelectorAll('*')) {
      if (++i > 400) break;
      const s = ownSource(child);
      if (s) return { framework: s.framework, element: null, components: [], contains: { label: shortName(child), element: s.element, components: s.components.slice(0, 4) } };
    }
    return null;
  }
  function ownSource(el) {
    const fiber = fiberOf(el);
    if (fiber) {
      const components = [];
      for (let f = fiber.return; f && components.length < 8; f = f.return) {
        const name = compName(f.type);
        if (name) components.push({ name, source: fiberLoc(f) });
      }
      return { framework: 'react', element: fiberLoc(fiber), components };
    }
    for (let n = el; n; n = n.parentElement) {
      if (n.__vueParentComponent) {
        const components = [];
        for (let i = n.__vueParentComponent; i && components.length < 8; i = i.parent) {
          const t = i.type || {};
          const file = t.__file || null;
          components.push({ name: t.name || t.__name || (file ? file.split('/').pop().replace(/\.vue$/, '') : 'Anonymous'), source: file ? { file } : null });
        }
        return { framework: 'vue', element: null, components };
      }
      if (n.__svelte_meta && n.__svelte_meta.loc) {
        const l = n.__svelte_meta.loc;
        return { framework: 'svelte', element: { file: l.file, line: l.line, col: l.column, approx: true }, components: [] };
      }
    }
    return null;
  }
  function componentName(el) {
    const f = fiberOf(el);
    for (let x = f && f.return; x; x = x.return) { const n = compName(x.type); if (n) return n; }
    for (let n = el; n; n = n.parentElement) {
      const c = n.__vueParentComponent;
      if (c && c.type) return c.type.name || c.type.__name || null;
    }
    return null;
  }

  function shortName(n) {
    let s = n.localName;
    if (n.id) return s + '#' + n.id;
    const cls = (n.getAttribute('class') || '').trim().split(/\s+/).find(c => c && !/[:[\]/]/.test(c));
    if (cls) s += '.' + cls;
    return s;
  }
  const labelFor = el => { const c = componentName(el); return (c ? c + ' · ' : '') + clip(shortName(el), 40); };

  // A structural selector. It survives class edits, which is what Claude's changes usually are.
  function cssPath(el) {
    const parts = [];
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      if (n === document.body) { parts.unshift('body'); break; }
      if (n === document.documentElement) break;
      const tid = n.getAttribute('data-testid');
      if (tid) {
        const s = `[data-testid="${CSS.escape(tid)}"]`;
        if (document.querySelectorAll(s).length === 1) { parts.unshift(s); break; }
      }
      if (n.id && !/^\d|:|\d{4,}/.test(n.id)) {
        const s = '#' + CSS.escape(n.id);
        if (document.querySelectorAll(s).length === 1) { parts.unshift(s); break; }
      }
      let part = n.localName;
      const p = n.parentElement;
      if (p) {
        let count = 0, idx = 0;
        for (const c of p.children) if (c.localName === n.localName) { count++; if (c === n) idx = count; }
        if (count > 1) part += `:nth-of-type(${idx})`;
      }
      parts.unshift(part);
    }
    return parts.join(' > ');
  }
  function readablePath(el) {
    const out = [];
    for (let n = el; n && n !== document.body && n !== document.documentElement && out.length < 6; n = n.parentElement) out.unshift(shortName(n));
    return out.join(' > ');
  }
  const textOf = (el, n) => clip(el ? (el.innerText != null ? el.innerText : el.textContent) : '', n);
  function openingTag(el) {
    let s = '<' + el.localName;
    for (const a of el.attributes) s += ` ${a.name}="${clip(a.value, a.name === 'class' ? 400 : 160)}"`;
    return s + '>';
  }

  const STYLE_KEYS = ['display', 'position', 'width', 'height', 'padding', 'margin', 'gap', 'font-family', 'font-size',
    'font-weight', 'line-height', 'letter-spacing', 'text-transform', 'text-align', 'color', 'background-color',
    'background-image', 'border-width', 'border-style', 'border-color', 'border-radius', 'outline', 'box-shadow',
    'opacity', 'transform', 'flex-direction', 'align-items', 'justify-content', 'grid-template-columns', 'overflow'];
  const BORING = new Set(['none', 'normal', 'auto', '0px', 'rgba(0, 0, 0, 0)', 'static', 'visible', 'start', '1']);
  function stylesOf(el) {
    const cs = getComputedStyle(el);
    const flex = /flex/.test(cs.display), grid = /grid/.test(cs.display);
    // CSS resets give every element a border style and colour with zero width; that is noise.
    const noBorder = cs.getPropertyValue('border-style') === 'none' || cs.getPropertyValue('border-width') === '0px';
    const out = {};
    for (const k of STYLE_KEYS) {
      let v = cs.getPropertyValue(k);
      if (!v) continue;
      if (k !== 'width' && k !== 'height' && k !== 'display' && BORING.has(v)) continue;
      if (k.startsWith('border-') && k !== 'border-radius' && noBorder) continue;
      if ((k === 'gap' || k === 'flex-direction' || k === 'align-items' || k === 'justify-content') && !flex && !grid) continue;
      if (k === 'grid-template-columns' && !grid) continue;
      if (k === 'outline' && / none|^none|0px$/.test(v)) continue;
      if (k === 'font-family') v = clip(v, 80);
      if (k === 'background-image' || k === 'box-shadow' || k === 'transform') v = clip(v, 160);
      out[k] = v;
    }
    return out;
  }
  // data-* attributes on the element and its ancestors: themes, versions, states.
  function contextOf(el) {
    const out = {};
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      for (const a of n.attributes) {
        if ((a.name.startsWith('data-') || a.name === 'lang' || a.name === 'dir') && !(a.name in out) && Object.keys(out).length < 14) {
          out[a.name] = clip(a.value, 60);
        }
      }
    }
    return out;
  }
  const LANDMARK = /^(section|article|aside|nav|header|footer|main|dialog|form|fieldset)$/;
  const LANDROLE = /^(dialog|alertdialog|region|tabpanel|tablist|navigation|banner|complementary|group|form|menu|listbox)$/;
  function sectionOf(el) {
    for (let n = el; n && n !== document.body && n.nodeType === 1; n = n.parentElement) {
      const role = n.getAttribute('role') || '';
      if (!LANDMARK.test(n.localName) && !LANDROLE.test(role)) continue;
      let label = n.getAttribute('aria-label');
      const by = n.getAttribute('aria-labelledby');
      if (!label && by) label = by.split(/\s+/).map(id => (document.getElementById(id) || {}).textContent || '').join(' ');
      if (!label) { const hd = n.querySelector('h1, h2, h3, h4, legend'); if (hd) label = hd.textContent; }
      if (clip(label, 80)) return { tag: n.localName, role: role || undefined, label: clip(label, 80) };
    }
    return null;
  }
  function pageInfo() {
    const hd = document.querySelector('h1') || document.querySelector('h2');
    const htmlClass = (document.documentElement.getAttribute('class') || '').replace(/\buic-on\b/, '');
    return {
      href: location.href,
      key: pageKey(),
      title: document.title,
      heading: hd ? clip(hd.textContent, 100) : '',
      viewport: { w: innerWidth, h: innerHeight },
      dpr: devicePixelRatio,
      scroll: { x: Math.round(scrollX), y: Math.round(scrollY) },
      scheme: matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
      htmlClass: clip(htmlClass, 120) || undefined,
    };
  }
  function describe(el) {
    const r = el.getBoundingClientRect();
    return {
      selector: cssPath(el),
      path: readablePath(el),
      tag: el.localName,
      id: el.id || undefined,
      html: openingTag(el),
      text: textOf(el, 160),
      rect: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
      styles: stylesOf(el),
      section: sectionOf(el),
      context: contextOf(el),
      source: sourceOf(el),
      children: el.children.length,
    };
  }

  /* ---------- shadow root and page hooks ---------- */

  const CURSOR_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 28 28">' +
    '<path d="M2 26V14A12 12 0 1 1 14 26Z" fill="#fff" stroke="#0d99ff" stroke-width="2" stroke-linejoin="round"/>' +
    '<path d="M14 9.5v9M9.5 14h9" stroke="#0d99ff" stroke-width="2" stroke-linecap="round"/></svg>';
  const CURSOR = `url("data:image/svg+xml,${encodeURIComponent(CURSOR_SVG)}") 2 26, crosshair`;

  const pageStyle = document.createElement('style');
  pageStyle.setAttribute('data-ui-comments', '');
  pageStyle.textContent =
    `html.uic-on, html.uic-on body, html.uic-on body * { cursor: ${CURSOR} !important; }` +
    'html.uic-on body * { user-select: none !important; -webkit-user-select: none !important; }' +
    'html.uic-on.uic-edit, html.uic-on.uic-edit body, html.uic-on.uic-edit body * { cursor: default !important; }';

  const ICONS = {
    comment: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M12 3.5a8.5 8.5 0 1 1-4.3 15.83L3.5 20.5l1.17-4.2A8.5 8.5 0 0 1 12 3.5Z"/></svg>',
    list: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M9 7h11M9 12h11M9 17h11M4.5 7h.01M4.5 12h.01M4.5 17h.01"/></svg>',
    close: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>',
    dock: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M8 9l4-4 4 4M8 15l4 4 4-4"/></svg>',
    check: '<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12 5 5 9-10"/></svg>',
    chevron: '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>',
    edit: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/></svg>',
  };
  const icon = name => { const s = h('span', { class: 'ic' }); s.innerHTML = ICONS[name]; return s; };

  const STYLES = `
:host { all: initial; }
.ui { position: fixed; left: 0; top: 0; width: 0; height: 0; font: 13px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color: #1e1e1e; cursor: default; -webkit-font-smoothing: antialiased; }
.ui *, .ui *::before, .ui *::after { box-sizing: border-box; }
button { font: inherit; color: inherit; margin: 0; }
.ic { display: inline-flex; } .ic svg { display: block; }
.hl { position: fixed; display: none; pointer-events: none; z-index: 1; border: 1.5px solid #0d99ff; background: rgba(13,153,255,.06); border-radius: 2px; }
.hl.solid { background: rgba(13,153,255,.12); }
.hl-tag { position: fixed; display: none; pointer-events: none; z-index: 1; background: #0d99ff; color: #fff; font-size: 11px; font-weight: 600; line-height: 20px; padding: 0 6px; border-radius: 4px; white-space: nowrap; max-width: 70vw; overflow: hidden; text-overflow: ellipsis; }
.region { position: fixed; display: none; pointer-events: none; z-index: 1; border: 1.5px dashed #0d99ff; background: rgba(13,153,255,.08); border-radius: 2px; }
.pins { position: fixed; left: 0; top: 0; z-index: 2; }
.pin { position: fixed; left: 0; top: 0; width: 28px; height: 28px; padding: 0; border: 2px solid #fff; border-radius: 14px 14px 14px 3px; background: #0d99ff; color: #fff; font-size: 12px; font-weight: 700; line-height: 24px; text-align: center; box-shadow: 0 2px 8px rgba(0,0,0,.3); cursor: pointer; transform-origin: 0 100%; transition: transform .12s ease; }
.pin:hover, .pin.on { transform: scale(1.15); }
.pin.question { background: #f5a524; color: #1e1e1e; }
.pin.resolved { background: #9a9a9a; }
.pin.detached { opacity: .55; border-style: dashed; }
.pin.draft { background: #fff; border-color: #0d99ff; cursor: default; }
.card { position: fixed; left: 0; top: 0; z-index: 4; width: 320px; max-width: calc(100vw - 24px); background: #fff; color: #1e1e1e; border-radius: 12px; box-shadow: 0 10px 32px rgba(0,0,0,.24), 0 0 0 1px rgba(0,0,0,.08); overflow: hidden; }
.card.shake { animation: uic-shake .3s; }
@keyframes uic-shake { 25% { translate: -5px 0; } 75% { translate: 5px 0; } }
.card-h { display: flex; align-items: center; gap: 8px; padding: 12px 10px 6px 12px; }
.grow { flex: 1; }
.sub { font-size: 11px; color: #6f6f6f; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 170px; }
.label { padding: 0 12px 4px; font-size: 11px; color: #6f6f6f; }
.chips { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 3px; padding: 0 12px 10px; }
.chip { border: 1px solid #e2e2e2; background: #f6f6f6; border-radius: 6px; padding: 1px 6px; font: 500 11px/18px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; color: #3a3a3a; cursor: pointer; max-width: 150px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.chip:hover { border-color: #0d99ff; }
.chip.on { background: #0d99ff; border-color: #0d99ff; color: #fff; }
.crumb { color: #b4b4b4; font-size: 11px; }
textarea { display: block; width: calc(100% - 24px); margin: 0 12px; min-height: 60px; max-height: 220px; resize: vertical; border: 1px solid #d4d4d4; border-radius: 8px; padding: 8px 10px; font: inherit; color: inherit; background: #fff; outline: none; cursor: text; user-select: text; -webkit-user-select: text; }
textarea:focus { border-color: #0d99ff; box-shadow: 0 0 0 3px rgba(13,153,255,.18); }
.card-f { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 10px 12px 12px; }
.row { display: inline-flex; gap: 6px; }
.card-f .btn { white-space: nowrap; }
.hint { font-size: 11px; color: #8a8a8a; }
.btn { border: 0; border-radius: 7px; padding: 6px 12px; font-size: 12px; font-weight: 600; line-height: 16px; background: #0d99ff; color: #fff; cursor: pointer; }
.btn:hover { background: #0b88e3; }
.btn:disabled { opacity: .4; cursor: default; background: #0d99ff; }
.btn.ghost { background: transparent; color: #2a2a2a; }
.btn.ghost:hover { background: #f1f1f1; }
.btn.danger { color: #c4271b; }
.btn.armed, .btn.armed:hover { background: #c4271b; color: #fff; }
.x { border: 0; background: transparent; width: 26px; height: 26px; border-radius: 6px; display: inline-flex; align-items: center; justify-content: center; color: #6f6f6f; cursor: pointer; padding: 0; flex: none; }
.x:hover { background: #f1f1f1; color: #1e1e1e; }
.num { font-weight: 700; }
.num.open { color: #0d99ff; } .num.question { color: #b26f00; } .num.resolved { color: #7a7a7a; }
.thread { max-height: 240px; overflow: auto; padding: 0 12px 6px; }
.msg { padding: 6px 0; }
.msg + .msg { border-top: 1px solid #f0f0f0; }
.who { font-weight: 600; font-size: 12px; }
.who.claude { color: #c15f3c; }
.when { font-size: 11px; color: #9a9a9a; margin-left: 6px; font-weight: 400; }
.body { white-space: pre-wrap; overflow-wrap: anywhere; margin-top: 1px; }
.meta { padding: 0 12px 8px; font-size: 11px; color: #7a7a7a; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bar { position: fixed; left: 50%; bottom: 16px; z-index: 5; transform: translateX(-50%); display: flex; align-items: center; gap: 2px; padding: 4px; background: #1e1e1e; color: #fff; border-radius: 12px; box-shadow: 0 0 0 1px rgba(255,255,255,.14), 0 8px 24px rgba(0,0,0,.32); }
.bar.top { top: 16px; bottom: auto; }
.bar.folded { left: 16px; transform: none; }
.tb { border: 0; background: transparent; color: #fff; height: 32px; padding: 0 10px; border-radius: 8px; display: inline-flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 500; cursor: pointer; white-space: nowrap; }
.tb:hover { background: rgba(255,255,255,.1); }
.tb.on { background: #0d99ff; }
.tb.sq { width: 32px; padding: 0; justify-content: center; }
kbd { font: 600 10px/1 ui-monospace, Consolas, monospace; padding: 3px 4px; border-radius: 4px; background: rgba(255,255,255,.16); }
.sep { width: 1px; height: 18px; background: rgba(255,255,255,.2); margin: 0 3px; }
.badge { min-width: 18px; height: 18px; padding: 0 5px; border-radius: 9px; background: #0d99ff; color: #fff; font-size: 11px; font-weight: 700; display: inline-flex; align-items: center; justify-content: center; }
.badge.zero { background: rgba(255,255,255,.16); }
.badge.ask { background: #f5a524; color: #1e1e1e; }
.tb.on .badge { background: #fff; color: #0d99ff; }
.pname { max-width: 150px; overflow: hidden; text-overflow: ellipsis; }
.dot { width: 8px; height: 8px; border-radius: 50%; background: #ff5c5c; }
.menu { position: fixed; z-index: 6; min-width: 210px; max-width: 320px; background: #1e1e1e; color: #fff; border-radius: 10px; padding: 6px; box-shadow: 0 8px 24px rgba(0,0,0,.32); }
.menu-h { font-size: 11px; color: #a0a0a0; padding: 4px 8px 6px; }
.mi { display: flex; align-items: center; gap: 8px; width: 100%; text-align: left; border: 0; background: transparent; color: #fff; padding: 7px 8px; border-radius: 6px; font-size: 12px; cursor: pointer; }
.mi:hover { background: rgba(255,255,255,.1); }
.mi.on { background: #0d99ff; }
.mi-empty { padding: 6px 8px; font-size: 12px; color: #a0a0a0; }
.panel { position: fixed; top: 12px; right: 12px; bottom: 68px; z-index: 3; width: 320px; max-width: calc(100vw - 24px); background: #fff; border-radius: 12px; box-shadow: 0 10px 32px rgba(0,0,0,.24), 0 0 0 1px rgba(0,0,0,.08); display: flex; flex-direction: column; overflow: hidden; }
.panel.top { top: 68px; bottom: 12px; }
.panel-h { display: flex; align-items: center; gap: 8px; padding: 10px 8px 6px 14px; }
.panel-h b { font-size: 13px; }
.muted { color: #8a8a8a; font-weight: 400; }
.toggle { display: inline-flex; align-items: center; gap: 6px; border: 0; background: transparent; font-size: 12px; color: #4a4a4a; cursor: pointer; padding: 2px 14px 10px; }
.box { width: 14px; height: 14px; border: 1.5px solid #b5b5b5; border-radius: 3px; display: inline-flex; align-items: center; justify-content: center; }
.toggle.on .box { background: #0d99ff; border-color: #0d99ff; color: #fff; }
.panel-b { flex: 1; overflow: auto; border-top: 1px solid #efefef; padding-bottom: 8px; }
.group { padding: 12px 14px 4px; font-size: 11px; font-weight: 600; color: #8a8a8a; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.group.here { color: #0d99ff; }
.item { display: flex; align-items: flex-start; gap: 10px; width: 100%; text-align: left; border: 0; background: transparent; padding: 8px 14px; cursor: pointer; }
.item:hover { background: #f4f9ff; }
.mini { flex: none; width: 22px; height: 22px; border-radius: 11px 11px 11px 3px; background: #0d99ff; color: #fff; font-size: 11px; font-weight: 700; line-height: 22px; text-align: center; }
.mini.question { background: #f5a524; color: #1e1e1e; } .mini.resolved { background: #9a9a9a; }
.item-c { flex: 1; min-width: 0; }
.item-t { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; overflow-wrap: anywhere; }
.item-s { font-size: 11px; color: #8a8a8a; margin-top: 2px; }
.empty { padding: 28px 16px; color: #8a8a8a; text-align: center; }
.toast { position: fixed; left: 50%; bottom: 66px; z-index: 7; transform: translateX(-50%); background: #1e1e1e; color: #fff; padding: 8px 14px; border-radius: 8px; font-size: 12px; box-shadow: 0 6px 18px rgba(0,0,0,.28); opacity: 0; transition: opacity .15s; pointer-events: none; max-width: min(520px, 90vw); text-align: center; }
.toast.top { top: 66px; bottom: auto; }
.toast.show { opacity: 1; }
.toast.err { background: #c4271b; }
.dot.blue { background: #0d99ff; }
.sel { position: fixed; display: none; pointer-events: none; z-index: 1; border: 2px solid #0d99ff; border-radius: 2px; }
.insp { position: fixed; top: 12px; right: 12px; bottom: 68px; z-index: 3; width: 292px; max-width: calc(100vw - 24px); background: #fff; border-radius: 12px; box-shadow: 0 10px 32px rgba(0,0,0,.24), 0 0 0 1px rgba(0,0,0,.08); display: flex; flex-direction: column; overflow: hidden; font-size: 12px; }
.insp.top { top: 68px; bottom: 12px; }
.insp-h { display: flex; align-items: center; gap: 8px; padding: 10px 8px 6px 12px; }
.insp-h b { font-size: 12px; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.insp .chips { padding: 0 12px 8px; }
.chk { display: flex; align-items: center; gap: 6px; border: 0; background: transparent; font-size: 11px; color: #3a3a3a; cursor: pointer; padding: 0 12px 10px; text-align: left; }
.chk.on .box { background: #0d99ff; border-color: #0d99ff; color: #fff; }
.insp-b { flex: 1; overflow: auto; border-top: 1px solid #efefef; }
.sec { padding: 10px 12px; border-bottom: 1px solid #f2f2f2; }
.sec-t { font-size: 11px; font-weight: 700; margin-bottom: 6px; }
.prow { display: flex; align-items: center; gap: 6px; min-height: 28px; }
.prow + .prow { margin-top: 4px; }
.pl { flex: none; width: 58px; font-size: 11px; color: #6f6f6f; user-select: none; -webkit-user-select: none; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.pl.scrub { cursor: ew-resize; }
.prow.changed .pl { color: #0d99ff; font-weight: 600; }
.pc { flex: 1; min-width: 0; display: flex; align-items: center; gap: 4px; }
.pf { height: 26px; min-width: 0; width: 64px; border: 1px solid transparent; border-radius: 5px; background: #f3f3f3; padding: 0 6px; font: 11px/24px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; color: #1e1e1e; outline: none; cursor: text; user-select: text; -webkit-user-select: text; }
.pf.wide { flex: 1; width: auto; }
select.pf { cursor: pointer; padding: 0 2px; font-family: inherit; }
.pf:hover { border-color: #e0e0e0; }
.pf:focus { border-color: #0d99ff; background: #fff; }
.pf.bad, .pf.bad:focus { border-color: #c4271b; }
.cell { position: relative; flex: 1; min-width: 0; display: flex; }
.cell::before { content: attr(data-l); position: absolute; left: 5px; top: 50%; transform: translateY(-50%); font-size: 9px; font-weight: 700; color: #a8a8a8; pointer-events: none; }
.cell .pf { flex: 1; width: 100%; padding-left: 14px; }
.quad { flex: 1; min-width: 0; display: grid; grid-template-columns: repeat(4, 1fr); gap: 4px; }
.swatch { flex: none; width: 26px; height: 26px; padding: 0; border-radius: 5px; border: 1px solid rgba(0,0,0,.18); cursor: pointer; background: #fff; }
.seg { display: inline-flex; gap: 2px; padding: 2px; background: #f3f3f3; border-radius: 6px; }
.seg button { border: 0; background: transparent; height: 22px; padding: 0 8px; border-radius: 4px; font-size: 11px; color: #555; cursor: pointer; }
.seg button.on { background: #fff; color: #1e1e1e; box-shadow: 0 1px 2px rgba(0,0,0,.18); }
.undo1 { flex: none; width: 18px; border: 0; background: transparent; color: #0d99ff; font-size: 14px; cursor: pointer; padding: 0; visibility: hidden; }
.prow.changed .undo1 { visibility: visible; }
.pcss { margin: 0; width: 100%; min-height: 44px; font: 11px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.insp-f { border-top: 1px solid #eee; padding: 10px 12px 12px; display: flex; flex-direction: column; gap: 8px; }
.insp-f textarea { margin: 0; width: 100%; min-height: 40px; }
.chg { display: flex; align-items: center; justify-content: space-between; gap: 6px; font-size: 11px; color: #6f6f6f; }
.palette { position: fixed; z-index: 6; background: #fff; border-radius: 10px; box-shadow: 0 10px 28px rgba(0,0,0,.24), 0 0 0 1px rgba(0,0,0,.08); padding: 8px; display: flex; flex-direction: column; gap: 6px; max-height: 300px; }
.pal-list { flex: 1; min-height: 0; overflow: auto; }
.tok { display: flex; align-items: center; gap: 8px; width: 100%; border: 0; background: transparent; padding: 4px 6px; border-radius: 6px; cursor: pointer; text-align: left; font-size: 11px; color: #1e1e1e; }
.tok:hover { background: #f2f8ff; }
.tok i { flex: none; width: 16px; height: 16px; border-radius: 4px; box-shadow: inset 0 0 0 1px rgba(0,0,0,.15); }
.tok span { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.tok em { flex: none; font-style: normal; color: #9a9a9a; }
.pal-empty { padding: 10px 6px; color: #8a8a8a; font-size: 11px; }
.pal-f { position: relative; display: flex; }
.native { position: absolute; left: 0; bottom: 0; width: 1px; height: 1px; opacity: 0; border: 0; padding: 0; pointer-events: none; }
.chlist { margin: 0 12px 8px; padding: 8px 10px; background: #f4f8fc; border-radius: 8px; font: 11px/1.6 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; color: #2a2a2a; overflow-wrap: anywhere; }
.chlist-t { font: 600 11px/1.6 system-ui, sans-serif; color: #6f6f6f; }
.cmp { margin: 0 12px 8px; padding: 8px 10px 10px; background: #f6f6f8; border-radius: 8px; display: grid; gap: 6px; }
.cmp-t { font: 600 11px/1.4 system-ui, sans-serif; color: #6f6f6f; }
.cmp-seg { display: inline-flex; justify-self: start; padding: 2px; background: #e6e6ea; border-radius: 7px; }
.cmp-seg button { font: 500 12px/1 system-ui, sans-serif; padding: 5px 10px; border-radius: 5px; color: #4a4a4a; }
.cmp-seg button.on { background: #fff; color: #1e1e1e; box-shadow: 0 1px 2px rgba(0,0,0,.12); }
.cmp-frame { max-height: 180px; overflow: auto; border-radius: 6px; background: #fff; box-shadow: inset 0 0 0 1px rgba(0,0,0,.08); }
.cmp-img { display: block; max-width: 100%; }
.cmp-over { justify-self: start; }
.cmp-decide { display: flex; gap: 6px; flex-wrap: wrap; }
.cmp-decide .btn { background: #fff; box-shadow: inset 0 0 0 1px rgba(0,0,0,.14); }
.cmp-decide .btn.picked { background: #0d99ff; color: #fff; box-shadow: none; }
.prev-over { position: fixed; z-index: 3; pointer-events: none; outline: 2px dashed #f5a524; outline-offset: 2px; box-shadow: 0 6px 24px rgba(0,0,0,.25); }
.prev-over img { display: block; }
.prev-tag { position: absolute; left: 0; top: -22px; font: 600 11px/1 system-ui, sans-serif; background: #f5a524; color: #1e1e1e; padding: 4px 7px; border-radius: 5px; }
`;

  const host = document.createElement('ui-comments-root');
  host.style.cssText = 'all: initial; position: fixed; left: 0; top: 0; width: 0; height: 0; z-index: 2147483647;';
  const root = host.attachShadow({ mode: 'open' });
  const styleEl = document.createElement('style');
  styleEl.textContent = STYLES;
  const ui = h('div', { class: 'ui' });
  root.append(styleEl, ui);

  const regionBox = h('div', { class: 'region' });
  const selBox = h('div', { class: 'sel' });
  const hl = h('div', { class: 'hl' });
  const hlTag = h('div', { class: 'hl-tag' });
  const pinLayer = h('div', { class: 'pins' });
  const draftPin = h('div', { class: 'pin draft', style: 'display:none' });
  const bar = h('div', { class: 'bar' });
  const toastEl = h('div', { class: 'toast' });
  pinLayer.append(draftPin);
  ui.append(regionBox, selBox, hl, hlTag, pinLayer, bar, toastEl);

  /* ---------- state ---------- */

  const state = {
    projects: [], projectId: null, projectName: '',
    comments: [], sig: '',
    mode: 'idle',
    draft: null,     // { chain, idx, ox, oy, region, text, last }
    openId: null,    // comment whose thread is open
    panel: false,
    showResolved: false,
    dockTop: local.get('dockTop') === '1',
    collapsed: AUTO && local.get('collapsed') === '1',
    fixed: false,    // the project is set by the dev server
    edit: null,      // { chain, idx, similar, selector, free }: the element the edit panel is showing
    scrub: null,     // a drag on a panel label that is changing a number
    url: pageKey(),
    hover: null, chipHover: null, drag: null,
    offline: false, authWarned: false,
    pendingOpen: null,
  };
  let card = null, panel = null, menu = null, raf = 0, pollTimer = 0, toastTimer = 0, dead = false;
  const pinEls = new Map();
  const anchors = new Map(); // comment id -> { el, at }
  const byId = id => state.comments.find(c => c.id === id) || null;

  /* ---------- positioning ---------- */

  function setPos(el, x, y) {
    x = Math.round(x); y = Math.round(y);
    if (el._x !== x || el._y !== y) { el.style.left = x + 'px'; el.style.top = y + 'px'; el._x = x; el._y = y; }
  }
  function setBox(el, rc) {
    if (!rc) { if (el.style.display !== 'none') el.style.display = 'none'; return; }
    el.style.display = 'block';
    setPos(el, rc.left, rc.top);
    const w = Math.round(rc.width) + 'px', hh = Math.round(rc.height) + 'px';
    if (el.style.width !== w) el.style.width = w;
    if (el.style.height !== hh) el.style.height = hh;
  }
  const show = (el, on) => { const v = on ? '' : 'none'; if (el.style.display !== v) el.style.display = v; };

  function findAnchor(c) {
    const hit = anchors.get(c.id);
    if (hit && hit.el && hit.el.isConnected) return hit.el;
    const t = performance.now();
    if (hit && !hit.el && t - hit.at < 250) return null;
    let el = null;
    try { el = c.target && c.target.selector ? document.querySelector(c.target.selector) : null; } catch (e) {}
    if (el && el.localName !== c.target.tag) el = null;
    // Same structure, different content (another state of the same screen): don't pin to it.
    if (el && c.status !== 'resolved' && c.target.text && c.target.text.length >= 3) {
      const want = c.target.text.replace(/…$/, '').slice(0, 24);
      if (!textOf(el, 400).includes(want)) el = null;
    }
    anchors.set(c.id, { el, at: t });
    return el;
  }
  function pointFor(c) {
    const el = findAnchor(c);
    if (el && c.anchor) {
      const r = el.getBoundingClientRect();
      if (r.width || r.height) return { x: r.left + c.anchor.ox * r.width, y: r.top + c.anchor.oy * r.height, el, r, attached: true };
    }
    if (c.pagePoint) return { x: c.pagePoint.x - scrollX, y: c.pagePoint.y - scrollY, attached: false };
    return null;
  }
  const regionIn = (reg, r) => (reg ? { left: r.left + reg.x * r.width, top: r.top + reg.y * r.height, width: reg.w * r.width, height: reg.h * r.height } : null);
  function draftPoint(d) {
    const t = d.chain[d.idx];
    if (t && t.isConnected) {
      const r = t.getBoundingClientRect();
      d.last = { x: r.left + d.ox * r.width, y: r.top + d.oy * r.height };
    }
    return d.last;
  }
  function draftRegion(d) {
    const t = d.chain[d.idx];
    return d.region && t && t.isConnected ? regionIn(d.region, t.getBoundingClientRect()) : null;
  }
  const dragRect = g => ({ left: Math.min(g.x, g.x2), top: Math.min(g.y, g.y2), width: Math.abs(g.x2 - g.x), height: Math.abs(g.y2 - g.y) });

  let hlFor = null, hlText = '';
  function drawHighlight(el, solid) {
    if (!el || !el.isConnected || el === document.documentElement) { show(hl, false); show(hlTag, false); hlFor = null; return; }
    const r = el.getBoundingClientRect();
    setBox(hl, r);
    hl.classList.toggle('solid', !!solid);
    if (el !== hlFor) { hlFor = el; hlText = labelFor(el); }
    const txt = `${hlText}   ${Math.round(r.width)} × ${Math.round(r.height)}`;
    if (hlTag.textContent !== txt) hlTag.textContent = txt;
    if (hlTag.style.display !== 'block') hlTag.style.display = 'block';
    const x = Math.max(4, Math.min(r.left, innerWidth - hlTag.offsetWidth - 4));
    const y = r.top > 26 ? r.top - 24 : Math.min(r.bottom + 4, innerHeight - 24);
    setPos(hlTag, x, y);
  }
  function placeCard(x, y) {
    const w = card.offsetWidth, hh = card.offsetHeight, m = 12;
    let left = x + PIN + 10;
    if (left + w > innerWidth - m) left = x - w - 10;
    left = Math.max(m, Math.min(left, innerWidth - w - m));
    const top = Math.max(m, Math.min(y - PIN, innerHeight - hh - m));
    setPos(card, left, top);
  }

  function tick() {
    if (pageKey() !== state.url) onRoute();
    for (const [id, pin] of pinEls) {
      const c = byId(id);
      const p = c && pointFor(c);
      show(pin, !!p);
      if (!p) continue;
      setPos(pin, p.x, p.y - PIN);
      pin.classList.toggle('detached', !p.attached);
    }
    let target = null, solid = false, region = null, anchor = null;
    const d = state.draft;
    if (d) {
      anchor = draftPoint(d);
      show(draftPin, true);
      setPos(draftPin, anchor.x, anchor.y - PIN);
      const peek = state.chipHover != null ? d.chain[state.chipHover] : null;
      region = draftRegion(d);
      // An area comment shows its dashed box; the container behind it would only add noise.
      target = peek || (region ? null : d.chain[d.idx]);
      solid = !peek || state.chipHover === d.idx;
    } else {
      show(draftPin, false);
      const c = state.openId && byId(state.openId);
      const p = c && pointFor(c);
      if (p) {
        anchor = p;
        if (p.attached) { region = regionIn(c.region, p.r); target = region ? null : p.el; }
      } else if (state.mode !== 'idle' && !state.drag) target = state.hover;
    }
    if (state.drag && state.drag.moved) { region = dragRect(state.drag); target = null; }
    if (tweaks.length || state.edit) {
      const now = performance.now();
      if (now - lastRefresh > 500) { lastRefresh = now; refreshTweaks(); }
    }
    const se = editEl();
    setBox(selBox, se && se.isConnected ? se.getBoundingClientRect() : null);
    if (target && target === se) target = null;
    drawHighlight(target, solid);
    setBox(regionBox, region);
    if (card && anchor) placeCard(anchor.x, anchor.y);
  }
  function frame() {
    if (dead) return;
    try { tick(); } catch (err) { console.warn('[ui-comments]', err); }
    raf = requestAnimationFrame(frame);
  }

  /* ---------- picking ---------- */

  function pickAt(x, y) {
    let el = null;
    for (const n of document.elementsFromPoint(x, y)) if (n !== host && n !== document.documentElement) { el = n; break; }
    while (el && el.shadowRoot) {
      const inner = el.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === el) break;
      el = inner;
    }
    if (el instanceof SVGElement && el.ownerSVGElement) {
      let s = el.ownerSVGElement;
      while (s.ownerSVGElement) s = s.ownerSVGElement;
      el = s;
    }
    return el || document.body;
  }
  function chainOf(el) {
    const out = [];
    for (let n = el; n && n.nodeType === 1 && n !== document.documentElement && out.length < 14; n = n.parentElement) out.push(n);
    return out;
  }

  function startPoint(x, y) {
    closeCard();
    const el = pickAt(x, y);
    const r = el.getBoundingClientRect();
    state.draft = { chain: chainOf(el), idx: 0, ox: per(x - r.left, r.width), oy: per(y - r.top, r.height), region: null, text: '', last: { x, y } };
    state.hover = null;
    openComposer();
  }
  function startRegion(rc) {
    closeCard();
    const chain = chainOf(pickAt(rc.left + rc.width / 2, rc.top + rc.height / 2));
    let idx = chain.findIndex(n => {
      const r = n.getBoundingClientRect();
      return r.left <= rc.left + 2 && r.top <= rc.top + 2 && r.right >= rc.left + rc.width - 2 && r.bottom >= rc.top + rc.height - 2;
    });
    if (idx < 0) idx = chain.length - 1;
    const r = chain[idx].getBoundingClientRect();
    const right = rc.left + rc.width;
    state.draft = {
      chain, idx,
      ox: per(right - r.left, r.width), oy: per(rc.top - r.top, r.height),
      region: { x: per(rc.left - r.left, r.width), y: per(rc.top - r.top, r.height), w: per(rc.width, r.width), h: per(rc.height, r.height) },
      regionPx: { w: Math.round(rc.width), h: Math.round(rc.height) },
      text: '', last: { x: right, y: rc.top },
    };
    state.hover = null;
    openComposer();
  }
  // Move the draft to a parent or child, keeping the pin and area where they are on screen.
  function retarget(i) {
    const d = state.draft;
    if (!d || i === d.idx || !d.chain[i]) return;
    const p = draftPoint(d), reg = draftRegion(d);
    d.idx = i;
    const r = d.chain[i].getBoundingClientRect();
    d.ox = per(p.x - r.left, r.width);
    d.oy = per(p.y - r.top, r.height);
    if (reg) d.region = { x: per(reg.left - r.left, r.width), y: per(reg.top - r.top, r.height), w: per(reg.width, r.width), h: per(reg.height, r.height) };
    renderChips();
  }

  // What the dragged area actually covers: sample a 3x3 grid of points inside it.
  function regionHits(target, rc) {
    const seen = new Set(), out = [];
    for (let i = 1; i <= 3; i++) for (let j = 1; j <= 3; j++) {
      const el = pickAt(rc.left + rc.width * i / 4, rc.top + rc.height * j / 4);
      if (seen.has(el)) continue;
      seen.add(el);
      if (el === target || !target.contains(el) || out.length >= 6) continue;
      const s = sourceOf(el);
      out.push({ html: clip(openingTag(el), 200), text: textOf(el, 60), selector: cssPath(el), source: s && (s.element || (s.components[0] && s.components[0].source)) || null });
    }
    return out;
  }

  function capture(d, text) {
    const el = d.chain[d.idx];
    const r = el.getBoundingClientRect();
    const p = draftPoint(d);
    const rc = draftRegion(d);
    const first = d.chain[0];
    return {
      project: state.projectId,
      text,
      kind: d.region ? 'region' : 'point',
      page: pageInfo(),
      target: describe(el),
      clicked: d.idx > 0 ? { tag: first.localName, text: textOf(first, 80), selector: cssPath(first), html: openingTag(first) } : null,
      anchor: { ox: r3(per(p.x - r.left, r.width)), oy: r3(per(p.y - r.top, r.height)) },
      region: d.region ? { x: r3(d.region.x), y: r3(d.region.y), w: r3(d.region.w), h: r3(d.region.h), px: d.regionPx, covers: rc ? regionHits(el, rc) : [] } : null,
      pagePoint: { x: Math.round(p.x + scrollX), y: Math.round(p.y + scrollY) },
    };
  }

  /* ---------- toolbar, menu, panel ---------- */

  let barSig = '';
  function renderBar() {
    const live = state.comments.filter(c => c.status !== 'resolved');
    const asks = live.some(c => c.status === 'question');
    const edits = changeCount();
    const sig = [state.mode, live.length, asks, state.projectName, state.fixed, state.offline, state.dockTop, state.panel, state.collapsed, edits].join('|');
    if (sig === barSig) return;
    barSig = sig;
    const tb = (act, kids, opts = {}) => h('button', { class: 'tb' + (opts.on ? ' on' : '') + (opts.sq ? ' sq' : ''), 'data-act': act, title: opts.title }, kids);
    const badge = h('span', { class: 'badge' + (asks ? ' ask' : live.length ? '' : ' zero') }, String(live.length));
    const dot = state.offline ? h('span', { class: 'dot', title: AUTO ? 'The dev server is not reachable' : 'The comment server is not reachable' }) : null;
    const editDot = edits ? h('span', { class: 'dot blue', title: `${edits} previewed change${edits > 1 ? 's' : ''} on this page` }) : null;
    bar.classList.toggle('top', state.dockTop);
    bar.classList.toggle('folded', state.collapsed);
    if (state.collapsed) {
      bar.replaceChildren(tb('expand', [icon('comment'), live.length ? badge : null, editDot, dot].filter(Boolean), { title: 'Show the toolbar (C to comment, E to edit)' }));
      return;
    }
    bar.replaceChildren(...[
      tb('mode', [icon('comment'), 'Comment', h('kbd', null, 'C')], { on: state.mode === 'comment', title: 'Comment mode (C): click a spot, or drag over an area' }),
      tb('editmode', [icon('edit'), 'Edit', h('kbd', null, 'E')], { on: state.mode === 'edit', title: 'Edit mode (E): click anything to try other colours, sizes and spacing. They are previews until you comment them.' }),
      // Previews change the page you are looking at, so they stay in sight until undone.
      edits ? tb('reset-all', [editDot, `${edits} previewed`, icon('close')], { title: 'Undo every preview on this page' }) : null,
      h('span', { class: 'sep' }),
      tb('list', [icon('list'), badge], { on: state.panel, title: 'All comments in this project' }),
      // A dev server always stores into its own project, so there is nothing to switch.
      state.fixed ? dot : tb('project', [dot, h('span', { class: 'pname' }, state.projectName || 'No project'), icon('chevron')], { title: 'The project these comments go to' }),
      tb('dock', [icon('dock')], { sq: true, title: state.dockTop ? 'Move toolbar to the bottom' : 'Move toolbar to the top' }),
      tb('close', [icon('close')], { sq: true, title: AUTO ? 'Hide the toolbar (C still starts a comment)' : 'Close (your comments are kept)' }),
    ].filter(Boolean));
  }
  function setCollapsed(on) {
    state.collapsed = on;
    local.set('collapsed', on ? '1' : null);
    if (on) { closeMenu(); closeCard(); closeInspector(); state.panel = false; renderPanel(); setMode('idle'); }
    renderBar();
  }

  function toast(msg, err) {
    toastEl.textContent = msg;
    toastEl.className = 'toast show' + (err ? ' err' : '') + (state.dockTop ? ' top' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toastEl.className = 'toast' + (state.dockTop ? ' top' : ''); }, err ? 5000 : 2200);
  }

  function closeMenu() { if (menu) { menu.remove(); menu = null; } }
  function toggleMenu(btn) {
    if (menu) return closeMenu();
    menu = h('div', { class: 'menu' },
      h('div', { class: 'menu-h' }, 'Comments go to'),
      state.projects.length
        ? state.projects.map(p => h('button', { class: 'mi' + (p.id === state.projectId ? ' on' : ''), 'data-act': 'pick-project', 'data-id': p.id, title: p.path }, p.name))
        : h('div', { class: 'mi-empty' }, 'No projects yet. In Claude, say: I want comment functionality in this project.'));
    ui.append(menu);
    const r = btn.getBoundingClientRect();
    menu.style.left = Math.max(8, Math.min(r.left, innerWidth - menu.offsetWidth - 8)) + 'px';
    if (state.dockTop) menu.style.top = r.bottom + 8 + 'px';
    else menu.style.bottom = innerHeight - r.top + 8 + 'px';
  }
  async function pickProject(id) {
    closeMenu();
    if (id === state.projectId) return;
    try { await api('POST', '/active', { projectId: id }); await sync(); toast('Comments now go to ' + state.projectName); }
    catch (err) { toast(err.message, true); }
  }

  function togglePanel(on) {
    state.panel = on == null ? !state.panel : on;
    if (state.panel) closeInspector(); // they share the right-hand side
    renderPanel();
    renderBar();
  }
  function pageLabel(p) { return clip(p.heading || p.title || p.key, 40) + '  ·  ' + clip(p.key, 44); }
  function renderPanel() {
    if (!state.panel) { if (panel) panel.remove(); panel = null; return; }
    if (!panel) { panel = h('div', { class: 'panel' }); ui.append(panel); }
    panel.classList.toggle('top', state.dockTop);
    const list = state.comments.filter(c => state.showResolved || c.status !== 'resolved').sort((a, b) => a.n - b.n);
    const groups = new Map();
    for (const c of list) {
      const k = (c.page && c.page.key) || '';
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(c);
    }
    const item = c => {
      const last = c.replies && c.replies[c.replies.length - 1];
      const note = c.status === 'question' ? 'Claude asked you something' : last && last.by === 'claude' ? 'Claude replied'
        : c.changes && c.changes.length ? `${c.changes.length} change${c.changes.length > 1 ? 's' : ''}` : '';
      return h('button', { class: 'item', 'data-act': 'item', 'data-id': c.id },
        h('span', { class: 'mini ' + c.status }, c.n),
        h('div', { class: 'item-c' }, h('div', { class: 'item-t' }, c.text), h('div', { class: 'item-s' }, [STATUS[c.status], c.from ? 'Reviewer' : '', ago(c.createdAt), note].filter(Boolean).join('  ·  '))));
    };
    panel.replaceChildren(
      h('div', { class: 'panel-h' }, h('b', null, 'Comments'), h('span', { class: 'muted' }, state.projectName), h('span', { class: 'grow' }), h('button', { class: 'x', 'data-act': 'list', title: 'Close' }, icon('close'))),
      h('button', { class: 'toggle' + (state.showResolved ? ' on' : ''), 'data-act': 'show-resolved' }, h('span', { class: 'box' }, state.showResolved ? icon('check') : null), 'Show resolved'),
      h('div', { class: 'panel-b' }, groups.size
        ? [...groups].map(([k, cs]) => [h('div', { class: 'group' + (k === state.url ? ' here' : ''), title: cs[0].page.href }, (k === state.url ? 'This page  ·  ' : '') + pageLabel(cs[0].page)), cs.map(item)])
        : h('div', { class: 'empty' }, state.comments.length ? 'Everything is resolved.' : 'No comments yet. Press C and click anywhere.')));
  }

  /* ---------- pins and cards ---------- */

  function renderPins() {
    const want = new Set();
    for (const c of state.comments) {
      if (!c.page || c.page.key !== state.url || (c.status === 'resolved' && !state.showResolved)) continue;
      want.add(c.id);
      let pin = pinEls.get(c.id);
      if (!pin) { pin = h('button', { class: 'pin', 'data-act': 'pin', 'data-id': c.id }); pinLayer.append(pin); pinEls.set(c.id, pin); }
      pin.className = 'pin ' + c.status + (state.openId === c.id ? ' on' : '');
      pin.textContent = c.n;
      pin.title = clip(c.text, 140);
    }
    for (const [id, pin] of pinEls) if (!want.has(id)) { pin.remove(); pinEls.delete(id); }
  }

  function closeCard() {
    if (previous.id) hidePrevious();
    if (card) card.remove();
    card = null;
    state.draft = null;
    state.chipHover = null;
    if (state.openId) { state.openId = null; renderPins(); }
  }
  function shake() {
    if (!card) return;
    card.classList.remove('shake');
    void card.offsetWidth;
    card.classList.add('shake');
    const ta = card.querySelector('textarea');
    if (ta) ta.focus({ preventScroll: true });
  }

  function openComposer() {
    const d = state.draft;
    const ta = h('textarea', { placeholder: 'What should change here?', rows: 3, 'data-role': 'new' });
    const post = h('button', { class: 'btn', 'data-act': 'post', disabled: true }, 'Post');
    ta.addEventListener('input', () => { d.text = ta.value; post.disabled = !ta.value.trim(); });
    card = h('div', { class: 'card', 'data-kind': 'new' },
      h('div', { class: 'card-h' }, h('b', null, 'New comment'), h('span', { class: 'grow' }), h('span', { class: 'sub', 'data-slot': 'comp' })),
      h('div', { class: 'label' }, 'Pinned to (click a chip to widen or narrow)'),
      h('div', { class: 'chips' }),
      ta,
      h('div', { class: 'card-f' },
        h('span', { class: 'hint', title: 'Shift+Enter for a new line' }, 'Enter to post'),
        h('span', { class: 'row' }, h('button', { class: 'btn ghost', 'data-act': 'cancel' }, 'Cancel'), post)));
    ui.append(card);
    renderChips();
    tick();
    requestAnimationFrame(() => ta.focus({ preventScroll: true }));
  }
  function renderChips() {
    const d = state.draft;
    if (!d || !card) return;
    const lo = Math.max(0, d.idx - 3), hi = Math.min(d.chain.length - 1, d.idx + 3);
    const kids = [];
    for (let i = hi; i >= lo; i--) {
      if (kids.length) kids.push(h('span', { class: 'crumb' }, '›'));
      kids.push(h('button', {
        class: 'chip' + (i === d.idx ? ' on' : ''), 'data-act': 'chip', 'data-i': i,
        title: (i === d.idx ? 'Pinned to this: ' : i > d.idx ? 'Widen to: ' : 'Narrow to: ') + textOf(d.chain[i], 60),
      }, clip(shortName(d.chain[i]), 26)));
    }
    card.querySelector('.chips').replaceChildren(...kids);
    card.querySelector('[data-slot=comp]').textContent = componentName(d.chain[d.idx]) || '';
  }

  // Comments from the shared link are a reviewer's. Someone viewing through that link sees the
  // comments made on the computer that runs the app as the owner's.
  function whoWrote(by) {
    if (by === 'claude') return 'Claude';
    if (by === 'reviewer') return 'Reviewer';
    return state.remote ? 'Owner' : 'You';
  }
  function msgEl(who, text, at) {
    return h('div', { class: 'msg' },
      h('div', null, h('span', { class: 'who' + (who === 'Claude' ? ' claude' : '') }, who), h('span', { class: 'when' }, ago(at))),
      h('div', { class: 'body' }, text));
  }
  function targetSummary(c) {
    const t = c.target || {};
    const comp = t.source && t.source.components && t.source.components[0] && t.source.components[0].name;
    const txt = t.text ? ` "${clip(t.text, 28)}"` : '';
    const onScreen = pointFor(c);
    return (comp ? comp + ' · ' : '') + (t.tag || 'element') + txt + (onScreen && !onScreen.attached ? '  (not on screen now)' : '');
  }
  function openPopover(id) {
    const c = byId(id);
    closeCard();
    if (!c) return;
    state.openId = id;
    const hasChanges = !!(c.changes && c.changes.length);
    const ta = h('textarea', { placeholder: c.status === 'question' ? 'Answer Claude' : 'Reply', rows: 2, 'data-role': 'reply' });
    card = h('div', { class: 'card', 'data-kind': 'pop', 'data-id': id },
      h('div', { class: 'card-h' },
        h('span', { class: 'num ' + c.status }, '#' + c.n), h('span', { class: 'sub' }, STATUS[c.status]),
        h('span', { class: 'grow' }), h('button', { class: 'x', 'data-act': 'close-card', title: 'Close (Esc)' }, icon('close'))),
      h('div', { class: 'thread' }, msgEl(whoWrote(c.from ? 'reviewer' : 'you'), c.text, c.createdAt), (c.replies || []).map(r => msgEl(whoWrote(r.by), r.text, r.at))),
      h('div', { class: 'meta', title: (c.target && c.target.selector) || '' }, 'On ' + targetSummary(c)),
      hasChanges ? h('div', { class: 'chlist' },
        h('div', { class: 'chlist-t' }, c.similar ? `Changes, on this and ${c.similar} look-alike${c.similar > 1 ? 's' : ''}` : 'Changes'),
        c.changes.map(x => h('div', null, `${x.prop}: ${x.from} → ${x.to}`))) : null,
      c.compare && c.compare.before ? compareBlock(c) : null,
      ta,
      h('div', { class: 'card-f' },
        h('button', { class: 'btn ghost danger', 'data-act': 'delete' }, 'Delete'),
        h('span', { class: 'row' },
          hasChanges && c.status !== 'resolved' ? h('button', { class: 'btn ghost', 'data-act': 'preview-comment', title: 'Show these changes on the page again' }, previewing(c) ? 'Hide preview' : 'Preview') : null,
          c.status === 'resolved'
            ? h('button', { class: 'btn ghost', 'data-act': 'reopen' }, 'Reopen')
            : h('button', { class: 'btn ghost', 'data-act': 'resolve' }, 'Resolve'),
          h('button', { class: 'btn', 'data-act': 'reply' }, 'Reply'))));
    ui.append(card);
    renderPins();
    tick();
  }
  /* ---------- compare: the element before and after Claude's change ---------- */

  // The page always shows the new design. The pin shows pictures of both, can lay the previous one over
  // the live element for a moment (nothing is saved), and records which one the user prefers.
  const shotCache = new Map();
  async function shotSrc(c, which) {
    const key = c.id + which + (c.compare[which] || '');
    if (shotCache.has(key)) return shotCache.get(key);
    const res = await fetch(API + '/comments/' + encodeURIComponent(c.id) + '/shot/' + which + '?project=' + encodeURIComponent(state.projectId || ''), {
      cache: 'no-store', headers: { 'x-ui-comments-token': TOKEN },
    });
    if (!res.ok) throw new Error('Picture not found');
    const url = URL.createObjectURL(await res.blob());
    shotCache.set(key, url);
    return url;
  }
  function compareBlock(c) {
    const both = !!c.compare.after;
    const chosen = c.decision && c.decision.choice;
    const block = h('div', { class: 'cmp' },
      h('div', { class: 'cmp-t' }, 'Compare'),
      both ? h('div', { class: 'cmp-seg' },
        h('button', { class: 'on', 'data-act': 'cmp-view', 'data-which': 'after' }, 'Now'),
        h('button', { 'data-act': 'cmp-view', 'data-which': 'before' }, 'Before')) : null,
      h('div', { class: 'cmp-frame' }, h('img', { class: 'cmp-img', 'data-role': 'cmp-img', alt: '' })),
      h('button', { class: 'btn ghost cmp-over', 'data-act': 'cmp-overlay' }, previous.id === c.id ? 'Hide previous' : 'Show previous here'),
      h('div', { class: 'cmp-t' }, 'Which one is better?'),
      h('div', { class: 'cmp-decide' },
        h('button', { class: 'btn ghost' + (chosen === 'new' ? ' picked' : ''), 'data-act': 'decide', 'data-choice': 'new' }, chosen === 'new' ? 'Keeping new' : 'Keep new'),
        h('button', { class: 'btn ghost' + (chosen === 'previous' ? ' picked' : ''), 'data-act': 'decide', 'data-choice': 'previous' }, chosen === 'previous' ? 'Bringing back previous' : 'Bring back previous')));
    showShot(c, both ? 'after' : 'before', block);
    return block;
  }
  async function showShot(c, which, root = card) {
    const img = root && root.querySelector('[data-role=cmp-img]');
    if (!img) return;
    root.querySelectorAll('.cmp-seg button').forEach(b => b.classList.toggle('on', b.dataset.which === which));
    try { img.src = await shotSrc(c, which); img.title = which === 'before' ? 'Before the change' : 'After the change (what the page shows now)'; }
    catch (err) { img.removeAttribute('src'); img.alt = err.message; }
  }
  // The previous picture laid over the live element, the size it was drawn at. Only a preview.
  const previous = { id: null, el: null };
  function hidePrevious() {
    if (previous.el) previous.el.remove();
    previous.id = null; previous.el = null;
    removeEventListener('scroll', hidePrevious, true);
  }
  async function togglePrevious(c, btn) {
    if (previous.id === c.id) { hidePrevious(); if (btn) btn.textContent = 'Show previous here'; return; }
    hidePrevious();
    const el = findAnchor(c);
    if (!el) return toast('The element is not on this page now.', true);
    const r = el.getBoundingClientRect();
    const src = await shotSrc(c, 'before').catch(() => null);
    if (!src) return toast('No before picture for this comment.', true);
    const img = h('img', { src, alt: '' });
    img.addEventListener('load', () => { img.style.width = img.naturalWidth / 2 + 'px'; });
    previous.el = h('div', { class: 'prev-over', title: 'Previous design (preview only)' }, img, h('span', { class: 'prev-tag' }, 'Previous'));
    previous.el.style.left = Math.round(r.left) + 'px';
    previous.el.style.top = Math.round(r.top) + 'px';
    ui.append(previous.el);
    previous.id = c.id;
    if (btn) btn.textContent = 'Hide previous';
    addEventListener('scroll', hidePrevious, true);
  }

  function focusComment(id) {
    const c = byId(id);
    if (!c) return;
    if (c.status === 'resolved' && !state.showResolved) { state.showResolved = true; renderPins(); if (state.panel) renderPanel(); }
    anchors.delete(id);
    const el = findAnchor(c);
    if (el) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    else if (c.pagePoint) scrollTo({ top: Math.max(0, c.pagePoint.y - innerHeight / 2), behavior: 'smooth' });
    openPopover(id);
  }
  function goTo(id) {
    const c = byId(id);
    if (!c) return;
    if (c.page.key === pageKey()) return focusComment(id);
    const u = new URL(c.page.href);
    if (u.origin === location.origin && u.pathname === location.pathname && u.search === location.search) {
      state.pendingOpen = id;
      location.hash = u.hash;
      return;
    }
    session.set('focus', id);
    location.assign(c.page.href);
  }
  function onRoute() {
    state.url = pageKey();
    closeCard();
    closeInspector();
    anchors.clear();
    renderPins();
    if (state.panel) renderPanel();
    if (state.pendingOpen) { const id = state.pendingOpen; state.pendingOpen = null; setTimeout(() => focusComment(id), 350); }
  }

  /* ---------- talking to the server ---------- */

  function replaceComment(c) {
    const i = state.comments.findIndex(x => x.id === c.id);
    if (i >= 0) state.comments[i] = c; else state.comments.push(c);
    anchors.delete(c.id);
    renderPins(); renderBar();
    if (state.panel) renderPanel();
  }
  async function submitDraft() {
    const d = state.draft;
    const text = d ? d.text.trim() : '';
    if (!d || !text || d.saving) return;
    d.saving = true;
    const post = card && card.querySelector('[data-act=post]');
    if (post) { post.disabled = true; post.textContent = 'Saving…'; }
    try {
      const c = await api('POST', '/comments', capture(d, text));
      if (state.draft === d) closeCard();
      replaceComment(c);
      toast(`Comment #${c.n} saved`);
    } catch (err) {
      d.saving = false;
      if (post && post.isConnected) { post.disabled = false; post.textContent = 'Post'; }
      toast(err.message, true);
    }
  }
  async function patch(id, body) {
    try {
      const c = await api('PATCH', '/comments/' + encodeURIComponent(id), { project: state.projectId, ...body });
      replaceComment(c);
      if (body.action === 'resolve') { toast(`Resolved #${c.n}`); if (state.showResolved) openPopover(id); else closeCard(); }
      else openPopover(id);
    } catch (err) { toast(err.message, true); }
  }
  async function sendReply() {
    if (!card || card.dataset.kind !== 'pop') return;
    const text = card.querySelector('textarea').value.trim();
    if (text) await patch(card.dataset.id, { action: 'reply', text });
  }
  async function confirmDelete(btn) {
    if (!btn.classList.contains('armed')) {
      btn.classList.add('armed');
      btn.textContent = 'Delete?';
      setTimeout(() => { if (btn.isConnected) { btn.classList.remove('armed'); btn.textContent = 'Delete'; } }, 3000);
      return;
    }
    const id = card.dataset.id;
    try {
      await api('DELETE', `/comments/${encodeURIComponent(id)}?project=${encodeURIComponent(state.projectId)}`);
      state.comments = state.comments.filter(c => c.id !== id);
      closeCard(); renderPins(); renderBar();
      if (state.panel) renderPanel();
      toast('Comment deleted');
    } catch (err) { toast(err.message, true); }
  }

  async function sync() {
    const s = await api('GET', '/state');
    if (state.offline) { state.offline = false; barSig = ''; }
    const switched = s.projectId !== state.projectId;
    state.projects = s.projects;
    state.projectId = s.projectId;
    state.projectName = s.projectName;
    state.fixed = !!s.fixed;
    state.remote = !!s.remote;
    const sig = s.comments.map(c => c.id + '@' + c.updatedAt).join('|');
    if (switched || sig !== state.sig) {
      state.sig = sig;
      state.comments = s.comments;
      anchors.clear();
      if (switched) closeCard();
      renderPins();
      if (state.panel) renderPanel();
      // Claude may have replied to the thread you have open.
      if (card && card.dataset.kind === 'pop' && !card.querySelector('textarea').value.trim()) openPopover(card.dataset.id);
    }
    renderBar();
  }
  function onSyncError(err) {
    if (err.auth) { if (!state.authWarned) { state.authWarned = true; toast(err.message, true); } return; }
    if (!state.offline) { state.offline = true; barSig = ''; renderBar(); }
  }

  /* ---------- live edits: previews on the page, never saved by themselves ---------- */

  // An edit is an inline style (with !important, so it wins over class rules) on the live element, or
  // new text in its text node. A reload, Reset or closing the tool removes it; only a comment keeps it.
  const tweaks = [];               // { el, key, selector, tag, props: Map(prop -> { from, to }), similar, peers }
  const originals = new WeakMap(); // element -> { style, text } as they were before any preview
  let lastRefresh = 0;

  const tweakOf = el => (el && tweaks.find(t => t.el === el)) || null;
  // An element whose content is only text. React often splits one line into several text nodes
  // ("Council {year} election"), so editing writes into those nodes rather than replacing them.
  const textNodesOf = el => (el && el.childNodes.length && [...el.childNodes].every(n => n.nodeType === 3) ? [...el.childNodes] : null);
  const wordsOf = el => { const ns = textNodesOf(el); return ns ? ns.map(n => n.data).join('') : null; };
  const changeCount = () => tweaks.reduce((n, t) => n + t.props.size, 0);
  const round2 = v => Math.round(v * 100) / 100;

  function remember(n) {
    if (originals.has(n)) return;
    const ns = textNodesOf(n);
    originals.set(n, { style: n.getAttribute('style'), text: ns ? ns.map(x => x.data) : null });
  }
  function restore(n) {
    const o = originals.get(n);
    if (!o) return;
    if (o.style == null) n.removeAttribute('style'); else n.setAttribute('style', o.style);
    const ns = textNodesOf(n);
    if (o.text && ns && ns.length === o.text.length) ns.forEach((x, i) => { if (x.data !== o.text[i]) x.data = o.text[i]; });
    originals.delete(n);
  }
  function paint(t) {
    for (const n of [t.el, ...(t.similar ? t.peers : [])]) {
      restore(n);
      if (!n.isConnected || !t.props.size) continue;
      remember(n);
      for (const [p, v] of t.props) {
        // New text only on the element itself: look-alikes (the other tabs) keep their own words.
        if (p === 'text') { const ns = textNodesOf(n); if (ns && n === t.el) ns.forEach((x, i) => { x.data = i ? '' : v.to; }); }
        else n.style.setProperty(p, v.to, 'important');
      }
    }
  }
  function lookalikes(el) {
    const cls = el.getAttribute('class');
    if (!cls) return [];
    return [...document.getElementsByTagName(el.localName)].filter(n => n !== el && n.getAttribute('class') === cls);
  }

  function setProp(el, prop, value) {
    if (!el) return;
    const v = prop === 'text' ? String(value) : String(value).trim();
    if (!v && prop !== 'text') return resetProp(el, prop);
    let t = tweakOf(el);
    if (!t) {
      const similar = !!(state.edit && editEl() === el && state.edit.similar);
      t = { el, key: pageKey(), selector: cssPath(el), tag: el.localName, props: new Map(), similar, peers: similar ? lookalikes(el) : [] };
      tweaks.push(t);
    }
    const had = t.props.get(prop);
    if (!had) {
      const from = prop === 'text' ? (wordsOf(el) || '') : getComputedStyle(el).getPropertyValue(prop).trim();
      if (v === from) { if (!t.props.size) dropTweak(t); return; }
      t.props.set(prop, { from, to: v });
      // A border width shows nothing while that side's style is "none", so give it a solid line.
      const side = prop.match(/^border-(top|right|bottom|left)-width$/);
      const styleProp = side && `border-${side[1]}-style`;
      if (side && parseFloat(v) > 0 && !t.props.has(styleProp) && getComputedStyle(el).getPropertyValue(styleProp) === 'none') {
        t.props.set(styleProp, { from: 'none', to: 'solid' });
      }
    } else if (v === had.from) t.props.delete(prop);
    else had.to = v;
    paint(t);
    if (!t.props.size) dropTweak(t);
    afterTweak();
  }
  function resetProp(el, prop) {
    const t = tweakOf(el);
    if (!t || !t.props.delete(prop)) return;
    paint(t);
    if (!t.props.size) dropTweak(t);
    afterTweak();
  }
  function dropTweak(t) {
    for (const n of [t.el, ...t.peers]) restore(n);
    const i = tweaks.indexOf(t);
    if (i >= 0) tweaks.splice(i, 1);
  }
  function resetAll() {
    for (const t of [...tweaks]) dropTweak(t);
    afterTweak();
  }
  function setSimilar(t, on) {
    for (const n of t.peers) restore(n);
    t.similar = on;
    t.peers = on ? lookalikes(t.el) : [];
    paint(t);
    afterTweak();
  }
  function afterTweak() { renderBar(); syncInspector(); }

  // React may redraw an edited element (a new node) or rewrite its style attribute: put the preview back.
  function refreshTweaks() {
    for (const t of tweaks) {
      if (t.key !== pageKey()) continue;
      let again = false;
      if (!t.el.isConnected) {
        let el = null;
        try { el = document.querySelector(t.selector); } catch (e) {}
        if (!el || el.localName !== t.tag) continue;
        t.el = el;
        again = true;
      }
      if (t.similar) {
        const fresh = lookalikes(t.el);
        if (fresh.length !== t.peers.length || fresh.some((n, i) => n !== t.peers[i])) {
          for (const n of t.peers) if (!fresh.includes(n)) restore(n);
          t.peers = fresh;
          again = true;
        }
      }
      for (const [p] of t.props) if (p !== 'text' && t.el.style.getPropertyPriority(p) !== 'important') again = true;
      if (again) paint(t);
    }
    // The element being edited may have been redrawn too.
    const se = editEl();
    if (se && !se.isConnected && state.edit.selector) {
      let el = null;
      try { el = document.querySelector(state.edit.selector); } catch (e) {}
      if (el && el.localName === se.localName) {
        state.edit = { chain: chainOf(el), idx: 0, similar: state.edit.similar, selector: state.edit.selector, free: state.edit.free };
        openInspector();
      }
    }
  }

  /* ---------- the edit panel ---------- */

  let insp = null, palette = null, cssTimer = 0;
  const editEl = () => (state.edit ? state.edit.chain[state.edit.idx] : null);

  function selectForEdit(el) {
    const t = tweakOf(el);
    state.edit = { chain: chainOf(el), idx: 0, similar: t ? t.similar : false, selector: cssPath(el), free: [] };
    if (state.panel) togglePanel(false);
    closeCard();
    openInspector();
  }
  function closePalette() { if (palette) { palette.remove(); palette = null; } }
  function closeInspector() {
    closePalette();
    if (insp) insp.remove();
    insp = null;
    state.edit = null;
  }

  // What a field shows: the preview if there is one, else what the page computes.
  function valueOf(prop) {
    const el = editEl();
    const t = tweakOf(el);
    const tw = t && t.props.get(prop);
    if (tw) return tw.to;
    if (prop === 'text') return wordsOf(el) || '';
    return getComputedStyle(el).getPropertyValue(prop).trim();
  }
  function colorText(v) {
    const m = String(v).match(/^rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)$/);
    if (!m) return v;
    const hex = '#' + [m[1], m[2], m[3]].map(x => (+x).toString(16).padStart(2, '0')).join('').toUpperCase();
    if (m[4] != null && +m[4] === 0) return 'transparent';
    return m[4] != null && +m[4] < 1 ? `${hex} ${Math.round(+m[4] * 100)}%` : hex;
  }
  const hex6 = v => { const s = colorText(v); return /^#[0-9A-F]{6}$/.test(s) ? s.toLowerCase() : '#000000'; };
  function display(prop, kind) {
    const v = valueOf(prop);
    if (kind === 'pct') return String(Math.round(parseFloat(v) * 100));
    if (kind === 'color') return colorText(v);
    return /^-?\d*\.?\d+px$/.test(v) ? String(round2(parseFloat(v))) : v;
  }
  // The thickest side's colour, for a swatch that stands for "border-color".
  function strokeSide(el) {
    const cs = getComputedStyle(el);
    const sides = ['top', 'right', 'bottom', 'left'].sort((a, b) => parseFloat(cs.getPropertyValue(`border-${b}-width`)) - parseFloat(cs.getPropertyValue(`border-${a}-width`)));
    return `border-${sides[0]}-color`;
  }
  // Typed text to a CSS value: bare numbers are px (a small line height is a ratio), "#C33531 50%" is
  // that colour at half strength. null means "not valid yet", '' means "back to the page's own value".
  function toCss(prop, raw, kind) {
    raw = String(raw).trim();
    if (!raw) return '';
    if (kind === 'pct') { const n = parseFloat(raw); return isNaN(n) ? null : String(Math.max(0, Math.min(100, n)) / 100); }
    if (kind === 'color') {
      const m = raw.match(/^#?([0-9a-f]{6})\s+(\d{1,3})%$/i);
      if (m) { const n = parseInt(m[1], 16); return `rgba(${n >> 16}, ${(n >> 8) & 255}, ${n & 255}, ${Math.min(100, +m[2]) / 100})`; }
      if (/^[0-9a-f]{6}$/i.test(raw)) raw = '#' + raw;
      return CSS.supports('color', raw) ? raw : null;
    }
    if (/^-?\d*\.?\d+$/.test(raw)) return prop === 'line-height' && parseFloat(raw) < 4 ? raw : raw + 'px';
    return CSS.supports(prop, raw) ? raw : null;
  }
  function applyInput(inp) {
    const prop = inp.dataset.prop;
    if (inp.dataset.kind === 'text') return setProp(editEl(), 'text', inp.value);
    const css = toCss(prop, inp.value, inp.dataset.kind);
    inp.classList.toggle('bad', css === null);
    if (css === null) return;
    if (css === '') resetProp(editEl(), prop); else setProp(editEl(), prop, css);
  }

  function field(prop, kind = 'pos') {
    const wide = kind === 'color' || kind === 'text' || kind === 'free';
    const inp = h('input', { class: 'pf' + (wide ? ' wide' : ''), 'data-prop': prop, 'data-kind': kind, spellcheck: 'false', autocomplete: 'off', title: prop });
    inp.value = display(prop, kind);
    inp.addEventListener('input', () => applyInput(inp));
    return inp;
  }
  const cell = (letter, inp) => h('span', { class: 'cell', 'data-l': letter }, inp);
  function row(label, props, controls, scrub) {
    return h('div', { class: 'prow', 'data-props': props.join(' ') },
      h('label', { class: 'pl' + (scrub ? ' scrub' : ''), 'data-scrub': scrub ? props[0] : null, title: scrub ? 'Drag left or right to change' : props.join(', ') }, label),
      h('div', { class: 'pc' }, controls),
      h('button', { class: 'undo1', 'data-act': 'reset-prop', 'data-props': props.join(' '), title: 'Undo this change' }, '↺'));
  }
  const numRow = (label, prop, kind) => row(label, [prop], [field(prop, kind)], true);
  const quadRow = (label, props, kind) => row(label, props, [h('div', { class: 'quad' }, props.map((p, i) => cell('TRBL'[i], field(p, kind))))], false);
  const colorRow = (label, prop) => row(label, [prop], [h('button', { class: 'swatch', 'data-act': 'swatch', 'data-prop': prop, title: 'Pick from the project colours' }), field(prop, 'color')], false);
  function selectRow(label, prop, options) {
    const cur = valueOf(prop);
    const sel = h('select', { class: 'pf wide', 'data-prop': prop, 'data-kind': 'select' },
      (options.includes(cur) ? options : [cur, ...options]).map(o => h('option', { value: o, selected: o === cur }, o)));
    sel.addEventListener('change', () => setProp(editEl(), prop, sel.value));
    return row(label, [prop], [sel], false);
  }
  const segRow = (label, prop, items) => row(label, [prop], [h('div', { class: 'seg' },
    items.map(([v, txt]) => h('button', { 'data-act': 'seg', 'data-prop': prop, 'data-value': v, title: v }, txt)))], false);

  function openInspector() {
    closePalette();
    const el = editEl();
    if (!el) return closeInspector();
    if (!insp) { insp = h('div', { class: 'insp' }); ui.append(insp); }
    insp.classList.toggle('top', state.dockTop);
    const d = state.edit;
    const flexy = /flex|grid/.test(getComputedStyle(el).display);
    const peers = lookalikes(el).length;
    const comp = componentName(el);
    const chips = [];
    for (let i = Math.min(d.chain.length - 1, d.idx + 2); i >= Math.max(0, d.idx - 3); i--) {
      if (chips.length) chips.push(h('span', { class: 'crumb' }, '›'));
      chips.push(h('button', { class: 'chip' + (i === d.idx ? ' on' : ''), 'data-act': 'echip', 'data-i': i, title: textOf(d.chain[i], 60) }, clip(shortName(d.chain[i]), 22)));
    }
    const sec = (title, ...kids) => h('div', { class: 'sec' }, h('div', { class: 'sec-t' }, title), kids);
    insp.replaceChildren(...[
      h('div', { class: 'insp-h' }, h('b', { title: readablePath(el) }, (comp ? comp + ' · ' : '') + shortName(el)), h('span', { class: 'grow' }),
        h('button', { class: 'x', 'data-act': 'insp-close', title: 'Close (Esc)' }, icon('close'))),
      h('div', { class: 'chips' }, chips),
      peers ? h('button', { class: 'chk' + (d.similar ? ' on' : ''), 'data-act': 'similar', title: 'Elements with the same tag and classes, such as the other tabs in a row' },
        h('span', { class: 'box' }, d.similar ? icon('check') : null), `Also preview on the ${peers} look-alike${peers > 1 ? 's' : ''}`) : null,
      h('div', { class: 'insp-b' },
        sec('Text',
          colorRow('Colour', 'color'),
          numRow('Size', 'font-size'),
          selectRow('Weight', 'font-weight', ['100', '200', '300', '400', '500', '600', '700', '800', '900']),
          numRow('Line', 'line-height'),
          numRow('Letter', 'letter-spacing', 'len'),
          segRow('Align', 'text-align', [['left', 'Left'], ['center', 'Centre'], ['right', 'Right']]),
          selectRow('Case', 'text-transform', ['none', 'uppercase', 'lowercase', 'capitalize']),
          wordsOf(el) ? row('Words', ['text'], [field('text', 'text')], false) : null),
        sec('Fill', colorRow('Colour', 'background-color')),
        sec('Stroke',
          quadRow('Width', ['border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width']),
          selectRow('Style', 'border-style', ['none', 'solid', 'dashed', 'dotted', 'double']),
          colorRow('Colour', 'border-color'),
          numRow('Radius', 'border-radius')),
        sec('Layout',
          row('Size', ['width', 'height'], [cell('W', field('width')), cell('H', field('height'))], false),
          quadRow('Padding', ['padding-top', 'padding-right', 'padding-bottom', 'padding-left']),
          quadRow('Margin', ['margin-top', 'margin-right', 'margin-bottom', 'margin-left'], 'len'),
          flexy ? numRow('Gap', 'gap') : null),
        sec('Effects',
          numRow('Opacity %', 'opacity', 'pct'),
          row('Shadow', ['box-shadow'], [field('box-shadow', 'free')], false)),
        sec('Any other CSS', h('textarea', { class: 'pcss', 'data-role': 'css', rows: 2, placeholder: 'transform: scale(1.02);', spellcheck: 'false' }))),
      h('div', { class: 'insp-f' },
        h('div', { class: 'chg' }, h('span', { 'data-slot': 'count' }), h('span', { class: 'row' },
          h('button', { class: 'btn ghost', 'data-act': 'reset-el' }, 'Reset'),
          h('button', { class: 'btn ghost', 'data-act': 'reset-all', 'data-slot': 'all' }, 'Reset all'))),
        h('textarea', { 'data-role': 'note', rows: 2, placeholder: 'A note for Claude (optional)' }),
        h('button', { class: 'btn', 'data-act': 'comment-changes' }, 'Comment these changes')),
    ].filter(Boolean));
    const css = insp.querySelector('[data-role=css]');
    css.value = (d.free || []).map(p => `${p}: ${valueOf(p)};`).join('\n');
    css.addEventListener('input', () => { clearTimeout(cssTimer); cssTimer = setTimeout(() => freeCss(css.value), 300); });
    syncInspector();
  }

  // Bring every field in line with the page, except the one being typed in.
  function syncInspector() {
    const el = editEl();
    if (!insp || !el) return;
    const t = tweakOf(el);
    const changed = p => !!(t && t.props.has(p));
    for (const r of insp.querySelectorAll('.prow')) r.classList.toggle('changed', r.dataset.props.split(' ').some(changed));
    const active = root.activeElement;
    for (const inp of insp.querySelectorAll('input.pf')) {
      if (inp === active) continue;
      inp.value = display(inp.dataset.prop, inp.dataset.kind);
      inp.classList.remove('bad');
    }
    for (const sel of insp.querySelectorAll('select.pf')) {
      const v = valueOf(sel.dataset.prop);
      if (![...sel.options].some(o => o.value === v)) sel.prepend(h('option', { value: v }, v));
      sel.value = v;
    }
    for (const b of insp.querySelectorAll('[data-act=seg]')) b.classList.toggle('on', valueOf(b.dataset.prop) === b.dataset.value);
    const cs = getComputedStyle(el);
    for (const sw of insp.querySelectorAll('.swatch')) sw.style.background = cs.getPropertyValue(sw.dataset.prop === 'border-color' ? strokeSide(el) : sw.dataset.prop);
    const n = t ? t.props.size : 0, total = changeCount();
    insp.querySelector('[data-slot=count]').textContent = n
      ? `${n} change${n > 1 ? 's' : ''} here${total > n ? `, ${total} on the page` : ''}`
      : total ? `${total} change${total > 1 ? 's' : ''} elsewhere on the page` : 'Edits are previews. Nothing is saved.';
    insp.querySelector('[data-act=reset-el]').disabled = !n;
    insp.querySelector('[data-slot=all]').style.display = total > n ? '' : 'none';
    insp.querySelector('[data-act=comment-changes]').disabled = !n;
  }

  function freeCss(text) {
    const el = editEl();
    if (!el) return;
    const decls = new Map();
    for (const part of text.split(/[;\n]/)) {
      const i = part.indexOf(':');
      if (i < 1) continue;
      const p = part.slice(0, i).trim().toLowerCase(), v = part.slice(i + 1).trim();
      if (/^-{0,2}[a-z][a-z0-9-]*$/.test(p) && v && CSS.supports(p, v)) decls.set(p, v);
    }
    for (const p of state.edit.free || []) if (!decls.has(p)) resetProp(el, p);
    for (const [p, v] of decls) setProp(el, p, v);
    state.edit.free = [...decls.keys()];
  }

  // Every custom property the page's own stylesheets define, as this element resolves it, that is a colour.
  function colourTokens(el) {
    const names = new Set();
    const walk = rules => {
      for (const r of rules) {
        if (r.style) for (let i = 0; i < r.style.length; i++) if (r.style[i].startsWith('--')) names.add(r.style[i]);
        if (r.cssRules) walk(r.cssRules);
      }
    };
    for (const s of document.styleSheets) { try { walk(s.cssRules); } catch (e) {} }
    const cs = getComputedStyle(el);
    const out = [];
    for (const name of names) {
      const v = cs.getPropertyValue(name).trim();
      if (v && !/^(inherit|initial|unset|currentcolor|transparent)$/i.test(v) && CSS.supports('color', v)) out.push({ name, value: v });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }
  function openPalette(btn) {
    closePalette();
    const el = editEl(), prop = btn.dataset.prop;
    const toks = colourTokens(el);
    const search = h('input', { class: 'pf wide', 'data-kind': 'search', spellcheck: 'false', autocomplete: 'off',
      placeholder: toks.length ? `Search ${toks.length} project colours` : 'No colour tokens on this page' });
    const list = h('div', { class: 'pal-list' });
    const draw = () => {
      const q = search.value.trim().toLowerCase();
      const hits = toks.filter(t => !q || t.name.toLowerCase().includes(q) || t.value.toLowerCase().includes(q)).slice(0, 300);
      list.replaceChildren(...(hits.length
        ? hits.map(t => h('button', { class: 'tok', 'data-act': 'tok', 'data-prop': prop, 'data-value': `var(${t.name})`, title: `${t.name}: ${t.value}` },
          h('i', { style: `background:${t.value}` }), h('span', null, t.name.replace(/^--/, '')), h('em', null, clip(colorText(t.value), 16))))
        : [h('div', { class: 'pal-empty' }, toks.length ? 'No match.' : 'Type a colour in the field, or pick a custom one.')]));
    };
    search.addEventListener('input', draw);
    draw();
    const native = h('input', { type: 'color', class: 'native', tabindex: '-1' });
    native.value = hex6(getComputedStyle(el).getPropertyValue(prop === 'border-color' ? strokeSide(el) : prop));
    native.addEventListener('input', () => setProp(editEl(), prop, native.value));
    palette = h('div', { class: 'palette', 'data-prop': prop }, search, list,
      h('div', { class: 'pal-f' }, h('button', { class: 'btn ghost', 'data-act': 'custom-colour' }, 'Custom colour…'), native));
    ui.append(palette);
    const r = btn.getBoundingClientRect(), ir = insp.getBoundingClientRect();
    palette.style.left = ir.left + 8 + 'px';
    palette.style.width = ir.width - 16 + 'px';
    const ph = palette.offsetHeight;
    palette.style.top = (r.bottom + 4 + ph < innerHeight - 8 ? r.bottom + 4 : Math.max(8, r.top - ph - 4)) + 'px';
    search.focus({ preventScroll: true });
  }

  async function commentChanges() {
    const el = editEl();
    const t = tweakOf(el);
    if (!t || !t.props.size) return toast('Change something first. For a plain note, use Comment (C).', true);
    if (!state.projectId) return toast('No project yet. In Claude, say: I want comment functionality in this project.', true);
    const noteBox = insp.querySelector('[data-role=note]');
    const note = noteBox.value.trim();
    const changes = [...t.props].map(([prop, v]) => ({ prop, from: v.from, to: v.to }));
    // Describe the element as it really is, without the preview.
    for (const n of [t.el, ...(t.similar ? t.peers : [])]) restore(n);
    let target;
    try { target = describe(el); } finally { paint(t); }
    const r = el.getBoundingClientRect();
    try {
      const c = await api('POST', '/comments', {
        project: state.projectId,
        text: note || clip('Try: ' + changes.map(x => `${x.prop} ${x.to}`).join(', '), 200),
        kind: 'point',
        page: pageInfo(),
        target,
        clicked: null,
        anchor: { ox: 1, oy: 0 },
        region: null,
        pagePoint: { x: Math.round(r.right + scrollX), y: Math.round(r.top + scrollY) },
        changes,
        similar: t.similar ? t.peers.length : 0,
      });
      replaceComment(c);
      noteBox.value = '';
      if (!c.changes) toast('Saved, but this server is running older code and dropped the changes. Restart the dev server, then comment again.', true);
      else toast(`Comment #${c.n} saved with ${changes.length} change${changes.length > 1 ? 's' : ''}`);
    } catch (err) { toast(err.message, true); }
  }

  // Put a comment's changes back on the page, or take them off again.
  function previewing(c) {
    const el = findAnchor(c), t = tweakOf(el);
    return !!t && c.changes.every(x => t.props.has(x.prop) && t.props.get(x.prop).to === x.to);
  }
  function previewComment(id) {
    const c = byId(id);
    const el = c && findAnchor(c);
    if (!el) return toast('That element is not on this screen right now.', true);
    if (previewing(c)) for (const x of c.changes) resetProp(el, x.prop);
    else {
      for (const x of c.changes) setProp(el, x.prop, x.to);
      const t = tweakOf(el);
      if (c.similar && t && !t.similar) setSimilar(t, true);
    }
    openPopover(id);
  }

  /* ---------- modes and input ---------- */

  // idle: the page works as usual. comment: clicks place comments. edit: clicks pick an element to restyle.
  function setMode(m) {
    if (m === 'comment' && !state.projectId) {
      toast(state.offline ? 'The comment server is not running. Ask Claude to start it.' : 'No project yet. In Claude, say: I want comment functionality in this project.', true);
      return;
    }
    if (m !== 'idle' && state.collapsed) { state.collapsed = false; local.set('collapsed', null); }
    if (state.mode !== m) {
      if (state.draft) closeCard();
      if (m !== 'edit') closeInspector();
      state.mode = m;
      state.hover = null;
      state.drag = null;
    }
    document.documentElement.classList.toggle('uic-on', m !== 'idle');
    document.documentElement.classList.toggle('uic-edit', m === 'edit');
    renderBar();
  }
  const toggleMode = m => setMode(state.mode === m ? 'idle' : m);
  function escape() {
    if (palette) closePalette();
    else if (menu) closeMenu();
    else if (card) closeCard();
    else if (state.edit) closeInspector();
    else if (state.panel) togglePanel(false);
    else if (state.mode !== 'idle') setMode('idle');
  }

  const isOurs = e => e.composedPath().includes(host);

  function onAny(e) {
    // A drag on a panel label that ends over the page still belongs to the panel.
    if (state.scrub && e.type === 'pointerup') { state.scrub = null; e.preventDefault(); e.stopPropagation(); return; }
    if (isOurs(e)) {
      if (e.type === 'click') onOurClick(e);
      else if (e.type === 'keydown') onOurKey(e);
      else if (e.type === 'pointerdown') onOurDown(e);
      e.stopPropagation(); // keep the page (focus traps, shortcuts, outside-click handlers) out of it
      return;
    }
    onPage(e);
  }

  function onOurDown(e) {
    const path = e.composedPath();
    const acts = path.filter(n => n.nodeType === 1 && n.hasAttribute('data-act')).map(n => n.getAttribute('data-act'));
    if (menu && !path.includes(menu) && !acts.includes('project')) closeMenu();
    if (palette && !path.includes(palette) && !acts.includes('swatch')) closePalette();
    const label = path.find(n => n.nodeType === 1 && n.hasAttribute('data-scrub'));
    if (label && e.button === 0 && insp) {
      const inp = insp.querySelector(`input.pf[data-prop="${CSS.escape(label.getAttribute('data-scrub'))}"]`);
      const m = inp && inp.value.match(/^(-?\d*\.?\d+)(.*)$/);
      if (m) { state.scrub = { inp, x: e.clientX, v: parseFloat(m[1]), unit: m[2] }; e.preventDefault(); }
    }
  }

  function onPage(e) {
    const t = e.type;
    if (t === 'keydown') return onPageKey(e);
    if (state.mode === 'idle') {
      if (t === 'pointerdown') { closeMenu(); if (card && card.dataset.kind === 'pop') closeCard(); }
      return;
    }
    if (t === 'keyup' || t === 'keypress' || t === 'focusin' || t === 'focusout') return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (state.mode === 'edit') {
      if (t === 'pointerdown' && e.button === 0) { closeMenu(); closePalette(); if (card) closeCard(); }
      else if (t === 'pointerup' && e.button === 0) selectForEdit(pickAt(e.clientX, e.clientY));
      return;
    }
    if (t === 'pointerdown' && e.button === 0) {
      closeMenu();
      if (card && card.dataset.kind === 'pop') { closeCard(); return; }
      if (state.draft && state.draft.text.trim()) { shake(); return; }
      state.drag = { x: e.clientX, y: e.clientY, x2: e.clientX, y2: e.clientY, moved: false };
    } else if (t === 'pointerup' && e.button === 0) {
      const g = state.drag;
      state.drag = null;
      if (!g) return;
      if (g.moved) startRegion(dragRect(g)); else startPoint(e.clientX, e.clientY);
    }
  }

  function onMove(e) {
    if (state.scrub) {
      const s = state.scrub, kind = s.inp.dataset.kind;
      let v = s.v + Math.round((e.clientX - s.x) / 4) * (e.shiftKey ? 10 : 1);
      if (kind !== 'len') v = Math.max(0, v);
      if (kind === 'pct') v = Math.min(100, v);
      s.inp.value = round2(v) + s.unit;
      applyInput(s.inp);
      return;
    }
    if (isOurs(e)) { state.hover = null; return; }
    state.chipHover = null;
    if (state.mode === 'idle') return;
    if (state.mode === 'edit') { state.hover = pickAt(e.clientX, e.clientY); return; }
    const g = state.drag;
    if (g) {
      g.x2 = e.clientX; g.y2 = e.clientY;
      if (!g.moved && Math.hypot(g.x2 - g.x, g.y2 - g.y) > 6) g.moved = true;
      return;
    }
    state.hover = state.draft ? null : pickAt(e.clientX, e.clientY);
  }

  function onPageKey(e) {
    const t = e.composedPath()[0] || e.target;
    const typing = t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName || ''));
    if (e.key === 'Escape') {
      if (palette || menu || card || state.panel || state.edit || state.mode !== 'idle') { e.preventDefault(); e.stopImmediatePropagation(); escape(); }
      return;
    }
    if (typing || e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
    const k = e.key.toLowerCase();
    if (k === 'c' || k === 'e') { e.preventDefault(); e.stopImmediatePropagation(); toggleMode(k === 'c' ? 'comment' : 'edit'); }
  }

  function onOurKey(e) {
    const t = e.composedPath()[0];
    const tag = t && t.tagName;
    if (e.key === 'Escape') {
      e.preventDefault();
      // The first Esc leaves a panel field; the next one closes things.
      if (insp && insp.contains(t) && /^(INPUT|TEXTAREA|SELECT)$/.test(tag)) t.blur(); else escape();
      return;
    }
    if (tag === 'INPUT' && t.classList.contains('pf')) {
      const kind = t.dataset.kind;
      if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && /^(pos|len|pct)$/.test(kind)) {
        const m = t.value.match(/^(-?\d*\.?\d+)(.*)$/);
        if (!m) return;
        e.preventDefault();
        let v = parseFloat(m[1]) + (e.key === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? 10 : e.altKey ? 0.1 : 1);
        if (kind !== 'len') v = Math.max(0, v);
        if (kind === 'pct') v = Math.min(100, v);
        t.value = round2(v) + m[2];
        applyInput(t);
      } else if (e.key === 'Enter') { e.preventDefault(); t.blur(); }
      return;
    }
    if (tag === 'TEXTAREA' && e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
      const role = t.getAttribute('data-role');
      if (role === 'css') return;
      e.preventDefault();
      if (role === 'reply') sendReply(); else if (role === 'note') commentChanges(); else submitDraft();
    }
  }

  function onOurClick(e) {
    const el = e.composedPath().find(n => n.nodeType === 1 && n.hasAttribute('data-act'));
    if (!el) return;
    const a = el.getAttribute('data-act');
    const id = el.getAttribute('data-id');
    switch (a) {
      case 'mode': toggleMode('comment'); break;
      case 'editmode': toggleMode('edit'); break;
      case 'list': togglePanel(); break;
      case 'project': toggleMenu(el); break;
      case 'pick-project': pickProject(id); break;
      case 'dock':
        state.dockTop = !state.dockTop;
        local.set('dockTop', state.dockTop ? '1' : null);
        closeMenu(); renderBar(); renderPanel();
        if (insp) insp.classList.toggle('top', state.dockTop);
        break;
      case 'close': if (AUTO) setCollapsed(true); else destroy(); break;
      case 'expand': setCollapsed(false); break;
      case 'post': submitDraft(); break;
      case 'cancel': case 'close-card': closeCard(); break;
      case 'chip': retarget(+el.getAttribute('data-i')); break;
      case 'pin': if (state.openId === id) closeCard(); else openPopover(id); break;
      case 'resolve': case 'reopen': patch(card.dataset.id, { action: a }); break;
      case 'reply': sendReply(); break;
      case 'delete': confirmDelete(el); break;
      case 'item': goTo(id); break;
      case 'show-resolved': state.showResolved = !state.showResolved; renderPins(); renderPanel(); break;
      case 'preview-comment': previewComment(card.dataset.id); break;
      case 'cmp-view': showShot(byId(card.dataset.id), el.dataset.which); break;
      case 'cmp-overlay': togglePrevious(byId(card.dataset.id), el); break;
      case 'decide': patch(card.dataset.id, { action: 'decide', choice: el.dataset.choice }); break;
      case 'insp-close': closeInspector(); break;
      case 'echip': state.edit.idx = +el.getAttribute('data-i'); state.edit.free = []; openInspector(); break;
      case 'seg': setProp(editEl(), el.dataset.prop, el.dataset.value); break;
      case 'swatch': if (palette && palette.dataset.prop === el.dataset.prop) closePalette(); else openPalette(el); break;
      case 'tok': setProp(editEl(), el.dataset.prop, el.dataset.value); closePalette(); break;
      case 'custom-colour': palette.querySelector('input[type=color]').click(); break;
      case 'reset-prop': for (const p of el.dataset.props.split(' ')) resetProp(editEl(), p); break;
      case 'reset-el': { const t = tweakOf(editEl()); if (t) { dropTweak(t); afterTweak(); } break; }
      case 'reset-all': resetAll(); break;
      case 'similar': {
        state.edit.similar = !state.edit.similar;
        const t = tweakOf(editEl());
        if (t) setSimilar(t, state.edit.similar);
        openInspector();
        break;
      }
      case 'comment-changes': commentChanges(); break;
    }
  }

  function onChipHover(e) {
    const chip = e.target && e.target.closest ? e.target.closest('[data-act="chip"]') : null;
    state.chipHover = chip ? +chip.getAttribute('data-i') : null;
  }

  function destroy() {
    resetAll();
    closeInspector();
    dead = true;
    cancelAnimationFrame(raf);
    clearInterval(pollTimer);
    clearTimeout(toastTimer);
    for (const t of STOP) window.removeEventListener(t, onAny, true);
    window.removeEventListener('pointermove', onMove, true);
    document.documentElement.classList.remove('uic-on', 'uic-edit');
    pageStyle.remove();
    host.remove();
    delete window.__uiComments;
  }

  /* ---------- start ---------- */

  document.documentElement.append(host);
  (document.head || document.documentElement).append(pageStyle);
  for (const t of STOP) window.addEventListener(t, onAny, true);
  window.addEventListener('pointermove', onMove, true);
  root.addEventListener('pointerover', onChipHover);
  window.__uiComments = { toggle: () => toggleMode('comment'), destroy, version: 2 };

  renderBar();
  raf = requestAnimationFrame(frame);
  sync().then(() => {
    const focus = session.get('focus');
    if (focus) { session.set('focus', null); setTimeout(() => focusComment(focus), 400); }
    // A bookmarklet click means "I want to comment"; a page load from the dev server does not.
    if (AUTO) return;
    if (state.projectId) setMode('comment');
    else toast('No project yet. In Claude, say: I want comment functionality in this project.', true);
  }).catch(err => { onSyncError(err); toast(err.message, true); });
  pollTimer = setInterval(() => { if (!document.hidden) sync().catch(onSyncError); }, 3000);
})();
