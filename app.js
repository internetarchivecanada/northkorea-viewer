/* North Korea Explorer, serverless edition.
 *
 * The same five views as the Flask/React edition (Timeline, Sites, Wander, Search, About)
 * and the same URL scheme (?view=&m=&host=&q=&page=&find=&grp=&lang=&year=&p=&range=&w=),
 * so links between the two editions are interchangeable. Where the server answered from
 * Postgres this page reads static JSON baked by build_data.py; where it answered from
 * Meilisearch or by sampling `pages`, this page queries a SQLite catalog (build_catalog.py)
 * that is downloaded once from an archive.org item and run in the browser with SQLite WASM.
 * Screenshots come from zips on the same item, one file at a time.
 */

const params = new URLSearchParams(location.search);
const DATA = 'data';
const GROUPS = ['official', 'commerce', 'observer'];
const GROUP_NAME = { official: 'Official DPRK sites', commerce: 'Tourism & commerce', observer: 'Outside observers' };
const LANG = { ko: 'Korean', en: 'English', zh: 'Chinese', fr: 'French', es: 'Spanish', ar: 'Arabic', de: 'German', ru: 'Russian', pt: 'Portuguese', ja: 'Japanese' };
const VIEWS = [['scrubber', 'Timeline'], ['sites', 'Sites'], ['wander', 'Wander'], ['search', 'Search'], ['about', 'About']];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const SERVER_EDITION = 'https://wayback-labs.sf.archive.org/collection-explorer/';

const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = n => Number(n ?? 0).toLocaleString('en-US');
const monthName = (m, short = false) => { const n = MONTHS[+m.slice(5, 7) - 1]; return `${short ? n.slice(0, 3) : n} ${m.slice(0, 4)}`; };
const isMonth = m => !!m && /^\d{4}-(0[1-9]|1[0-2])$/.test(m);
const addMonths = (m, k) => { let y = +m.slice(0, 4), i = +m.slice(5, 7) - 1 + k; y += Math.floor(i / 12); i = ((i % 12) + 12) % 12; return `${y}-${String(i + 1).padStart(2, '0')}`; };
const monthDiff = (a, b) => (+a.slice(0, 4) - +b.slice(0, 4)) * 12 + (+a.slice(5, 7) - +b.slice(5, 7));
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const ymd = s => (s ? `${String(s).slice(0, 4)}-${String(s).slice(4, 6)}-${String(s).slice(6, 8)}` : '');
const langName = l => LANG[l] ?? l;
const sq = g => `<span class="grp-${esc(g)}">■</span>`;

/* ------------------------------------------------------------------ manifest + data ---- */

let manifest = { item: 'northkorea-explorer-data', catalog: 'catalog.sqlite.gz', counts: null };
const jsonCache = new Map();
async function getJSON(rel, { optional = false } = {}) {
  if (!jsonCache.has(rel)) {
    jsonCache.set(rel, (async () => {
      const r = await fetch(`${DATA}/${rel}`);
      if (r.status === 404 && optional) return null;
      if (!r.ok) throw new Error(`${rel}: HTTP ${r.status}`);
      return r.json();
    })().catch(e => { jsonCache.delete(rel); throw e; }));
  }
  return jsonCache.get(rel);
}

// `?shots=` and `?db=` point the page at local copies while developing (see serverless/README.md).
const shotsBase = () => (params.get('shots') || `https://archive.org/download/${manifest.item}`).replace(/\/$/, '');
/** API shot path (shots/northkorea/<host>/<month>.webp or shots/northkorea/pages/NN/<id>.webp) -> image URL. */
function shotUrl(rel) {
  if (!rel) return null;
  const m = rel.match(/^shots\/[^/]+\/(.+)$/);
  if (!m) return null;
  const inner = m[1];
  if (params.get('shots')) return `${shotsBase()}/${inner}`;
  const zip = inner.startsWith('pages/') ? `shots-pages-${inner.split('/')[1]}.zip` : `shots-${inner.split('/')[0]}.zip`;
  return `${shotsBase()}/${zip}/${inner}`;
}
const pageShot = (id, shot) => (shot ? `shots/northkorea/pages/${String(id % 100).padStart(2, '0')}/${id}.webp` : null);

/* ------------------------------------------------------------------ the catalog (SQLite) ---- */

const boot = {
  el: $('boot'), bar: $('bootbar'), note: $('bootnote'),
  show() { this.el.hidden = false; }, hide() { this.el.hidden = true; },
  say(msg, err) { this.note.textContent = msg; this.note.classList.toggle('err', !!err); },
  pct(p) { this.bar.style.width = `${clamp(p, 0, 100)}%`; },
};

let sqlite3 = null, db = null, dbPromise = null;

async function fetchCatalog(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`catalog: HTTP ${res.status} from ${url}`);
  // archive.org/cors/ sometimes serves the .gz with Content-Encoding: gzip (fetch inflates it,
  // Content-Length describes the compressed transfer) and sometimes as an opaque body.
  const encoded = !!res.headers.get('content-encoding');
  const clen = Number(res.headers.get('content-length')) || 0;
  const estimate = clen && encoded ? clen / 0.4 : clen;
  const chunks = []; let got = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value); got += value.length;
    if (estimate) boot.pct(Math.min(encoded ? 99 : 100, (100 * got) / estimate));
    boot.say(`Loading the page catalog — ${(got / 1e6).toFixed(1)} MB${clen && !encoded ? ` of ${(clen / 1e6).toFixed(1)} MB` : ''}. This happens once; it is cached for next time.`);
  }
  let bytes = new Uint8Array(got); let at = 0;
  for (const c of chunks) { bytes.set(c, at); at += c.length; }
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
    boot.say('Decompressing the catalog…');
    const buf = await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
    bytes = new Uint8Array(buf);
  }
  return bytes;
}

const idb = {
  open() {
    return new Promise((ok, no) => {
      const r = indexedDB.open('northkorea-explorer', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('files');
      r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error);
    });
  },
  async get(key) {
    try {
      const d = await this.open();
      return await new Promise(ok => { const r = d.transaction('files').objectStore('files').get(key); r.onsuccess = () => ok(r.result); r.onerror = () => ok(null); });
    } catch { return null; }
  },
  async put(key, val) {
    try {
      const d = await this.open();
      await new Promise(ok => { const r = d.transaction('files', 'readwrite').objectStore('files').put(val, key); r.onsuccess = () => ok(); r.onerror = () => ok(); });
    } catch { /* private mode, quota: caching is best-effort */ }
  },
};

/** Load the catalog on first use: cached bytes if the manifest's build matches, else the item. */
function catalog() {
  if (dbPromise) return dbPromise;
  dbPromise = (async () => {
    boot.show(); boot.pct(2); boot.say('Starting SQLite…');
    try {
      const mod = await import('./vendor/index.mjs');
      sqlite3 = await mod.default();
      const url = params.get('db') || `https://archive.org/cors/${manifest.item}/${manifest.catalog}`;
      const want = manifest.catalog_built || '';
      let bytes = null;
      const cached = await idb.get('catalog');
      if (cached?.bytes && (!want || cached.built === want) && cached.url === url) {
        boot.say('Reading the cached catalog…'); boot.pct(70);
        bytes = new Uint8Array(cached.bytes);
      } else {
        bytes = await fetchCatalog(url);
      }
      db = new sqlite3.oo1.DB();
      const p = sqlite3.wasm.allocFromTypedArray(bytes);
      const rc = sqlite3.capi.sqlite3_deserialize(db.pointer, 'main', p, bytes.length, bytes.length,
        sqlite3.capi.SQLITE_DESERIALIZE_FREEONCLOSE | sqlite3.capi.SQLITE_DESERIALIZE_RESIZEABLE);
      if (rc) throw new Error(`sqlite3_deserialize failed rc=${rc}`);
      const built = one(`SELECT value FROM meta WHERE key='built_at'`)?.value || '';
      if (!cached || cached.built !== built || cached.url !== url) idb.put('catalog', { built, url, bytes: bytes.buffer });
      boot.pct(100); boot.hide();
      return db;
    } catch (e) {
      boot.say(`The catalog could not be loaded (${e.message}). Reload to try again.`, true);
      dbPromise = null;
      throw e;
    }
  })();
  return dbPromise;
}
const rows = (sql, bind = []) => db.exec({ sql, bind, rowMode: 'object', returnValue: 'resultRows' });
const one = (sql, bind = []) => rows(sql, bind)[0] ?? null;

