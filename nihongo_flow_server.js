#!/usr/bin/env node
/* NihongoFlow local server (Node.js 18+)- serves the app
- extracts YouTube subtitles (multiple fallback routes)
- downloads & stores the FULL JMdict dictionary + JLPT N1–N5 lists locally,
    then serves all word lookups offline via /dict and /jlpt
   Run:  node nihongo_flow_server.js */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const os = require('os');
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
  ['web', { clientName: 'WEB', clientVersion: '2.20250101.00.00', hl: 'ja' }],
  ['mweb', { clientName: 'MWEB', clientVersion: '2.20250101.01.00', hl: 'ja' }],
];

function hostOk(u) {
  try {
    const h = new URL(u).hostname;
    return ALLOWED.some(a => h === a || h.endsWith('.' + a));
  } catch { return false; }
}

async function grab(url, body, asBuffer, timeoutMs) {
  const headers = {
    'User-Agent': UA,
    'Accept-Language': 'ja,en;q=0.8',
    ...(body ? { 'Content-Type': 'application/json' } : {}),
  };
  // pre-accepted consent cookies — otherwise YouTube can answer with a
  // consent page instead of the video page, which breaks parsing
  if (/youtube\.com|google\.com/.test(url)) headers.Cookie = 'CONSENT=YES+cb; SOCS=CAI';
  const r = await fetch(url, {
    method: body ? 'POST' : 'GET',
    headers, body,
    signal: AbortSignal.timeout(timeoutMs || 120000),
  });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return asBuffer ? Buffer.from(await r.arrayBuffer()) : await r.text();
}
/* retry helper: transient failures (429 rate limit, network blips) get a
   second and third chance with a short pause between attempts */
