#!/usr/bin/env python3
"""NihongoFlow local server — serves the app, proxies dictionary lookups, and
extracts YouTube subtitles server-side with multiple fallback strategies.
Run:  python3 nihongo_flow_server.py"""
import http.server
import urllib.request
import urllib.parse
import webbrowser
import threading
import json
import html as htmllib
import re
import os
import sys

PORT = 8765
DIR = os.path.dirname(os.path.abspath(__file__))

UA = ('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
      '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36')

ALLOWED_HOSTS = ('youtube.com', 'www.youtube.com', 'video.google.com',
                 'jisho.org', 'wikipedia.org', 'wikimedia.org')

INNERTUBE_KEY = 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8'
CLIENTS = [
    ('android', {'clientName': 'ANDROID', 'clientVersion': '20.10.38',
                 'androidSdkVersion': 30, 'hl': 'ja'}),
    ('ios', {'clientName': 'IOS', 'clientVersion': '20.10.4',
             'deviceModel': 'iPhone16,2', 'hl': 'ja'}),
    ('tv-embed', {'clientName': 'TVHTML5_SIMPLY_EMBEDDED_PLAYER',
                  'clientVersion': '2.0', 'hl': 'ja'}),
]


def host_ok(url):
    h = urllib.parse.urlparse(url).hostname or ''
    return any(h == a or h.endswith('.' + a) for a in ALLOWED_HOSTS)


def fetch(url, body=None, timeout=25):
    headers = {'User-Agent': UA, 'Accept-Language': 'ja,en;q=0.8'}
    if body is not None:
        headers['Content-Type'] = 'application/json'
    req = urllib.request.Request(url, data=body, headers=headers,
                                 method='POST' if body is not None else 'GET')
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read().decode('utf-8', 'replace')


# ---------- subtitle extraction ----------

def bracket_slice(s, key):
    i = s.find(key)
    if i < 0:
        return None
    j = i + len(key)
    depth = 0
    for k in range(j, len(s)):
        c = s[k]
        if c == '[':
            depth += 1
        elif c == ']':
            depth -= 1
            if depth == 0:
                return s[j:k + 1]
    return None


def pick_track(tracks):
    for t in tracks:
        if t.get('languageCode') == 'ja' and t.get('kind') != 'asr':
            return t
    for t in tracks:
        if t.get('languageCode') == 'ja':
            return t
    return tracks[0]


def with_fmt(url, fmt):
    url = re.sub(r'[&?]fmt=[^&]*', '', url)
    return url + ('&' if '?' in url else '?') + 'fmt=' + fmt if fmt else url


def parse_json3(txt):
    j = json.loads(txt)
    out = []
    for ev in j.get('events', []):
        segs = ev.get('segs')
        if not segs:
            continue
        text = ''.join(s.get('utf8', '') for s in segs).replace('\n', ' ').strip()
        if text:
            out.append({'t': int(ev.get('tStartMs', 0)), 'text': text})
    return out


def parse_xml(txt):
    out = []
    for m in re.finditer(r'<text start="([\d.]+)"[^>]*>(.*?)</text>', txt, re.S):
        tx = re.sub(r'<[^>]+>', '', m.group(2))
        tx = htmllib.unescape(htmllib.unescape(tx)).replace('\n', ' ').strip()
        if tx:
            out.append({'t': int(float(m.group(1)) * 1000), 'text': tx})
    return out


def segs_from_track(track, log):
    base = track.get('baseUrl')
    if not base:
        return None
    base = base.replace('\\u0026', '&')
    for fmt, parser in (('json3', parse_json3), ('', parse_xml)):
        try:
            txt = fetch(with_fmt(base, fmt) if fmt else re.sub(r'[&?]fmt=[^&]*', '', base))
            if txt and len(txt) > 30:
                segs = parser(txt)
                if segs:
                    return segs
            log.append(f'timedtext ({fmt or "xml"}): empty response')
        except Exception as e:
            log.append(f'timedtext ({fmt or "xml"}): {e}')
    return None