const PAGE_COLS = 'p.id, p.url, h.host, h.grp, p.title, p.lang, p.month AS pub_month, p.captures AS capture_count, p.shot, p.ts, p.first, p.last, p.alive, p.preview';
function pageOut(r) {
  return { id: r.id, url: r.url, host: r.host, grp: r.grp, title: r.title, lang: r.lang, pub_month: r.pub_month,
    capture_count: r.capture_count, shot: pageShot(r.id, r.shot), text_preview: r.preview ?? undefined,
    _ts: r.ts, _first: r.first, _last: r.last, _alive: r.alive };
}

/** Query words: quoted phrases stay whole, everything else splits on whitespace. */
function terms(q) {
  return (q.match(/"[^"]*"|\S+/g) ?? []).map(t => t.replace(/^"|"$/g, '').trim()).filter(Boolean);
}
/** WHERE fragment + binds for the search filters shared by search, random and wander. */
function filterSql(f) {
  const w = [], b = [];
  if (f.host) { w.push('h.host = ?'); b.push(f.host); }
  if (f.grp) { w.push('h.grp = ?'); b.push(f.grp); }
  if (f.lang) { w.push('p.lang = ?'); b.push(f.lang); }
  if (f.month) { w.push('p.month = ?'); b.push(f.month); }
  if (f.year) { w.push('p.month >= ? AND p.month <= ?'); b.push(`${f.year}-01`, `${f.year}-12`); }
  return { w, b };
}
/** The matching set for a query: every word a case-insensitive substring of the headline (LIKE scan;
 *  the catalog is in memory, so this is a fraction of a second and needs no index). */
function matchSql(q, f) {
  const words = terms(q);
  const { w, b } = filterSql(f);
  for (const x of words) { w.push("p.title LIKE ? ESCAPE '\\'"); b.push(`%${x.replace(/[%_\\]/g, c => '\\' + c)}%`); }
  return { from: 'pages p JOIN hosts h ON h.id = p.host_id', where: w.length ? `WHERE ${w.join(' AND ')}` : '', bind: b, words };
}
function highlight(text, words) {
  if (!text) return '';
  if (!words.length) return esc(text);
  const re = new RegExp(`(${words.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'gi');
  return text.split(re).map((part, i) => (i % 2 ? `<em>${esc(part)}</em>` : esc(part))).join('');
}

/* Local replacements for the server's /api/northkorea/* endpoints. Same shapes as web.py. */
const api = {
  timeline: () => getJSON('timeline.json'),
  month: m => getJSON(`month/${m}.json`, { optional: true }).then(d => d ?? { month: m, hosts: [], headlines: [], new_hosts: [], langs: {} }),
  hosts: () => getJSON('hosts.json'),
  host: h => getJSON(`host/${encodeURIComponent(h)}.json`),
  status: () => getJSON('status.json', { optional: true }),

  async search(f) {
    await catalog();
    const q = (f.q ?? '').trim().slice(0, 200);
    const page = clamp(f.page ?? 1, 1, 500), size = clamp(f.size ?? 24, 1, 100);
    const { from, where, bind, words } = matchSql(q, f);
    const fac = rows(`SELECT h.host, h.grp, p.lang, substr(p.month, 1, 4) yr, count(*) n FROM ${from} ${where} GROUP BY 1, 2, 3, 4`, bind);
    const facets = { host: {}, grp: {}, lang: {}, year: {} }; let total = 0;
    for (const r of fac) {
      total += r.n;
      facets.host[r.host] = (facets.host[r.host] ?? 0) + r.n;
      facets.grp[r.grp] = (facets.grp[r.grp] ?? 0) + r.n;
      if (r.lang) facets.lang[r.lang] = (facets.lang[r.lang] ?? 0) + r.n;
      if (r.yr) facets.year[r.yr] = (facets.year[r.yr] ?? 0) + r.n;
    }
    for (const k of ['host', 'lang']) facets[k] = Object.fromEntries(Object.entries(facets[k]).sort((a, b) => b[1] - a[1]));
    facets.year = Object.fromEntries(Object.entries(facets.year).sort());
    const hits = rows(`SELECT ${PAGE_COLS} FROM ${from} ${where} ORDER BY p.shot DESC, p.captures DESC, p.id LIMIT ? OFFSET ?`,
      [...bind, size, (page - 1) * size]).map(r => {
      const o = pageOut(r);
      o.title = highlight(r.title ?? '', words) || null;
      o.snippet = r.preview ? highlight(r.preview, words) : null;
      return o;
    });
    return { hits, total, page, size, facets };
  },

  /** A random page: jump to a random id and take the first eligible row at or after it, wrapping once. */
  async random(f) {
    await catalog();
    const q = (f.q ?? '').trim();
    if (q) {
      const { from, where, bind } = matchSql(q, f);
      const ids = rows(`SELECT p.id FROM ${from} ${where} ORDER BY p.captures DESC LIMIT 50`, bind);
      if (!ids.length) throw new Error('404');
      return this.pageRow(ids[Math.floor(Math.random() * ids.length)].id);
    }
    const { w, b } = filterSql(f);
    w.push('p.title IS NOT NULL');
    const r = randomRows(w.join(' AND '), b, 1)[0];
    if (!r) throw new Error('404');
    return pageOut(r);
  },

  pageRow(id) {
    const r = one(`SELECT ${PAGE_COLS} FROM pages p JOIN hosts h ON h.id = p.host_id WHERE p.id = ?`, [id]);
    return r ? pageOut(r) : null;
  },

  async page(id) {
    await catalog();
    const r = this.pageRow(id);
    if (!r) throw new Error('404');
    const seen = new Set([id]);
    let sameHost = randomRows('h.host = ? AND p.month IS ? AND p.id <> ? AND p.title IS NOT NULL', [r.host, r.pub_month, id], 6);
    if (sameHost.length < 6) {
      for (const x of sameHost) seen.add(x.id);
      sameHost = sameHost.concat(randomRows('h.host = ? AND p.id <> ? AND p.title IS NOT NULL', [r.host, id], 6).filter(x => !seen.has(x.id)).slice(0, 6 - sameHost.length));
    }
    const sameMonth = r.pub_month ? randomRows('p.month = ? AND h.host <> ? AND p.title IS NOT NULL', [r.pub_month, r.host], 6) : [];
    return {
      ...r, text: r.text_preview ?? null,
      captures: { count: r.capture_count, first: ymd(r._first), last: ymd(r._last), best_ts: r._ts },
      wayback_url: `https://web.archive.org/web/${r._ts}/${r.url}`,
      alive: r._alive === null || r._alive === undefined ? null : !!r._alive, alive_status: null,
      neighbors: { same_host: sameHost.map(pageOut), same_month: sameMonth.map(pageOut) },
    };
  },

  /** Shared finds without a server: the id is the trail itself, page ids joined by dots, the shared page last. */
  async find(fid) {
    await catalog();
    const ids = fid.split('.').filter(x => /^[1-9]\d{0,15}$/.test(x)).map(Number);
    if (!ids.length) throw new Error('404');
    const page = this.pageRow(ids[ids.length - 1]);
    if (!page) throw new Error('404');
    const trail = ids.slice(0, -1).map(i => this.pageRow(i)).filter(Boolean);
    return { id: fid, page, trail, created_at: null };
  },
  async createFind(pageId, trail) {
    return { id: [...trail.slice(-40), pageId].join('.') };
  },
};

function randomRows(where, bind, n) {
  const mx = one('SELECT max(id) m FROM pages')?.m;
  if (!mx) return [];
  const start = 1 + Math.floor(Math.random() * mx);
  let out = [];
  for (const [cond, a] of [[' AND p.id >= ?', [start]], [' AND p.id < ?', [start]]]) {
    out = out.concat(rows(`SELECT ${PAGE_COLS} FROM pages p JOIN hosts h ON h.id = p.host_id WHERE ${where}${cond} ORDER BY p.id LIMIT ?`,
      [...bind, ...a, n - out.length]));
    if (out.length >= n) break;
  }
  return out;
}

/* ------------------------------------------------------------------ URL state ---- */