async function grabRetry(url, body, asBuffer, timeoutMs, tries) {
  let last;
  for (let i = 0; i < (tries || 3); i++) {
    try { return await grab(url, body, asBuffer, timeoutMs); }
    catch (e) {
      last = e;
      if (!/HTTP (429|5\d\d)|fetch failed|timeout/i.test(e.message)) throw e;
      await new Promise(r => setTimeout(r, 1200 * (i + 1)));
    }
  }
  throw last;
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

/* ================= kanji details (KANJIDIC2) + radicals (KRADFILE) ================= */

const KANJIDIC_FILE = path.join(DIR, 'kanjidic-index.json');
const KRAD_FILE = path.join(DIR, 'krad-index.json');
const KANJIDIC_URLS = [
  'https://www.edrdg.org/kanjidic/kanjidic2.xml.gz',
  'http://ftp.edrdg.org/pub/Nihongo/kanjidic2.xml.gz',
];
const KRAD_SOURCES = [
  ['https://ftp.edrdg.org/pub/Nihongo/kradfile.gz', 'http://ftp.edrdg.org/pub/Nihongo/kradfile.gz'],
  ['https://ftp.edrdg.org/pub/Nihongo/kradfile2.gz', 'http://ftp.edrdg.org/pub/Nihongo/kradfile2.gz'],
];
let kanjiDic = null, krad = null, kanjiStatus = 'not started';

function parseKanjidic(xml) {
  const out = {};
  const re = /<character>([\s\S]*?)<\/character>/g;
  let m;
  while ((m = re.exec(xml))) {
    const c = m[1];
    const lit = (c.match(/<literal>(.*?)<\/literal>/) || [])[1];
    if (!lit) continue;
    out[lit] = {
      s: +((c.match(/<stroke_count>(\d+)/) || [])[1] || 0),
      g: +((c.match(/<grade>(\d+)/) || [])[1] || 0),
      j: +((c.match(/<jlpt>(\d)/) || [])[1] || 0),
      on: [...c.matchAll(/<reading r_type="ja_on">([^<]+)</g)].map(x => x[1]).slice(0, 4),
      kun: [...c.matchAll(/<reading r_type="ja_kun">([^<]+)</g)].map(x => x[1]).slice(0, 5),
      m: [...c.matchAll(/<meaning>([^<]+)</g)].map(x => x[1]).slice(0, 6), // no-attr = English
    };
  }
  return out;
}
function parseKrad(txt, map) {
  for (const line of txt.split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const [k, rest] = line.split(' : ');
    if (k && rest) map[k.trim()] = rest.trim().split(/\s+/);
  }
}
async function grabFirst(urls, asBuffer) {
  let last;
  for (const u of urls) { try { return await grab(u, null, asBuffer); } catch (e) { last = e; } }
  throw last;
}
async function ensureKanjiData() {
  try {
    if (fs.existsSync(KANJIDIC_FILE)) {
      kanjiDic = JSON.parse(fs.readFileSync(KANJIDIC_FILE, 'utf8'));
      console.log(`✓ kanji dictionary loaded from disk (${Object.keys(kanjiDic).length} characters)`);
    } else {
      console.log('downloading KANJIDIC2 kanji dictionary (~1.5 MB, one time)…');
      const xml = zlib.gunzipSync(await grabFirst(KANJIDIC_URLS, true)).toString('utf8');
      kanjiDic = parseKanjidic(xml);
      fs.writeFileSync(KANJIDIC_FILE, JSON.stringify(kanjiDic));
      console.log(`✓ kanji dictionary ready (${Object.keys(kanjiDic).length} characters)`);
    }
    if (fs.existsSync(KRAD_FILE)) {
      krad = JSON.parse(fs.readFileSync(KRAD_FILE, 'utf8'));
      console.log(`✓ radical decompositions loaded from disk (${Object.keys(krad).length} kanji)`);
    } else {
      console.log('downloading radical decompositions (KRADFILE)…');
      krad = {};
      for (const urls of KRAD_SOURCES) {
        try {
          const buf = zlib.gunzipSync(await grabFirst(urls, true));
          parseKrad(new TextDecoder('euc-jp').decode(buf), krad); // KRADFILE is EUC-JP encoded
        } catch (e) { console.log('  krad source failed:', e.message); }
      }
      if (Object.keys(krad).length) {
        fs.writeFileSync(KRAD_FILE, JSON.stringify(krad));
        console.log(`✓ radical decompositions ready (${Object.keys(krad).length} kanji)`);
      }
    }
    kanjiStatus = 'ready';
  } catch (e) {
    kanjiStatus = 'error: ' + e.message;
    console.log('⚠ kanji data setup failed:', e.message);
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
/* robust ordering: human ja subs first, then auto ja, then anything else —
   we try each in turn instead of betting everything on one track */
function orderedTracks(tracks) {
  const manualJa = tracks.filter(t => t.languageCode === 'ja' && t.kind !== 'asr');
  const asrJa = tracks.filter(t => t.languageCode === 'ja' && t.kind === 'asr');
  const rest = tracks.filter(t => t.languageCode !== 'ja');
  return [...manualJa, ...asrJa, ...rest].slice(0, 4);
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
      const txt = await grabRetry(withFmt(base, fmt), null, false, 25000, 2);
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
  'https://invidious.privacyredirect.com',
  'https://yt.artemislena.eu',
];
const PIPED = [
  'https://pipedapi.kavin.rocks',
  'https://pipedapi.adminforge.de',
  'https://api.piped.private.coffee',
  'https://pipedapi.ducks.party',
];
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
    const page = await grabRetry(`https://www.youtube.com/watch?v=${vid}&hl=ja`, null, false, 30000, 3);
    const m = page.match(/<title>([\s\S]*?)<\/title>/);
    if (m) title = unesc(m[1]).replace(/ - YouTube$/, '').trim();
    const arr = bracketSlice(page, '"captionTracks":');
    if (arr) sources.push(['watch-page', JSON.parse(arr)]);
    else log.push('watch page: no captionTracks found');
  } catch (e) {
    log.push(`watch page: ${e.message}`);
  }
  const tryTracks = async (name, tracks) => {
    for (const tr of orderedTracks(tracks)) {
      const segs = await segsFromTrack(tr, log);
      if (segs) {
        const lang = (tr.languageCode || '?') + (tr.kind === 'asr' ? ' (auto)' : '');
        return { title, segs, source: `${name} / ${lang}`, log };
      }
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

/* ================= reading library: NHK Easy News + Aozora Bunko books ================= */

function stripHtml(s) {
  return unesc(unesc(
    s.replace(/<rt>[\s\S]*?<\/rt>/g, '')     // drop furigana readings
     .replace(/<rp>[\s\S]*?<\/rp>/g, '')
     .replace(/<br\s*\/?>/gi, '\n')
     .replace(/<\/p>/gi, '\n')
     .replace(/<[^>]+>/g, '')
  )).replace(/［＃[^］]*］/g, '');            // drop Aozora typesetting notes
}

async function readingNews() {
  const txt = await grab('https://www3.nhk.or.jp/news/easy/news-list.json');
  const data = JSON.parse(txt.replace(/^﻿/, ''));
  const out = [];
  for (const day of (Array.isArray(data) ? data : [data])) {
    for (const key of Object.keys(day)) {
      for (const a of day[key] || []) {
        if (!a.news_id) continue;
        let img = a.news_web_image_uri || '';
        if (img && !img.startsWith('http')) img = `https://www3.nhk.or.jp/news/easy/${a.news_id}/${img}`;
        out.push({ id: a.news_id, title: stripHtml(String(a.title || '')), date: String(a.news_prearranged_time || '').slice(0, 10), img });
      }
    }
  }
  out.sort((a, b) => (a.date < b.date ? 1 : -1));
  return { articles: out.slice(0, 42) };
}

async function readingArticle(id) {
  const html = await grab(`https://www3.nhk.or.jp/news/easy/${id}/${id}.html`);
  const title = stripHtml(((html.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || '').split('|')[0].trim());
  let body = null;
  for (const re of [
    /<div[^>]*id="js-article-body"[^>]*>([\s\S]*?)<\/div>/,
    /<div[^>]*class="[^"]*article-main__body[^"]*"[^>]*>([\s\S]*?)<\/div>/,
    /<div[^>]*class="[^"]*article-body[^"]*"[^>]*>([\s\S]*?)<\/div>/,
  ]) {
    const m = html.match(re);
    if (m) { body = m[1]; break; }
  }
  if (!body) return { error: 'could not parse this article' };
  const paragraphs = stripHtml(body).split('\n').map(s => s.trim()).filter(Boolean);
  if (!paragraphs.length) return { error: 'article was empty' };
  return { title, paragraphs };
}

async function readingBook(url) {
  if (!url.startsWith('https://www.aozora.gr.jp/')) return { error: 'only aozora.gr.jp books allowed' };
  const buf = await grab(url, null, true);
  let html = new TextDecoder('utf-8', { fatal: false }).decode(buf);
  if (/charset=["']?shift_jis/i.test(html)) html = new TextDecoder('shift_jis').decode(buf);
  const title = stripHtml(((html.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || '').trim());
  const m = html.match(/<div class="main_text">([\s\S]*?)<\/div>/);
  if (!m) return { error: 'could not find the book text' };
  // walk the body, keeping the book's own illustrations in position
  const segs = [];
  const pushText = chunk => {
    for (const line of stripHtml(chunk).split('\n').map(s => s.trim()).filter(Boolean))
      segs.push({ t: -1, text: line });
  };
  let rest = m[1];
  const imgRe = /<img[^>]*src="([^"]+)"[^>]*>/;
  let im;
  while ((im = rest.match(imgRe))) {
    pushText(rest.slice(0, im.index));
    try { segs.push({ t: -1, img: new URL(im[1], url).href }); } catch {}
    rest = rest.slice(im.index + im[0].length);
  }
  pushText(rest);
  if (!segs.some(s => s.text)) return { error: 'book text was empty' };
  return { title, segs };
}

/* ================= Whisper transcription (high accuracy, local AI) =================
   Needs two free tools (one-time):  brew install yt-dlp whisper-cpp
   First run also downloads a speech model (~466 MB). Results are cached per video. */

const TRANS_DIR = path.join(DIR, 'transcripts');
const WHISPER_MODELS = ['ggml-medium.bin', 'ggml-small.bin']; // uses the best one present
const WHISPER_DL_NAME = 'ggml-small.bin';
const WHISPER_DL_URL = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin';

function run(cmd, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs || 600000, maxBuffer: 64 * 1024 * 1024 },
      (e, stdout, stderr) => e ? reject(new Error(String(stderr || e.message).slice(-400))) : resolve(stdout));
  });
}
async function hasCmd(cmd) {
  try { await run('which', [cmd], 5000); return true; } catch { return false; }
}
async function transcribe(vid) {
  const cacheF = path.join(TRANS_DIR, vid + '.json');
  if (fs.existsSync(cacheF)) return JSON.parse(fs.readFileSync(cacheF, 'utf8'));

  if (!await hasCmd('yt-dlp')) return { error: 'yt-dlp is not installed. Run:  brew install yt-dlp' };
  const wbin = (await hasCmd('whisper-cli')) ? 'whisper-cli'
             : (await hasCmd('whisper-cpp')) ? 'whisper-cpp' : null;
  if (!wbin) return { error: 'whisper is not installed. Run:  brew install whisper-cpp' };

  let model = WHISPER_MODELS.map(m => path.join(DIR, m)).find(p => fs.existsSync(p));
  if (!model) {
    console.log('downloading whisper model (~466 MB, one time only)…');
    model = path.join(DIR, WHISPER_DL_NAME);
    fs.writeFileSync(model, await grab(WHISPER_DL_URL, null, true, 1800000));
    console.log('✓ whisper model saved');
  }

  const base = path.join(os.tmpdir(), 'nf-' + vid);
  console.log(`[whisper] downloading audio for ${vid}…`);
  await run('yt-dlp', ['-x', '--audio-format', 'wav',
    '--postprocessor-args', 'ffmpeg:-ar 16000 -ac 1',
    '-o', base + '.%(ext)s', '--force-overwrites',
    'https://www.youtube.com/watch?v=' + vid], 600000);

  console.log('[whisper] transcribing (this can take a few minutes)…');
  // beam search width 5 = noticeably better kanji choices than greedy decoding
  await run(wbin, ['-m', model, '-l', 'ja', '-bs', '5', '-f', base + '.wav', '-oj', '-of', base], 3600000);

  const wj = JSON.parse(fs.readFileSync(base + '.json', 'utf8'));
  const segs = (wj.transcription || [])
    .map(s => ({ t: Math.round((s.offsets && s.offsets.from) || 0), text: (s.text || '').trim() }))
    .filter(s => s.text);
  fs.unlink(base + '.wav', () => {});
  fs.unlink(base + '.json', () => {});
  if (!segs.length) return { error: 'whisper produced no text' };

  let title = '';
  try { title = (await run('yt-dlp', ['--print', 'title', '--skip-download',
    'https://www.youtube.com/watch?v=' + vid], 60000)).trim(); } catch {}

  const out = { title, segs, source: 'whisper/' + path.basename(model).replace(/^ggml-|\.bin$/g, ''), log: [] };
  fs.mkdirSync(TRANS_DIR, { recursive: true });
  fs.writeFileSync(cacheF, JSON.stringify(out));
  console.log(`✓ whisper transcript cached (${segs.length} segments)`);
  return out;
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
    if (u.pathname === '/audio') {
      // real human pronunciation from the JapanesePod101 dictionary audio endpoint
      const kanji = u.searchParams.get('kanji') || '';
      const kana = u.searchParams.get('kana') || '';
      if (!kanji) { res.writeHead(404); return res.end(); }
      try {
        const url = 'https://assets.languagepod101.com/dictionary/japanese/audiomp3.php?kanji=' +
          encodeURIComponent(kanji) + (kana ? '&kana=' + encodeURIComponent(kana) : '');
        const r = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15000) });
        if (!r.ok) { res.writeHead(404); return res.end(); }
        const buf = Buffer.from(await r.arrayBuffer());
        // 52288 bytes = their known "audio not available" clip
        if (buf.length === 52288 || buf.length < 2000) { res.writeHead(404); return res.end(); }
        res.writeHead(200, {
          'Content-Type': 'audio/mpeg', 'Content-Length': buf.length,
          'Access-Control-Allow-Origin': '*', 'Cache-Control': 'public, max-age=604800',
        });
        return res.end(buf);
      } catch (e) { res.writeHead(404); return res.end(); }
    }
    if (u.pathname === '/related') {
      const vid = u.searchParams.get('v') || '';
      if (!/^[\w-]{11}$/.test(vid)) return sendJson(res, { videos: [] });
      try {
        const ctx = { context: { client: { clientName: 'ANDROID', clientVersion: '20.10.38', androidSdkVersion: 30, hl: 'ja' } }, videoId: vid };
        const j = JSON.parse(await grab(`https://www.youtube.com/youtubei/v1/next?key=${INNERTUBE_KEY}`, JSON.stringify(ctx)));
        const out = [];
        const seen = new Set([vid]);
        (function walk(o) {
          if (!o || typeof o !== 'object' || out.length >= 12) return;
          if (o.videoId && o.title && !seen.has(o.videoId)) {
            const t = typeof o.title === 'string' ? o.title
              : (o.title.simpleText || (o.title.runs && o.title.runs.map(r => r.text).join('')) || '');
            if (t) { seen.add(o.videoId); out.push({ id: o.videoId, title: t }); }
          }
          for (const k in o) walk(o[k]);
        })(j);
        return sendJson(res, { videos: out });
      } catch (e) {
        return sendJson(res, { videos: [], error: e.message });
      }
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
    if (u.pathname === '/reading/news') return sendJson(res, await readingNews());
    if (u.pathname === '/reading/article') {
      const id = u.searchParams.get('id') || '';
      if (!/^[\w-]+$/.test(id)) return sendJson(res, { error: 'bad id' }, 400);
      return sendJson(res, await readingArticle(id));
    }
    if (u.pathname === '/reading/book') {
      return sendJson(res, await readingBook(u.searchParams.get('url') || ''));
    }
    if (u.pathname === '/transcribe') {
      const vid = u.searchParams.get('v') || '';
      if (!/^[\w-]{11}$/.test(vid)) return sendJson(res, { error: 'bad video id' }, 400);
      return sendJson(res, await transcribe(vid));
    }
    if (u.pathname === '/kanji') {
      const chars = [...(u.searchParams.get('chars') || '')].filter(ch => /[一-龯々]/.test(ch)).slice(0, 12);
      const out = chars.map(ch => {
        const d = (kanjiDic && kanjiDic[ch]) || {};
        return {
          char: ch,
          strokes: d.s || null,
          grade: d.g || null,
          jlpt: d.j ? 'N' + d.j : null,
          on: d.on || [], kun: d.kun || [], meanings: d.m || [],
          radicals: (krad && krad[ch]) || [],
        };
      });
      return sendJson(res, { kanji: out, status: kanjiStatus });
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
  ensureData().then(ensureKanjiData); // download dictionaries + kanji data in background
});
