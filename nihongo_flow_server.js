#!/usr/bin/env node
/* NihongoFlow local server (Node.js 18+)
   - serves the app
   - extracts YouTube subtitles (multiple fallback routes)
   - downloads & stores the FULL JMdict dictionary + JLPT N1–N5 lists locally,
     then serves all word lookups offline via /dict and /jlpt
   Run:  node nihongo_flow_server.js */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { execFile } = require('child_process');

const PORT = +(process.env.PORT || 8765);   // cloud hosts inject PORT
const CLOUD = !!process.env.PORT;
const DIR = __dirname;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
           '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const ALLOWED = ['youtube.com', 'video.google.com', 'jisho.org', 'wikipedia.org', 'wikimedia.org', 'pollinations.ai'];
const INNERTUBE_KEY = 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8';
const CLIENTS = [
  ['android', { clientName: 'ANDROID', clientVersion: '20.10.38', androidSdkVersion: 30, hl: 'ja' }],
  ['ios', { clientName: 'IOS', clientVersion: '20.10.4', deviceModel: 'iPhone16,2', hl: 'ja' }],
  ['tv-embed', { clientName: 'TVHTML5_SIMPLY_EMBEDDED_PLAYER', clientVersion: '2.0', hl: 'ja' }],
];

function hostOk(u) {
  try {
    const h = new URL(u).hostname;
    return ALLOWED.some(a => h === a || h.endsWith('.' + a));
  } catch { return false; }
}

async function grab(url, body, asBuffer, timeoutMs) {
  const r = await fetch(url, {
    method: body ? 'POST' : 'GET',
    headers: {
      'User-Agent': UA,
      'Accept-Language': 'ja,en;q=0.8',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body,
    signal: AbortSignal.timeout(timeoutMs || 120000),
  });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return asBuffer ? Buffer.from(await r.arrayBuffer()) : await r.text();
}

/* ================= local dictionary (JMdict) ================= */

const DICT_FILE = path.join(DIR, 'jmdict-index.json');
const JLPT_FILE = path.join(DIR, 'jlpt-local.json');
const JMDICT_URLS = [
  'https://ftp.edrdg.org/pub/Nihongo/JMdict_e.gz',
  'http://ftp.edrdg.org/pub/Nihongo/JMdict_e.gz',
];
let dict = null;          // { word: [reading, gloss1, gloss2] }
let jlptLocal = null;     // { word: {level, reading, meaning} }
let dictStatus = 'not started';

const unesc = s => s
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
  .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

function parseJMdict(xml) {
  const index = {};
  const prio = {};
  const entryRe = /<entry>([\s\S]*?)<\/entry>/g;
  let m, count = 0;
  while ((m = entryRe.exec(xml))) {
    const e = m[1];
    const kebs = [...e.matchAll(/<keb>([^<]+)<\/keb>/g)].map(x => x[1]);
    const rebs = [...e.matchAll(/<reb>([^<]+)<\/reb>/g)].map(x => x[1]);
    if (!kebs.length && !rebs.length) continue;
    const senses = [...e.matchAll(/<sense>([\s\S]*?)<\/sense>/g)];
    const glosses = [];
    for (const s of senses.slice(0, 3)) {
      const gs = [...s[1].matchAll(/<gloss[^>]*>([^<]+)<\/gloss>/g)].map(x => unesc(x[1]));
      if (gs.length) glosses.push(gs.slice(0, 4).join('; '));
    }
    if (!glosses.length) continue;
    // priority: common words carry ichi1/news1/spec1 tags
    const score = (e.includes('ichi1') ? 2 : 0) + (e.includes('news1') ? 1 : 0) + (e.includes('spec1') ? 1 : 0);
    const val = [unesc(rebs[0] || ''), glosses[0] || '', glosses[1] || ''];
    for (const k of [...kebs, ...rebs]) {
      const key = unesc(k);
      if (!(key in index) || score > (prio[key] || 0)) { index[key] = val; prio[key] = score; }
    }
    count++;
  }
  return { index, count };
}

const JLPT_CSV_SOURCES = [
  lv => `https://cdn.jsdelivr.net/gh/jamsinclair/open-anki-jlpt-decks@main/src/${lv}.csv`,
  lv => `https://cdn.jsdelivr.net/gh/elzup/jlpt-word-list@master/src/${lv}.csv`,
];
function parseCSV(txt) {
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < txt.length; i++) {
    const c = txt[i];
    if (q) {
      if (c === '"') { if (txt[i + 1] === '"') { cell += '"'; i++; } else q = false; }
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell.replace(/\r$/, '')); rows.push(row); row = []; cell = ''; }
    else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}