function readState(search = location.search) {
  const s = new URLSearchParams(search);
  const int = (k, max = Number.MAX_SAFE_INTEGER) => { const v = s.get(k); if (!v || !/^[1-9]\d*$/.test(v)) return undefined; const n = Number(v); return Number.isSafeInteger(n) && n <= max ? n : undefined; };
  const view = s.get('view'), range = s.get('range');
  return {
    view: VIEWS.some(v => v[0] === view) ? view : 'scrubber',
    m: s.get('m') || undefined, host: s.get('host') || undefined, q: s.get('q') || undefined,
    page: int('page'), find: s.get('find') || undefined, grp: s.get('grp') || undefined,
    lang: s.get('lang') || undefined, year: s.get('year') || undefined, p: int('p', 500),
    range: range === 'all' || range === 'crawl' ? range : undefined, w: int('w'),
  };
}
function writeState(st) {
  const s = new URLSearchParams();
  if (st.view !== 'scrubber') s.set('view', st.view);
  for (const k of ['m', 'host', 'q', 'find', 'grp', 'lang', 'year', 'range']) if (st[k]) s.set(k, String(st[k]));
  if (st.page) s.set('page', String(st.page));
  if (st.w) s.set('w', String(st.w));
  if (st.p && st.p > 1) s.set('p', String(st.p));
  for (const k of ['db', 'shots']) if (params.get(k)) s.set(k, params.get(k));
  const qs = s.toString();
  return qs ? `?${qs}` : location.pathname;
}
let st = readState();
function update(patch, replace = false) {
  const next = { ...readState(), ...patch };
  const url = new URL(writeState(next), location.href);
  if (url.href !== location.href) history[replace ? 'replaceState' : 'pushState'](null, '', url.href);
  st = next;
  render();
}
window.addEventListener('popstate', () => { st = readState(); render(); });

/* ------------------------------------------------------------------ rendering ---- */

const main = $('main');
let renderToken = 0;                      // bumps on every render so stale async work can bail

function render() {
  const token = ++renderToken;
  $('q').value = st.q ?? '';
  $('tabs').innerHTML = VIEWS.map(([id, label]) =>
    `<button data-tab="${id}" ${st.view === id ? 'aria-current="page"' : ''}>${label}</button>`).join('');
  const views = { scrubber: renderScrubber, sites: renderSites, wander: renderWander, search: renderSearch, about: renderAbout };
  if (st.view !== lastView || st.view === 'about') { main.innerHTML = ''; lastView = st.view; }
  views[st.view](token);
  renderModal(token);
}
let lastView = null;
const alive = token => token === renderToken;

$('tabs').addEventListener('click', e => {
  const b = e.target.closest('button[data-tab]');
  if (!b) return;
  const id = b.dataset.tab;
  update({ view: id, page: undefined, ...(id !== 'sites' ? { host: st.view === 'search' ? st.host : undefined } : {}) });
});
$('topsearch').addEventListener('submit', e => { e.preventDefault(); const q = $('q').value.trim(); if (q) goSearch(q); });
document.querySelector('footer').addEventListener('click', e => { const a = e.target.closest('a[data-view]'); if (a) { e.preventDefault(); update({ view: a.dataset.view }); } });
function goSearch(q, m, host) { update({ view: 'search', q, m, host, p: undefined }); }
const openPage = id => update({ page: id });
const goHost = host => update({ view: 'sites', host });

const cardHtml = (p, big = false) => `
  <button class="card ${big ? 'big' : ''}" data-open="${p.id}" title="${esc(p.url)}">
    ${p.shot ? `<img class="shot" src="${esc(shotUrl(p.shot))}" alt="" loading="lazy">` : `<div class="shot placeholder">${esc(p.host)}</div>`}
    <div class="title" ${p.lang ? `lang="${esc(p.lang)}"` : ''}>${esc(p.title ?? p.text_preview?.slice(0, 80) ?? p.url)}</div>
    <div class="meta">${sq(p.grp)} ${esc(p.host)}${p.pub_month ? ` · ${monthName(p.pub_month, true)}` : ''}${p.lang ? ` · ${esc(langName(p.lang))}` : ''}</div>
  </button>`;
const legendHtml = () => `<div class="legend">${GROUPS.map(g => `<span>${sq(g)} ${GROUP_NAME[g]}</span>`).join('')}</div>`;
const emptyHtml = t => `<div class="empty">${t}</div>`;

// one delegated click handler for the recurring data-* actions inside <main> and the modal
function delegate(root) {
  root.addEventListener('click', e => {
    const t = e.target.closest('[data-open],[data-host],[data-search],[data-view]');
    if (!t || t.tagName === 'A' && !t.dataset.view && !t.dataset.host && !t.dataset.search) return;
    if (t.dataset.open) { e.preventDefault(); openPage(Number(t.dataset.open)); }
    else if (t.dataset.host) { e.preventDefault(); goHost(t.dataset.host); }
    else if (t.dataset.search !== undefined) { e.preventDefault(); goSearch(t.dataset.search, t.dataset.month || undefined, t.dataset.shost || undefined); }
    else if (t.dataset.view) { e.preventDefault(); update({ view: t.dataset.view }); }
  });
}
delegate(main);
delegate($('modal'));
// a screenshot that fails to load (item not yet uploaded, zip member missing) becomes the plain placeholder
document.addEventListener('error', e => {
  const img = e.target;
  if (!(img instanceof HTMLImageElement) || !img.classList.contains('shot')) return;
  const ph = document.createElement('div'); ph.className = 'shot placeholder'; ph.textContent = img.alt || '';
  img.replaceWith(ph);
}, true);

/* ------------------------------------------------------------------ Timeline (scrubber) ---- */

const scrub = { tl: null, error: null, playing: null, month: null, width: 960 };
const H = 150, PAD = { l: 28, r: 28, t: 34, b: 22 };

async function renderScrubber(token) {
  if (!main.querySelector('#scrub')) {
    main.innerHTML = `<section id="scrub">
      <div class="row scrub-head">
        <div><div class="month" aria-live="polite" id="sc-month"></div><div class="sub" id="sc-sub"></div></div>
        <div class="controls">
          <button class="btn" id="sc-prev" aria-label="Previous month">←</button>
          <button class="btn" id="sc-play" aria-pressed="false">Play</button>
          <button class="btn" id="sc-next" aria-label="Next month">→</button>
          <label class="small muted" style="margin-left:.8rem"><input type="checkbox" id="sc-all"> show captures outside the crawl</label>
        </div>
      </div>
      <p class="alert" id="sc-err" role="alert" hidden></p>
      <div class="slider" id="sc-slider" role="slider" aria-label="Month" tabindex="0"></div>
      <div class="under">${legendHtml()}<span class="small muted">Drag the handle, use ← → or press space to play</span></div>
      <div id="sc-month-panel"></div>
      <details class="small" style="margin-top:3.2rem"><summary class="muted">Monthly capture counts as a table</summary><div class="wide" id="sc-table"></div></details>
    </section>`;
    wireScrubber();
  }
  if (!scrub.tl && !scrub.error) {
    try { scrub.tl = await api.timeline(); } catch (e) { scrub.error = String(e); }
    if (!alive(token)) return;
  }
  const err = $('sc-err');
  if (scrub.error) { err.hidden = false; err.textContent = `Could not load the timeline (${scrub.error}). Reload to try again.`; return; }
  drawScrubber(token);
}

function scrubModel() {
  const tl = scrub.tl;
  const win = tl.window ?? null;
  const m = isMonth(st.m) ? st.m : undefined;
  const showAll = st.range === 'all' || (!st.range && !!m && !!win && (m < win[0] || m > win[1]));
  let lo = '2016-01', hi = '2024-11';
  if (tl.range) [lo, hi] = showAll || !win ? tl.range : [clamp(win[0], tl.range[0], tl.range[1]), clamp(win[1], tl.range[0], tl.range[1])];
  const months = (tl.months ?? []).filter(x => x.month >= lo && x.month <= hi);
  const cur = m ? clamp(m, lo, hi) : tl.default_month ? clamp(tl.default_month, lo, hi) : hi;
  return { lo, hi, months, cur, showAll, beats: (tl.beats ?? []).filter(b => b.date.slice(0, 7) >= lo && b.date.slice(0, 7) <= hi) };
}