def innertube_tracks(vid, name, client, log):
    ctx = {'context': {'client': dict(client)}, 'videoId': vid,
           'contentCheckOk': True, 'racyCheckOk': True}
    if client['clientName'] == 'TVHTML5_SIMPLY_EMBEDDED_PLAYER':
        ctx['context']['thirdParty'] = {'embedUrl': 'https://www.youtube.com/'}
    try:
        txt = fetch(f'https://www.youtube.com/youtubei/v1/player?key={INNERTUBE_KEY}',
                    json.dumps(ctx).encode())
        j = json.loads(txt)
        tks = (j.get('captions', {})
                .get('playerCaptionsTracklistRenderer', {})
                .get('captionTracks'))
        if tks:
            return tks
        status = j.get('playabilityStatus', {}).get('status', '?')
        log.append(f'innertube {name}: no captions (status {status})')
    except Exception as e:
        log.append(f'innertube {name}: {e}')
    return None


def get_subs(vid):
    log = []
    title = ''
    sources = []

    # source 1: watch page
    try:
        page = fetch(f'https://www.youtube.com/watch?v={vid}&hl=ja')
        m = re.search(r'<title>(.*?)</title>', page)
        if m:
            title = htmllib.unescape(m.group(1)).replace(' - YouTube', '').strip()
        arr = bracket_slice(page, '"captionTracks":')
        if arr:
            sources.append(('watch-page', json.loads(arr)))
        else:
            log.append('watch page: no captionTracks found')
    except Exception as e:
        log.append(f'watch page: {e}')

    def result_from(name, tracks):
        tr = pick_track(tracks)
        segs = segs_from_track(tr, log)
        if segs:
            lang = tr.get('languageCode', '?') + (' (auto)' if tr.get('kind') == 'asr' else '')
            return {'title': title, 'segs': segs, 'source': f'{name} / {lang}', 'log': log}
        return None

    for name, tracks in sources:
        r = result_from(name, tracks)
        if r:
            return r

    # source 2..4: InnerTube clients
    for name, client in CLIENTS:
        tks = innertube_tracks(vid, name, client, log)
        if tks:
            r = result_from('innertube-' + name, tks)
            if r:
                return r

    return {'error': 'すべてのルートで字幕を取得できませんでした — all routes failed',
            'title': title, 'log': log}


# ---------- HTTP handler ----------

class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=DIR, **kw)

    def send_json(self, obj, code=200):
        data = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path.startswith('/subs?'):
            qs = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            vid = (qs.get('v') or [''])[0]
            if not re.fullmatch(r'[\w-]{11}', vid):
                self.send_json({'error': 'bad video id'}, 400)
                return
            try:
                self.send_json(get_subs(vid))
            except Exception as e:
                self.send_json({'error': str(e)}, 500)
        elif self.path.startswith('/proxy?'):
            self.proxy('GET')
        elif self.path in ('/', ''):
            self.send_response(302)
            self.send_header('Location', '/nihongo-flow.html')
            self.end_headers()
        else:
            super().do_GET()

    def do_POST(self):
        if self.path.startswith('/proxy?'):
            self.proxy('POST')
        else:
            self.send_error(404)

    def proxy(self, method):
        qs = urllib.parse.urlparse(self.path).query
        url = urllib.parse.parse_qs(qs).get('url', [None])[0]
        if not url or not url.startswith('http') or not host_ok(url):
            self.send_error(400, 'bad or disallowed url')
            return
        try:
            body = None
            if method == 'POST':
                ln = int(self.headers.get('Content-Length', 0) or 0)
                body = self.rfile.read(ln) if ln else None
            txt = fetch(url, body)
            data = txt.encode()
            self.send_response(200)
            self.send_header('Content-Type', 'text/plain; charset=utf-8')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.send_header('Content-Length', str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        except Exception as e:
            msg = str(e).encode()
            self.send_response(502)
            self.send_header('Access-Control-Allow-Origin', '*')
            self.send_header('Content-Length', str(len(msg)))
            self.end_headers()
            self.wfile.write(msg)

    def log_message(self, *a):
        pass


def main():
    if not os.path.exists(os.path.join(DIR, 'nihongo-flow.html')):
        print('⚠  nihongo-flow.html not found in this folder.')
        sys.exit(1)
    http.server.ThreadingHTTPServer.allow_reuse_address = True
    srv = http.server.ThreadingHTTPServer(('127.0.0.1', PORT), Handler)
    url = f'http://localhost:{PORT}/nihongo-flow.html'
    print('日本語Flow server running →', url)
    print('Keep this window open while using the app. Ctrl+C to stop.')
    threading.Timer(0.7, lambda: webbrowser.open(url)).start()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print('\nbye!')


if __name__ == '__main__':
    main()