const kata2hira = s => s.replace(/[ァ-ヶ]/g, c => String.fromCharCode(c.charCodeAt(0) - 0x60));
const normJP = s => s.replace(/[～〜\s]/g, '').replace(/[（(].*?[）)]/g, '');

async function buildJlptLocal() {
  const map = {};
  for (const lv of ['n1', 'n2', 'n3', 'n4', 'n5']) { // easier levels overwrite
    for (const src of JLPT_CSV_SOURCES) {
      try {
        const txt = await grab(src(lv));
        for (const row of parseCSV(txt).slice(1)) {
          const [expr, reading, meaning] = row;
          if (!expr) continue;
          const rd = kata2hira(normJP((reading || '').split(/[;、]/)[0] || ''));
          for (let e of expr.split(/[;、]/)) {
            e = normJP(e);
            if (e) map[e] = { level: lv, reading: rd, meaning: meaning || '' };
          }
          if (rd && rd.length > 1 && !(rd in map)) map[rd] = { level: lv, reading: rd, meaning: meaning || '' };
        }
      } catch (e) { console.log(`  jlpt ${lv}: ${e.message}`); }
    }
  }
  return map;
}

async function ensureData() {
  try {
    // JLPT lists
    if (fs.existsSync(JLPT_FILE)) {
      jlptLocal = JSON.parse(fs.readFileSync(JLPT_FILE, 'utf8'));
      console.log(`✓ JLPT lists loaded from disk (${Object.keys(jlptLocal).length} entries)`);
    }
    if (!jlptLocal || Object.keys(jlptLocal).length < 1000) {
      console.log('downloading JLPT N1–N5 word lists…');
      const built = await buildJlptLocal();
      if (Object.keys(built).length >= 1000) {
        jlptLocal = built;
        fs.writeFileSync(JLPT_FILE, JSON.stringify(jlptLocal));
        console.log(`✓ JLPT lists saved locally (${Object.keys(jlptLocal).length} entries → jlpt-local.json)`);
      } else {
        console.log('⚠ JLPT list download failed — will retry next start (app falls back to CDN lists)');
        jlptLocal = jlptLocal && Object.keys(jlptLocal).length ? jlptLocal : null;
      }
    }
    // JMdict
    if (fs.existsSync(DICT_FILE)) {
      dictStatus = 'loading from disk';
      dict = JSON.parse(fs.readFileSync(DICT_FILE, 'utf8'));
      dictStatus = 'ready';
      console.log(`✓ JMdict dictionary loaded from disk (${Object.keys(dict).length} forms)`);
    } else {
      dictStatus = 'downloading JMdict (~12 MB)…';
      console.log('downloading full JMdict dictionary (~12 MB, one time only)…');
      let buf = null, lastErr = null;
      for (const u of JMDICT_URLS) {
        try { buf = await grab(u, null, true); break; } catch (e) { lastErr = e; }
      }
      if (!buf) throw new Error('JMdict download failed: ' + (lastErr && lastErr.message));
      dictStatus = 'parsing dictionary…';
      console.log('parsing dictionary (takes ~10-30s)…');
      const xml = zlib.gunzipSync(buf).toString('utf8');
      const { index, count } = parseJMdict(xml);
      dict = index;
      fs.writeFileSync(DICT_FILE, JSON.stringify(index));
      dictStatus = 'ready';
      console.log(`✓ JMdict ready: ${count} entries, ${Object.keys(index).length} lookup forms → jmdict-index.json`);
    }
  } catch (e) {
    dictStatus = 'error: ' + e.message;
    console.log('⚠ dictionary setup failed:', e.message, '(app falls back to online lookups)');
  }
}