function wireScrubber() {
  const slider = $('sc-slider');
  const step = k => { const { lo, hi, cur } = scrubModel(); update({ m: clamp(addMonths(cur, k), lo, hi) }); };
  $('sc-prev').onclick = () => step(-1);
  $('sc-next').onclick = () => step(1);
  $('sc-play').onclick = () => togglePlay();
  $('sc-all').onchange = e => update({ range: e.target.checked ? 'all' : 'crawl' }, true);
  new ResizeObserver(en => { const w = Math.round(en[0].contentRect.width); if (w && w !== scrub.width) { scrub.width = w; if (scrub.tl && st.view === 'scrubber') drawChart(); } }).observe(slider);
  let drag = null;
  const at = x => {
    const { months } = scrubModel();
    const r = slider.getBoundingClientRect();
    if (!months.length) return;
    const n = months.length, i = Math.max(0, Math.min(n - 1, Math.round(((x - r.left) - PAD.l) / Math.max(1, (scrub.width - PAD.l - PAD.r)) * Math.max(n - 1, 1))));
    const mo = months[i].month;
    if (mo !== scrubModel().cur) { update({ m: mo }, drag.changed); drag.changed = true; }
  };
  slider.addEventListener('pointerdown', e => { if (!e.isPrimary || e.button !== 0) return; drag = { id: e.pointerId, changed: false }; slider.focus(); slider.setPointerCapture(e.pointerId); at(e.clientX); });
  slider.addEventListener('pointermove', e => { if (drag?.id === e.pointerId) at(e.clientX); });
  for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) slider.addEventListener(ev, () => { drag = null; });
  slider.addEventListener('keydown', e => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    if (e.key === ' ') { e.preventDefault(); if (!e.repeat) togglePlay(); return; }
    const { lo, hi, cur } = scrubModel();
    const to = e.key === 'Home' ? lo : e.key === 'End' ? hi : ['ArrowLeft', 'ArrowDown'].includes(e.key) ? addMonths(cur, -1) : ['ArrowRight', 'ArrowUp'].includes(e.key) ? addMonths(cur, 1) : undefined;
    if (to !== undefined) { e.preventDefault(); update({ m: clamp(to, lo, hi) }); }
  });
}
function togglePlay() {
  if (scrub.playing) { clearInterval(scrub.playing); scrub.playing = null; }
  else scrub.playing = setInterval(() => {
    if (st.view !== 'scrubber' || !scrub.tl) return togglePlay();
    const { hi, cur } = scrubModel();
    if (cur >= hi) togglePlay(); else update({ m: addMonths(cur, 1) }, true);
  }, 2500);
  const b = $('sc-play'); if (b) { b.textContent = scrub.playing ? 'Pause' : 'Play'; b.setAttribute('aria-pressed', String(!!scrub.playing)); }
}