/* ================= subtitle extraction ================= */

function bracketSlice(s, key) {
  const i = s.indexOf(key);
  if (i < 0) return null;
  let depth = 0;
  for (let k = i + key.length; k < s.length; k++) {
    const c = s[k];
    if (c === '[') depth++;
    else if (c === ']') { depth--; if (depth === 0) return s.slice(i + key.length, k + 1); }
  }
  return null;
}
function pickTrack(tracks) {
  return tracks.find(t => t.languageCode === 'ja' && t.kind !== 'asr')
      || tracks.find(t => t.languageCode === 'ja')
      || tracks[0];
}
function withFmt(url, fmt) {
  url = url.replace(/[&?]fmt=[^&]*/, '');
  return fmt ? url + (url.includes('?') ? '&' : '?') + 'fmt=' + fmt : url;
}
function parseJson3(txt) {
  const j = JSON.parse(txt);
  const out = [];
  for (const ev of (j.events || [])) {
    if (!ev.segs) continue;
    const text = ev.segs.map(s => s.utf8 || '').join('').replace(/\n/g, ' ').trim();
    if (text) out.push({ t: Math.round(ev.tStartMs || 0), text });
  }
  return out;
}
function parseXmlCaps(txt) {
  const out = [];
  const re = /<text start="([\d.]+)"[^>]*>([\s\S]*?)<\/text>/g;
  let m;
  while ((m = re.exec(txt))) {
    const tx = unesc(unesc(m[2].replace(/<[^>]+>/g, ''))).replace(/\n/g, ' ').trim();
    if (tx) out.push({ t: Math.round(parseFloat(m[1]) * 1000), text: tx });
  }
  return out;
}
async function segsFromTrack(track, log) {
  let base = track.baseUrl;
  if (!base) return null;
  base = base.replace(/\\u0026/g, '&');
  for (const [fmt, parser] of [['json3', parseJson3], ['', parseXmlCaps]]) {
    try {
      const txt = await grab(withFmt(base, fmt));
      if (txt && txt.length > 30) {
        const segs = parser(txt);
        if (segs.length) return segs;
      }
      log.push(`timedtext (${fmt || 'xml'}): empty response`);
    } catch (e) {
      log.push(`timedtext (${fmt || 'xml'}): ${e.message}`);
    }
  }
  return null;
}
async function innertubeTracks(vid, name, client, log) {
  const ctx = { context: { client: { ...client } }, videoId: vid, contentCheckOk: true, racyCheckOk: true };
  if (client.clientName === 'TVHTML5_SIMPLY_EMBEDDED_PLAYER') {
    ctx.context.thirdParty = { embedUrl: 'https://www.youtube.com/' };
  }
  try {
    const txt = await grab(`https://www.youtube.com/youtubei/v1/player?key=${INNERTUBE_KEY}`, JSON.stringify(ctx));
    const j = JSON.parse(txt);
    const tks = j.captions && j.captions.playerCaptionsTracklistRenderer
      && j.captions.playerCaptionsTracklistRenderer.captionTracks;
    if (tks && tks.length) return tks;
    log.push(`innertube ${name}: no captions (status ${(j.playabilityStatus || {}).status || '?'})`);
  } catch (e) {
    log.push(`innertube ${name}: ${e.message}`);
  }
  return null;
}
/* Invidious / Piped public instances — they run their own YouTube unblocking,
   which rescues subtitle fetching when this server's IP is blocked (cloud hosts) */
const INVIDIOUS = [
  'https://inv.nadeko.net',
  'https://invidious.nerdvpn.de',
  'https://yewtu.be',
  'https://iv.melmac.space',
  'https://invidious.f5.si',
];
const PIPED = ['https://pipedapi.kavin.rocks', 'https://pipedapi.adminforge.de'];
function parseVTT(txt) {
  const out = [];
  const re = /(\d{2}):(\d{2}):(\d{2})[.,](\d{3})\s*-->/;
  for (const block of txt.split(/\n\s*\n/)) {
    const lines = block.trim().split('\n');
    const ti = lines.findIndex(l => re.test(l));
    if (ti < 0) continue;
    const m = lines[ti].match(re);
    const t = (+m[1] * 3600 + +m[2] * 60 + +m[3]) * 1000 + +m[4];
    const text = lines.slice(ti + 1).join(' ').replace(/<[^>]+>/g, '').trim();
    if (text && !/^WEBVTT/.test(text)) out.push({ t, text });
  }
  return out;
}
async function alternativeFrontends(vid, log) {
  for (const base of INVIDIOUS) {
    const host = new URL(base).hostname;
    try {
      const caps = JSON.parse(await grab(`${base}/api/v1/captions/${vid}`, null, false, 12000));
      const list = caps.captions || caps;
      if (!Array.isArray(list) || !list.length) { log.push(`invidious ${host}: no captions`); continue; }
      const c = list.find(x => (x.language_code || x.languageCode) === 'ja')
             || list.find(x => (x.label || '').includes('日本語')) || list[0];
      const capUrl = c.url.startsWith('http') ? c.url : base + c.url;
      const segs = parseVTT(await grab(capUrl, null, false, 12000));
      if (segs.length) return { segs, source: 'invidious/' + host + ' / ' + (c.language_code || c.languageCode || '?') };
      log.push(`invidious ${host}: empty vtt`);
    } catch (e) { log.push(`invidious ${host}: ${e.message}`); }
  }
  for (const base of PIPED) {
    const host = new URL(base).hostname;
    try {
      const j = JSON.parse(await grab(`${base}/streams/${vid}`, null, false, 12000));
      const subs = j.subtitles || [];
      if (!subs.length) { log.push(`piped ${host}: no captions`); continue; }
      const c = subs.find(x => (x.code || '').startsWith('ja')) || subs[0];
      const segs = parseVTT(await grab(c.url, null, false, 12000));
      if (segs.length) return { segs, source: 'piped/' + host + ' / ' + (c.code || '?'), title: j.title || '' };
      log.push(`piped ${host}: empty vtt`);
    } catch (e) { log.push(`piped ${host}: ${e.message}`); }
  }
  return null;
}

async function getSubs(vid) {
  const log = [];
  let title = '';
  const sources = [];
  try {
    const page = await grab(`https://www.youtube.com/watch?v=${vid}&hl=ja`);
    const m = page.match(/<title>([\s\S]*?)<\/title>/);
    if (m) title = unesc(m[1]).replace(/ - YouTube$/, '').trim();
    const arr = bracketSlice(page, '"captionTracks":');
    if (arr) sources.push(['watch-page', JSON.parse(arr)]);
    else log.push('watch page: no captionTracks found');
  } catch (e) {
    log.push(`watch page: ${e.message}`);
  }
  const tryTracks = async (name, tracks) => {
    const tr = pickTrack(tracks);
    const segs = await segsFromTrack(tr, log);
    if (segs) {
      const lang = (tr.languageCode || '?') + (tr.kind === 'asr' ? ' (auto)' : '');
      return { title, segs, source: `${name} / ${lang}`, log };
    }
    return null;
  };
  for (const [name, tracks] of sources) {
    const r = await tryTracks(name, tracks);
    if (r) return r;
  }
  for (const [name, client] of CLIENTS) {
    const tks = await innertubeTracks(vid, name, client, log);
    if (tks) {
      const r = await tryTracks('innertube-' + name, tks);
      if (r) return r;
    }
  }
  // last resort: alternative YouTube frontends with their own unblocking
  const alt = await alternativeFrontends(vid, log);
  if (alt) return { title: title || alt.title || '', segs: alt.segs, source: alt.source, log };
  return { error: 'すべてのルートで字幕を取得できませんでした — all routes failed', title, log };
}