let chartKey = '';
function drawScrubber(token) {
  const { lo, hi, months, cur, showAll, beats } = scrubModel();
  if (st.m !== cur) { update({ m: cur }, true); return; }
  $('sc-month').textContent = monthName(cur);
  $('sc-all').checked = showAll;
  const N = months.find(x => x.month === cur);
  const published = N ? GROUPS.reduce((s, g) => s + (N.groups[g] ?? 0), 0) : 0;
  $('sc-sub').innerHTML = (N ? `${num(N.captures)} captures this month${published > 0 ? ` · ${num(published)} pages published` : ''}` : 'No captures this month')
    + beats.filter(b => b.date.slice(0, 7) === cur).map(b => ` · <b style="color:var(--ia-ink)">${esc(b.label)}</b>${b.query ? ` (<a href="#" data-search="${esc(b.query)}" data-month="${cur}">search “${esc(b.query)}”</a>)` : ''}`).join('');
  const key = `${lo}|${hi}|${scrub.width}`;
  if (key !== chartKey) { chartKey = key; drawChart(); }
  else moveHandle();
  $('sc-table').innerHTML = `<table class="counts tabular" style="margin-top:.8rem"><caption class="sr-only">Captures per month by group</caption>
    <thead><tr><th scope="col">Month</th>${GROUPS.map(g => `<th scope="col">${GROUP_NAME[g]}</th>`).join('')}</tr></thead>
    <tbody>${months.map(x => `<tr><th scope="row">${monthName(x.month, true)}</th>${GROUPS.map(g => `<td>${num(x.captures_by_group[g] ?? 0)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
  renderMonthPanel(cur, token);
}

function xScale(n) { const a = PAD.l, b = scrub.width - PAD.r; return i => (n <= 1 ? a : a + (b - a) * (i / (n - 1))); }
function monotone(pts) {
  const n = pts.length; if (!n) return '';
  let d = `M${pts[0][0]},${pts[0][1]}`;
  if (n === 1) return d;
  if (n === 2) return d + `L${pts[1][0]},${pts[1][1]}`;
  const dx = [], s = [], m = new Array(n);
  for (let i = 0; i < n - 1; i++) { dx[i] = pts[i + 1][0] - pts[i][0] || 1e-9; s[i] = (pts[i + 1][1] - pts[i][1]) / dx[i]; }
  m[0] = s[0]; m[n - 1] = s[n - 2];
  for (let i = 1; i < n - 1; i++) m[i] = s[i - 1] * s[i] <= 0 ? 0 : (() => { const w1 = 2 * dx[i] + dx[i - 1], w2 = dx[i] + 2 * dx[i - 1]; return (w1 + w2) / (w1 / s[i - 1] + w2 / s[i]); })();
  for (let i = 0; i < n - 1; i++) { const h = dx[i] / 3; d += `C${pts[i][0] + h},${pts[i][1] + h * m[i]},${pts[i + 1][0] - h},${pts[i + 1][1] - h * m[i + 1]},${pts[i + 1][0]},${pts[i + 1][1]}`; }
  return d;
}
function drawChart() {
  const slider = $('sc-slider'); if (!slider) return;
  const { lo, months, beats } = scrubModel();
  const n = months.length, x = xScale(n), W = scrub.width;
  // stack captures by group, official at the bottom
  const tops = months.map(() => 0), series = [];
  for (const g of GROUPS) {
    const pts = months.map((mo, i) => { const v = mo.captures_by_group?.[g] ?? 0; const y0 = tops[i]; tops[i] += v; return [y0, tops[i]]; });
    series.push({ g, pts });
  }
  const max = Math.max(1, ...tops);
  const y = v => (H - PAD.b) - (v / max) * (H - PAD.b - PAD.t);
  const paths = series.map((sr, k) => {
    const top = monotone(sr.pts.map((p, i) => [x(i), y(p[1])]));
    const bottom = monotone(sr.pts.map((p, i) => [x(i), y(p[0])]).reverse()).replace(/^M/, 'L');
    return `<path d="${n ? top + bottom + 'Z' : ''}" fill="var(--grp-${sr.g})" stroke="var(--ia-page)" stroke-width="${k ? 2 : 0}" opacity=".92"/>`;
  }).join('');
  const marks = beats.map(b => { const i = n ? monthDiff(b.date.slice(0, 7), months[0].month) : -1; return i < 0 || i >= n ? '' :
    `<g transform="translate(${x(i)},0)"><line y1="${PAD.t - 10}" y2="${H - PAD.b}" stroke="var(--ia-ink-muted)" stroke-dasharray="2 3"/><circle cy="${PAD.t - 12}" r="3.5" fill="var(--ia-ink)"><title>${esc(b.label)}</title></circle></g>`; }).join('');
  const years = months.filter(mo => mo.month.endsWith('-01')).map(mo => { const i = monthDiff(mo.month, months[0].month); return `<text x="${x(i)}" y="${H - 6}" font-size="11" fill="var(--ia-ink-muted)" text-anchor="${i === 0 ? 'start' : 'middle'}">${mo.month.slice(0, 4)}</text>`; }).join('');
  slider.innerHTML = `<svg width="${W}" height="${H}">${paths}${marks}<g id="sc-handle"><line y1="${PAD.t - 16}" y2="${H - PAD.b}" stroke="var(--ia-ink)" stroke-width="2"/><rect x="-7" y="${PAD.t - 24}" width="14" height="14" rx="2" fill="var(--ia-ink)"/></g>${years}</svg>`;
  slider.setAttribute('aria-valuemin', 0); slider.setAttribute('aria-valuemax', Math.max(0, n - 1)); slider.setAttribute('aria-disabled', String(!n)); slider.tabIndex = n ? 0 : -1;
  void lo; moveHandle();
}
function moveHandle() {
  const { months, cur } = scrubModel(); const h = $('sc-handle'); if (!h) return;
  const n = months.length, i = n ? Math.max(0, monthDiff(cur, months[0].month)) : 0;
  h.setAttribute('transform', `translate(${xScale(n)(Math.min(i, Math.max(0, n - 1)))},0)`);
  h.style.display = n ? '' : 'none';
  const sl = $('sc-slider'); sl.setAttribute('aria-valuenow', Math.min(i, Math.max(0, n - 1))); sl.setAttribute('aria-valuetext', monthName(cur));
}

async function renderMonthPanel(month, token) {
  const box = $('sc-month-panel'); if (!box) return;
  if (box.dataset.month !== month) box.innerHTML = `<div class="cols"><div><h2 class="h2">Home pages this month</h2>${emptyHtml('Loading…')}</div><div><h2 class="h2">Headlines</h2></div></div>`;
  box.dataset.month = month;
  let d;
  try { d = await api.month(month); } catch (e) { if (alive(token)) box.innerHTML = `<p class="alert" role="alert">Could not load ${esc(month)} (${esc(String(e))}).</p>`; return; }
  if (!alive(token) || box.dataset.month !== month) return;
  const shots = d.hosts.filter(h => h.shot);
  const homes = shots.length === 0 ? emptyHtml(d.hosts.length ? `${d.hosts.length} sites were captured this month; their home page screenshots are still being made.` : 'No sites were captured this month.')
    : `<div class="grid">${shots.map(h => `<button class="card" data-host="${esc(h.host)}" ${h.shot_ts ? `title="captured ${ymd(h.shot_ts.slice(0, 8))}"` : ''}>
        <img class="shot" src="${esc(shotUrl(h.shot))}" alt="${esc(h.host)} home page" loading="lazy"><div class="title">${sq(h.grp)} ${esc(h.display_name && h.display_name !== h.host ? h.display_name : h.host)}</div></button>`).join('')}</div>`;
  const heads = d.headlines.length === 0 ? emptyHtml('Page text for this month has not been extracted yet.')
    : `<ul class="headlines">${d.headlines.map(p => `<li><button data-open="${p.id}" ${p.lang ? `lang="${esc(p.lang)}"` : ''}>${esc(p.title)}</button><div class="small muted">${sq(p.grp)} ${esc(p.host)}</div></li>`).join('')}</ul>`;
  const extra = (d.new_hosts.length || Object.keys(d.langs).length) ? `<div class="muted" style="margin-top:2.4rem;font-size:1.3rem">
      ${d.new_hosts.length ? `<p>First seen this month: ${d.new_hosts.map(h => `<a href="#" data-host="${esc(h)}">${esc(h)}</a>`).join(', ')}</p>` : ''}
      ${Object.keys(d.langs).length ? `<p style="margin-top:.8rem">Languages: ${Object.entries(d.langs).slice(0, 5).map(([l, n]) => `${esc(langName(l))} ${num(n)}`).join(', ')}</p>` : ''}</div>` : '';
  const withShots = d.headlines.filter(p => p.shot).slice(0, 15);
  box.innerHTML = `<div class="cols"><div><h2 class="h2">Home pages this month</h2>${homes}</div><div><h2 class="h2">Headlines</h2>${heads}${extra}</div></div>
    ${withShots.length ? `<section style="margin-top:4rem"><h2 class="h2">Pages from ${monthName(month)}</h2><div class="grid five">${withShots.map(p => cardHtml(p)).join('')}</div></section>` : ''}`;
}

/* ------------------------------------------------------------------ Sites ---- */

const sites = { rows: null, error: null };
async function renderSites(token) {
  if (st.host) return renderHost(st.host, token);
  if (!sites.rows && !sites.error) {
    main.innerHTML = emptyHtml('Loading sites…');
    try { sites.rows = await api.hosts(); } catch (e) { sites.error = String(e); }
    if (!alive(token)) return;
  }
  if (sites.error) { main.innerHTML = `<p class="alert" role="alert">Could not load the sites (${esc(sites.error)}).</p>`; return; }
  const rows = sites.rows;
  const label = h => `${h.display_name || h.host}, ${h.host}, ${num(h.page_count)} pages${h.alive === false ? ', gone from the live web' : ''}`;
  const chips = `<ul class="chips" style="margin-top:.8rem">${rows.map(h => `<li><button class="chip" data-host="${esc(h.host)}" aria-label="${esc(label(h))}">${sq(h.grp)} ${esc(h.display_name || h.host)}</button></li>`).join('')}</ul>`;
  if (!rows.some(h => h.page_count > 0)) {
    main.innerHTML = `<section><h1 class="h1">${rows.length} sites</h1><p class="muted" style="margin-top:.8rem;max-width:70ch">The map of sites, sized by how many pages were preserved, fills in as the harvest runs. Sites found so far:</p>${chips}</section>`;
    return;
  }
  main.innerHTML = `<section>
    <div class="row" style="margin-bottom:1.2rem"><div><h1 class="h1">${rows.length} sites, sized by pages preserved</h1><p class="muted small" style="margin-top:.4rem">Click a site to see how it changed year by year and whether it is still online.</p></div>${legendHtml()}</div>
    <div id="treemap"></div>
    <p class="small muted" style="margin-top:.8rem">A red dot marks a site that no longer answers on the live web.</p>
    <details class="small" style="margin-top:1.2rem"><summary class="muted">All sites as a list (${rows.length})</summary>${chips}</details></section>`;
  const box = $('treemap');
  const draw = () => {
    const w = Math.round(box.getBoundingClientRect().width) || 960, h = Math.max(420, Math.round(w * 0.55));
    box.style.height = `${h}px`;
    const leaves = treemap(rows.filter(r => r.page_count > 0).map(r => ({ v: r.page_count, d: r })), w, h, 3);
    box.innerHTML = leaves.map(({ x0, y0, x1, y1, d }) => {
      const cw = x1 - x0, ch = y1 - y0, img = shotUrl(d.shot);
      return `<button data-host="${esc(d.host)}" style="left:${x0}px;top:${y0}px;width:${cw}px;height:${ch}px;background:var(--grp-${esc(d.grp)})" title="${esc(d.host)}: ${num(d.page_count)} pages" aria-label="${esc(label(d))}">
        ${img && cw > 70 && ch > 50 ? `<img src="${esc(img)}" alt="" loading="lazy">` : ''}
        ${cw > 60 && ch > 28 ? `<span class="label">${esc(cw > 120 && d.display_name !== d.host ? d.display_name : d.host)}${cw > 180 ? ` · ${num(d.page_count)}` : ''}</span>` : ''}
        ${d.alive === false && cw > 40 ? `<span class="dead" title="gone from the live web"></span>` : ''}</button>`;
    }).join('');
  };
  draw();
  let lastW = box.getBoundingClientRect().width;
  new ResizeObserver(en => { const w = en[0].contentRect.width; if (Math.abs(w - lastW) > 2 && box.isConnected) { lastW = w; draw(); } }).observe(box);
}

/** Squarified treemap (Bruls, Huizing & van Wijk): items {v, d} sorted by value, rects in [0,w]×[0,h]. */
function treemap(items, w, h, pad = 0) {
  items = items.slice().sort((a, b) => b.v - a.v);
  const total = items.reduce((s, it) => s + it.v, 0) || 1;
  const scale = (w * h) / total;
  const out = []; let x = 0, y = 0, W = w, Hh = h, i = 0;
  while (i < items.length) {
    const short = Math.max(1, Math.min(W, Hh));
    const row = []; let sum = 0, worst = Infinity;
    for (let j = i; j < items.length; j++) {
      const a = items[j].v * scale, s2 = sum + a, len = s2 / short;
      let mx = 0, mn = Infinity;
      for (const r of [...row, items[j]]) { const side = (r.v * scale) / len; mx = Math.max(mx, side); mn = Math.min(mn, side); }
      const asp = Math.max(len / mn, mx / len);
      if (row.length && asp > worst) break;
      worst = asp; row.push(items[j]); sum = s2;
    }
    const len = sum / short;
    if (W >= Hh) { let yy = y; for (const r of row) { const hh = (r.v * scale) / len; out.push({ x0: x, y0: yy, x1: x + len, y1: yy + hh, d: r.d }); yy += hh; } x += len; W -= len; }
    else { let xx = x; for (const r of row) { const ww = (r.v * scale) / len; out.push({ x0: xx, y0: y, x1: xx + ww, y1: y + len, d: r.d }); xx += ww; } y += len; Hh -= len; }
    i += row.length;
  }
  return out.map(r => ({ ...r, x0: Math.round(r.x0 + pad / 2), y0: Math.round(r.y0 + pad / 2), x1: Math.round(r.x1 - pad / 2), y1: Math.round(r.y1 - pad / 2) })).filter(r => r.x1 > r.x0 && r.y1 > r.y0);
}

async function renderHost(host, token) {
  main.innerHTML = `<section><button class="btn" data-host="" id="back">← All sites</button>${emptyHtml(`Loading ${esc(host)}…`)}</section>`;
  main.querySelector('#back').onclick = () => update({ host: undefined });
  let a;
  try { a = await api.host(host); } catch (e) { if (alive(token)) main.innerHTML = `<p class="alert" role="alert">Could not load ${esc(host)} (${esc(String(e))}).</p>`; return; }
  if (!alive(token)) return;
  const max = Math.max(1, ...a.months.map(m => m.captures));
  const shots = a.months.filter(m => m.shot);
  const named = a.display_name && a.display_name !== a.host;
  main.innerHTML = `<section>
    <button class="btn" id="back" style="margin-bottom:1.6rem">← All sites</button>
    <div class="row" style="justify-content:flex-start;align-items:baseline;gap:1.6rem"><h1 class="h1 big">${esc(named ? a.display_name : a.host)}</h1>${named ? `<span class="muted" style="font-size:1.6rem">${esc(a.host)}</span>` : ''}<span class="grp-${esc(a.grp)}">■ ${GROUP_NAME[a.grp] ?? esc(a.grp)}</span></div>
    <p class="muted" style="margin-top:.8rem">${num(a.page_count)} pages preserved${a.first_captured && a.last_captured ? `, ${a.first_captured.slice(0, 4)} to ${a.last_captured.slice(0, 4)}` : ''}.
      ${a.alive === true ? '<span class="green">Still online today.</span>' : ''}${a.alive === false ? `<span class="red">Gone from the live web${a.alive_status ? ` (HTTP ${a.alive_status})` : ''}.</span>` : ''}
      ${Object.keys(a.langs).length ? ` Mostly ${Object.keys(a.langs).slice(0, 3).map(langName).map(esc).join(', ')}.` : ''}</p>
    <form class="hostsearch" id="hostsearch"><input type="search" placeholder="Search ${esc(host)}" aria-label="Search ${esc(host)}"><button class="btn" type="submit">Search</button></form>
    <h2 class="h2" style="margin-top:3.2rem;margin-bottom:.8rem">Captures per month</h2>
    <div class="bars" aria-hidden="true">${a.months.map(m => `<div title="${monthName(m.month)}: ${num(m.captures)} captures" style="height:${Math.max(2, (m.captures / max) * 100)}%;background:var(--grp-${esc(a.grp)})"></div>`).join('')}</div>
    <div class="muted" style="display:flex;justify-content:space-between;font-size:1.1rem;margin-top:.4rem"><span>${esc(a.months[0]?.month ?? '')}</span><span>${esc(a.months[a.months.length - 1]?.month ?? '')}</span></div>
    <details class="small" style="margin-top:.8rem"><summary class="muted">Monthly capture counts as a table</summary><table class="counts tabular" style="margin-top:.8rem"><caption class="sr-only">Captures for ${esc(a.host)}</caption><thead><tr><th scope="col">Month</th><th scope="col">Captures</th></tr></thead><tbody>${a.months.map(m => `<tr><th scope="row">${monthName(m.month, true)}</th><td>${num(m.captures)}</td></tr>`).join('')}</tbody></table></details>
    ${shots.length ? `<h2 class="h2" style="margin-top:3.2rem;margin-bottom:.8rem">The home page over time</h2><div class="strip">${shots.map(m => `<figure><img class="shot" src="${esc(shotUrl(m.shot))}" alt="${esc(host)} in ${monthName(m.month)}" loading="lazy"><figcaption>${monthName(m.month, true)}</figcaption></figure>`).join('')}</div>` : ''}
    ${a.top_pages.length ? `<h2 class="h2" style="margin-top:3.2rem">Most-captured pages</h2><div class="grid five">${a.top_pages.slice(0, 15).map(p => cardHtml(p)).join('')}</div>` : ''}
  </section>`;
  main.querySelector('#back').onclick = () => update({ host: undefined });
  main.querySelector('#hostsearch').onsubmit = e => { e.preventDefault(); const q = e.target.querySelector('input').value.trim(); if (q) goSearch(q, undefined, host); };
}

/* ------------------------------------------------------------------ Wander ---- */

const wander = { card: null, history: [], busy: false, share: null, error: null, seq: 0, loadedFor: null };
async function renderWander(token) {
  const w = wander;
  const box = main.querySelector('#wander') ? main : (main.innerHTML = '<section class="wander" id="wander"></section>', main);
  void box;
  const key = `${st.find ?? ''}|${st.w ?? ''}`;
  if (w.loadedFor !== key) {
    w.loadedFor = key;
    if (st.find) await wanderRun(() => api.find(st.find), r => { if (r.page) { w.card = r.page; w.history = r.trail ?? []; update({ w: r.page.id, find: st.find }, true); } }, () => 'That shared find no longer exists.', token);
    else if (st.w && st.w !== w.card?.id) await wanderRun(() => api.page(st.w), r => { w.card = r; }, () => 'That page could not be loaded.', token);
    else if (!w.card && !st.w) await wanderNext({}, token);
  }
  if (!alive(token)) return;
  drawWander();
}
async function wanderRun(fn, onOk, onErr, token) {
  const w = wander, seq = ++w.seq;
  w.busy = true; w.error = null; w.share = null; drawWander();
  try { const r = await fn(); if (seq === w.seq) onOk(r); }
  catch (e) { if (seq === w.seq) w.error = onErr(e); }
  finally { if (seq === w.seq) w.busy = false; }
  void token;
}
async function wanderNext(f, token) {
  const w = wander;
  await wanderRun(() => api.random(f), r => {
    if (w.card) w.history = [...w.history, w.card].slice(-199);
    w.card = r; update({ w: r.id, find: undefined }, true);
  }, () => (w.card ? 'Nothing found along that path. Try another direction.' : 'No pages are in the catalog yet.'), token);
  drawWander();
}
function drawWander() {
  const w = wander, a = w.card;
  const box = main.querySelector('#wander'); if (!box || st.view !== 'wander') return;
  const words = (a?.title ?? '').split(/\s+/).filter(x => x.length > 1).slice(0, 2).join(' ');
  box.innerHTML = `
    <div class="row"><div><h1 class="h1">Wander</h1><p class="muted small" style="margin-top:.4rem">One preserved page at a time. Pick a direction, or let chance choose.</p></div>
      <div class="chips" style="gap:.8rem">
        <button class="btn" id="wd-host" ${w.busy || !a ? 'disabled' : ''}>Same site</button>
        <button class="btn" id="wd-month" ${w.busy || !a?.pub_month ? 'disabled' : ''}>Same month</button>
        <button class="btn" id="wd-words" ${w.busy || !words ? 'disabled' : ''}>Same words</button>
        <button class="btn btn-primary" id="wd-any" ${w.busy ? 'disabled' : ''}>Surprise me</button></div></div>
    ${w.error ? `<p class="alert" role="alert">${esc(w.error)}</p>` : ''}
    ${a ? `<article>
      ${a.shot ? `<img class="shot" src="${esc(shotUrl(a.shot))}" alt="">` : '<div class="shot"></div>'}
      <div>
        <div class="small muted">${sq(a.grp)} ${GROUP_NAME[a.grp] ?? esc(a.grp)} · ${esc(a.host)}${a.pub_month ? ` · ${monthName(a.pub_month)}` : ''}${a.lang ? ` · ${esc(langName(a.lang))}` : ''}</div>
        <h2 class="title" ${a.lang ? `lang="${esc(a.lang)}"` : ''}>${esc(a.title ?? a.url)}</h2>
        ${a.text_preview ? `<p class="preview" ${a.lang ? `lang="${esc(a.lang)}"` : ''}>${esc(a.text_preview)}…</p>` : ''}
        <div class="chips" style="margin-top:1.6rem;gap:1.2rem"><button class="btn" data-open="${a.id}">Read the page</button><button class="btn" id="wd-share" ${w.busy ? 'disabled' : ''}>Share this find</button></div>
        ${w.share ? `<p class="share"><a href="${esc(w.share)}">${esc(w.share)}</a></p>` : ''}
      </div></article>` : w.busy ? emptyHtml('Finding something…') : ''}
    ${w.history.length ? `<section style="margin-top:4rem"><h3 class="h2" style="margin-bottom:.8rem">Where you have been</h3><ol class="chips">${w.history.map(g => `<li><button class="chip" data-open="${g.id}" title="${esc(g.title ?? g.url)}">${esc((g.title ?? g.url).slice(0, 40))}</button></li>`).join('')}</ol></section>` : ''}`;
  const go = f => wanderNext(f, renderToken);
  box.querySelector('#wd-host').onclick = () => go({ host: a.host });
  box.querySelector('#wd-month').onclick = () => go({ month: a.pub_month });
  box.querySelector('#wd-words').onclick = () => go({ q: words });
  box.querySelector('#wd-any').onclick = () => go({});
  const share = box.querySelector('#wd-share');
  if (share) share.onclick = async () => {
    if (!a || w.busy) return;
    const r = await api.createFind(a.id, w.history.map(x => x.id).slice(-199));
    update({ w: a.id, find: r.id }, true);
    w.share = `${location.origin}${location.pathname}?view=wander&find=${r.id}`;
    drawWander();
  };
}

/* ------------------------------------------------------------------ Search ---- */

const search = { key: null, data: null, error: null, busy: false };
async function renderSearch(token) {
  const q = st.q ?? '';
  const f = { q, page: st.p ?? 1, size: 24, host: st.host, grp: st.grp, lang: st.lang, year: st.year, month: st.m };
  const key = JSON.stringify(f);
  if (!main.querySelector('#search')) main.innerHTML = '<section id="search"></section>';
  if (!q) { search.key = key; search.data = null; drawSearch(); return; }
  if (search.key !== key) {
    search.key = key; search.busy = true; search.error = null; drawSearch();
    try { const d = await api.search(f); if (search.key === key) search.data = d; }
    catch (e) { if (search.key === key) search.error = String(e.message ?? e); }
    finally { if (search.key === key) search.busy = false; }
    if (!alive(token) || search.key !== key) return;
    const d = search.data;
    if (d && d.total > 0 && (st.p ?? 1) > Math.ceil(d.total / d.size)) { update({ p: Math.ceil(d.total / d.size) }); return; }
  }
  drawSearch();
}
function drawSearch() {
  const box = main.querySelector('#search'); if (!box || st.view !== 'search') return;
  const q = st.q ?? '', y = search.data;
  const chip = (k, v, label, n) => `<button class="chip" data-f="${k}" data-v="${esc(v)}" aria-pressed="${st[k] === v}">${esc(label)} <span class="muted">${num(n)}</span></button>`;
  const pages = y ? Math.ceil(y.total / y.size) : 0, p = st.p ?? 1;
  const catalogNote = manifest.catalog_pages ? ` Headlines of ${num(manifest.catalog_pages)} catalogued pages are searched here; <a href="${SERVER_EDITION}?view=search&q=${encodeURIComponent(q)}" rel="noopener">the server edition</a> searches the full text of every page.` : '';
  box.innerHTML = `
    ${!q ? emptyHtml('Type a word above in Korean, English, Chinese or any language the sites used.') : ''}
    ${search.error ? `<p class="alert" role="alert">Search failed: ${esc(search.error)}</p>` : ''}
    ${q && !y && search.busy ? emptyHtml('Searching…') : ''}
    ${y ? `<p class="muted">${num(y.total)} pages match “${esc(q)}”${st.host ? ` on ${esc(st.host)}` : ''}${st.m ? ` in ${esc(st.m)}` : ''}.${catalogNote}</p>
      <div class="chips" style="margin-top:1.2rem">
        ${Object.entries(y.facets.grp).map(([k, n]) => chip('grp', k, GROUP_NAME[k] ?? k, n)).join('')}
        ${Object.entries(y.facets.lang).slice(0, 6).map(([k, n]) => chip('lang', k, langName(k), n)).join('')}
        ${Object.entries(y.facets.year).map(([k, n]) => chip('year', k, k, n)).join('')}
        ${Object.entries(y.facets.host).slice(0, 8).map(([k, n]) => chip('host', k, k, n)).join('')}
        ${st.host || st.grp || st.lang || st.year || st.m ? '<button class="chip" id="clear-f">Clear filters</button>' : ''}</div>
      ${y.hits.length === 0 ? emptyHtml('No pages match. Try fewer words or clear a filter.') : `<ul class="hits">${y.hits.map(h => `<li class="hit">
          <button data-open="${h.id}" aria-label="Open ${esc(h.title?.replace(/<[^>]+>/g, '') ?? h.url)}">${h.shot ? `<img class="shot" src="${esc(shotUrl(h.shot))}" alt="" loading="lazy">` : '<div class="shot"></div>'}</button>
          <div><button class="t" data-open="${h.id}" ${h.lang ? `lang="${esc(h.lang)}"` : ''}>${h.title || esc(h.url)}</button>
            <div class="small muted" style="margin-top:.4rem">${sq(h.grp)} ${esc(h.host)}${h.pub_month ? ` · ${esc(h.pub_month)}` : ''}</div>
            ${h.snippet ? `<p class="snippet" ${h.lang ? `lang="${esc(h.lang)}"` : ''}>${h.snippet}</p>` : ''}</div></li>`).join('')}</ul>`}
      ${pages > 1 ? `<nav class="pager" aria-label="Pages of results"><button class="btn" id="pg-prev" ${p <= 1 ? 'disabled' : ''}>← Previous</button><span>Page ${p} of ${Math.min(pages, 417)}</span><button class="btn" id="pg-next" ${p >= pages ? 'disabled' : ''}>Next →</button></nav>` : ''}` : ''}`;
  box.querySelectorAll('[data-f]').forEach(b => { b.onclick = () => { const k = b.dataset.f, v = b.dataset.v; update({ [k]: st[k] === v ? undefined : v, p: undefined }); }; });
  const clear = box.querySelector('#clear-f'); if (clear) clear.onclick = () => update({ host: undefined, grp: undefined, lang: undefined, year: undefined, m: undefined, p: undefined });
  const prev = box.querySelector('#pg-prev'), next = box.querySelector('#pg-next');
  if (prev) prev.onclick = () => update({ p: p - 1 });
  if (next) next.onclick = () => update({ p: p + 1 });
}

/* ------------------------------------------------------------------ About ---- */

async function renderAbout(token) {
  const [status, hosts] = await Promise.all([api.status().catch(() => null), api.hosts().catch(() => null)]);
  if (!alive(token)) return;
  const dead = hosts?.filter(h => h.alive === false).length ?? 0;
  const of = g => hosts?.filter(h => h.grp === g) ?? [];
  const c = status?.counts;
  main.innerHTML = `<section class="about">
    <h1 class="h1 big">About this explorer</h1>
    <p class="lead">This is the North Korean web as the Wayback Machine preserved it. Every page here was captured from one of ${hosts?.length ?? 43} websites between 2016 and 2024 and is served from the archive, not from the live web. ${dead > 0 ? `Today ${dead} of those ${hosts.length} sites no longer answer at all.` : ''}</p>
    <h2 class="h2">Where the material comes from</h2>
    <p>The Internet Archive has crawled these sites since January 2016 as a curated collection, <a href="https://archive.org/details/ArchiveIt-Collection-6777" target="_blank" rel="noopener">Archive-It collection 6777</a>, described by its curator as “a crawl of web sites about/from North Korea”. The explorer reads that collection’s own archive files directly, so what you see is the page as it was served on the day it was captured.</p>
    <h2 class="h2">The three kinds of site</h2>
    <p>Colour separates who is publishing, because the same month reads very differently depending on the source.</p>
    <ul>${GROUPS.map(g => `<li>${sq(g)} <b style="font-weight:500">${GROUP_NAME[g]}</b> <span class="muted">(${of(g).length} sites)${of(g).length ? `: ${of(g).slice(0, 4).map(h => `<a href="#" data-host="${esc(h.host)}">${esc(h.display_name || h.host)}</a>`).join(', ')}${of(g).length > 4 ? ' and others' : ''}` : ''}</span></li>`).join('')}</ul>
    <h2 class="h2">How to use it</h2>
    <ul>
      <li><a href="#" data-view="scrubber">Timeline</a> — drag the handle, or press play, to watch the archive month by month. Marked dates are events worth landing on.</li>
      <li><a href="#" data-view="sites">Sites</a> — each site sized by how much of it survives, and what happened to it since.</li>
      <li><a href="#" data-view="wander">Wander</a> — one page at a time, chained by site, month or wording. Any find can be shared as a link.</li>
      <li><a href="#" data-view="search">Search</a> — headlines, in the language the page was written in. Korean, English and Chinese all work.</li></ul>
    <h2 class="h2">What the numbers mean, and what they do not</h2>
    <ul>
      <li><b style="font-weight:500">Publication dates are inferred.</b> Where a page or its address states a date, that date is used. Otherwise the month a page first appeared in the archive stands in for when it was published, which is close but not the same thing.</li>
      <li><b style="font-weight:500">Languages are detected automatically</b> and are occasionally wrong on very short pages.</li>
      <li><b style="font-weight:500">A screenshot is of an archived capture</b> near the middle of that month, not of the site as it looks now. Where a capture failed to replay, the month has no image rather than a substitute.</li>
      <li><b style="font-weight:500">Headlines come from the page itself.</b> Many of these sites put the site name in every page title, so the first real heading is shown instead where that happens.</li>
      <li><b style="font-weight:500">“Gone from the live web” means the address did not answer</b> when it was last checked from Internet Archive infrastructure. A site can be unreachable from here and reachable elsewhere.</li></ul>
    <h2 class="h2">This edition has no server</h2>
    <p>The <a href="${SERVER_EDITION}" rel="noopener">full edition</a> runs on a Postgres database of ${c ? num(c.pages) : 'millions of'} pages, ${c ? num(c.indexed) : 'millions'} of them full-text searchable. This page is a static copy of it: the month-by-month figures, home pages and headlines are files baked from that database${manifest.built_at ? ` on ${esc(manifest.built_at.slice(0, 10))}` : ''}; the pages you can open, wander through and search come from a catalog of ${manifest.catalog_pages ? num(manifest.catalog_pages) : 'the best-represented'} pages (the most-captured pages of every site and month, plus every page with a screenshot), which your browser downloads once from <a href="https://archive.org/details/${esc(manifest.item)}" rel="noopener">an archive.org item</a> and queries locally with SQLite. Screenshots are read from the same item. Search here covers headlines, not body text; “Read the page” shows the beginning of the text and can load the archived capture itself from the Wayback Machine.</p>
    ${c ? `<h2 class="h2">Currently in the archive</h2><table class="counts tabular"><tbody>
      <tr><th scope="row" style="padding-right:3.2rem">Pages recovered and read</th><td>${num(c.fetched)}</td></tr>
      <tr><th scope="row">Pages searchable on the server</th><td>${num(c.indexed)}</td></tr>
      <tr><th scope="row">Pages in this edition’s catalog</th><td>${num(manifest.catalog_pages ?? 0)}</td></tr>
      <tr><th scope="row">Screenshots made</th><td>${num(c.shot)}</td></tr>
      <tr><th scope="row">Sites</th><td>${num(status.hosts)}</td></tr></tbody></table>
      ${c.pages > c.fetched ? `<p class="small muted" style="margin-top:1.2rem">Another ${num(c.pages - c.fetched)} captured pages were still being read in when this snapshot was taken.</p>` : ''}` : ''}
    <h2 class="h2">Reading a page</h2>
    <p>Opening any page shows its headline, when it was captured and how often, and whether the address still resolved when last checked. “Open in the Wayback Machine” takes you to the archived page itself, with the Wayback toolbar and the full capture history.</p>
  </section>`;
}

/* ------------------------------------------------------------------ page detail (modal) ---- */

const modal = { id: null, data: null, error: null };
async function renderModal(token) {
  const host = $('modal');
  if (!st.page) { if (modal.id) { modal.id = null; modal.data = null; host.innerHTML = ''; } return; }
  if (modal.id !== st.page) {
    modal.id = st.page; modal.data = null; modal.error = null;
    drawModal();
    try { const d = await api.page(st.page); if (modal.id === st.page) modal.data = d; }
    catch (e) { if (modal.id === st.page) modal.error = String(e.message ?? e); }
    if (!alive(token) || modal.id !== st.page) return;
  }
  drawModal();
}
function drawModal() {
  const host = $('modal'), a = modal.data, err = modal.error;
  const close = () => update({ page: undefined }, true);
  const words = st.view === 'search' && st.q ? st.q.split(/\s+/).filter(x => x.length > 1) : [];
  const text = a?.text ? highlight(a.text, words) + (a.text.length >= 240 ? '…' : '') : '';
  host.innerHTML = `<dialog class="detail" aria-label="Page detail"><div class="scrim"></div><aside>
    <div class="top"><span class="small muted">${a ? `${GROUP_NAME[a.grp] ?? esc(a.grp)} · ${esc(a.host)}` : 'Loading'}</span><button class="btn" id="md-close" aria-label="Close" autofocus>Close</button></div>
    ${err ? `<div class="body red" style="padding-top:2.4rem">Could not load this page (${esc(err)}).</div>` : ''}
    ${a ? `<div class="body">
      ${a.shot ? `<img class="shot" src="${esc(shotUrl(a.shot))}" alt="" style="margin-top:1.6rem">` : ''}
      <h2 class="title" ${a.lang ? `lang="${esc(a.lang)}"` : ''}>${esc(a.title ?? a.url)}</h2>
      <div class="small muted" style="margin-top:.8rem">${a.pub_month ? monthName(a.pub_month) : 'Undated'}${a.lang ? ` · ${esc(langName(a.lang))}` : ''} · captured ${num(a.captures.count)}× from ${esc(a.captures.first)} to ${esc(a.captures.last)}</div>
      <div class="chips" style="margin-top:1.2rem;gap:1.2rem;align-items:center">
        <a class="btn btn-primary" href="${esc(a.wayback_url)}" target="_blank" rel="noopener">Open in the Wayback Machine</a>
        <button class="btn" id="md-embed">Show the archived page here</button>
        <span class="small">${a.alive === true ? '<span class="green">Still on the live web</span>' : a.alive === false ? '<span class="red">Gone from the live web</span>' : '<span class="muted">Live status not checked</span>'}</span></div>
      <div class="small muted" style="margin-top:.8rem;word-break:break-all">${esc(a.url)}</div>
      <div id="md-frame"></div>
      ${text ? `<p class="text" ${a.lang ? `lang="${esc(a.lang)}"` : ''}>${text}</p><p class="small muted" style="margin-top:.8rem">The catalog keeps the first lines of the text; the archived page above has all of it.</p>`
        : `<p class="muted" style="margin-top:2.4rem">The catalog holds no text preview for this page; the archived capture has the full page.</p>`}
      ${a.neighbors.same_host.length ? `<section style="margin-top:3.2rem"><h3 class="h2">More from ${esc(a.host)}</h3><div class="grid">${a.neighbors.same_host.map(p => cardHtml(p)).join('')}</div></section>` : ''}
      ${a.neighbors.same_month.length ? `<section style="margin-top:3.2rem"><h3 class="h2">Elsewhere in ${a.pub_month ? monthName(a.pub_month) : 'the same month'}</h3><div class="grid">${a.neighbors.same_month.map(p => cardHtml(p)).join('')}</div></section>` : ''}
    </div>` : ''}</aside></dialog>`;
  const dlg = host.querySelector('dialog');
  if (!dlg.open) dlg.showModal();
  dlg.addEventListener('cancel', e => { e.preventDefault(); close(); });
  host.querySelector('.scrim').onclick = close;
  host.querySelector('#md-close').onclick = close;
  const emb = host.querySelector('#md-embed');
  if (emb) emb.onclick = () => {
    $('md-frame').innerHTML = `<iframe src="https://web.archive.org/web/${esc(a.captures.best_ts)}if_/${esc(a.url)}" title="Archived page" loading="lazy" sandbox="allow-scripts allow-same-origin" referrerpolicy="no-referrer"></iframe>`;
    emb.remove();
  };
}

/* ------------------------------------------------------------------ boot ---- */

(async () => {
  try {
    const m = await getJSON('manifest.json', { optional: true });
    if (m) manifest = { ...manifest, ...m };
    if (manifest.catalog_pages) $('q').placeholder = `Search ${num(manifest.catalog_pages)} preserved pages`;
  } catch { /* the page still works without a manifest */ }
  render();
})();