/* ================= HTTP server ================= */

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.ico': 'image/x-icon' };
function sendJson(res, obj, code = 200) {
  const data = Buffer.from(JSON.stringify(obj));
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*', 'Content-Length': data.length });
  res.end(data);
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://localhost:${PORT}`);
  try {
    if (u.pathname === '/subs') {
      const vid = u.searchParams.get('v') || '';
      if (!/^[\w-]{11}$/.test(vid)) return sendJson(res, { error: 'bad video id' }, 400);
      return sendJson(res, await getSubs(vid));
    }
    if (u.pathname === '/dict') {
      const word = u.searchParams.get('word') || '';
      if (!dict) return sendJson(res, { found: false, status: dictStatus });
      const hit = dict[word] || dict[normJP(word)];
      const jl = jlptLocal && (jlptLocal[normJP(word)] || null);
      if (!hit && !jl) return sendJson(res, { found: false, status: 'ready' });
      return sendJson(res, {
        found: true,
        reading: (hit && hit[0]) || (jl && jl.reading) || '',
        senses: hit ? [hit[1], hit[2]].filter(Boolean).map(g => ({ pos: '', gloss: g }))
                    : [{ pos: '', gloss: jl.meaning }],
        level: jl ? jl.level : null,
      });
    }
    if (u.pathname === '/jlpt') {
      if (!jlptLocal) return sendJson(res, { error: 'not ready' }, 503);
      return sendJson(res, jlptLocal);
    }
    if (u.pathname === '/story') {
      const prompt = (u.searchParams.get('prompt') || '').slice(0, 1500);
      if (!prompt) return sendJson(res, { error: 'no prompt' }, 400);
      try {
        const txt = await grab('https://text.pollinations.ai/' + encodeURIComponent(prompt));
        return sendJson(res, { story: txt.trim() });
      } catch (e) {
        return sendJson(res, { error: 'AI fetch failed: ' + e.message }, 502);
      }
    }
    if (u.pathname === '/dictstatus') {
      return sendJson(res, { status: dictStatus, jlpt: !!jlptLocal, forms: dict ? Object.keys(dict).length : 0 });
    }
    if (u.pathname === '/proxy') {
      const target = u.searchParams.get('url');
      if (!target || !target.startsWith('http') || !hostOk(target)) {
        return sendJson(res, { error: 'bad or disallowed url' }, 400);
      }
      let body = null;
      if (req.method === 'POST') {
        const chunks = [];
        for await (const c of req) chunks.push(c);
        body = Buffer.concat(chunks);
      }
      try {
        const txt = await grab(target, body);
        const data = Buffer.from(txt);
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Access-Control-Allow-Origin': '*', 'Content-Length': data.length });
        return res.end(data);
      } catch (e) {
        const msg = Buffer.from(String(e.message));
        res.writeHead(502, { 'Access-Control-Allow-Origin': '*', 'Content-Length': msg.length });
        return res.end(msg);
      }
    }
    if (u.pathname === '/' || u.pathname === '') {
      res.writeHead(302, { Location: '/nihongo-flow.html' });
      return res.end();
    }
    const fp = path.join(DIR, path.normalize(u.pathname).replace(/^(\.\.[/\\])+/, ''));
    const ext = path.extname(fp).toLowerCase();
    if (fp.startsWith(DIR) && MIME[ext] && fs.existsSync(fp)) {
      const data = fs.readFileSync(fp);
      res.writeHead(200, { 'Content-Type': MIME[ext], 'Content-Length': data.length });
      return res.end(data);
    }
    res.writeHead(404); res.end('not found');
  } catch (e) {
    sendJson(res, { error: String(e.message) }, 500);
  }
});

if (!fs.existsSync(path.join(DIR, 'nihongo-flow.html'))) {
  console.log('⚠  nihongo-flow.html not found in this folder.');
  process.exit(1);
}
server.listen(PORT, CLOUD ? '0.0.0.0' : '127.0.0.1', () => {
  const url = `http://localhost:${PORT}/nihongo-flow.html`;
  console.log('日本語Flow server running →', url);
  if (!CLOUD){
    console.log('Keep this window open while using the app. Ctrl+C to stop.');
    const opener = process.platform === 'darwin' ? 'open' : (process.platform === 'win32' ? 'start' : 'xdg-open');
    setTimeout(() => execFile(opener, [url], () => {}), 700);
  }
  ensureData(); // download dictionary + JLPT lists in background
});
