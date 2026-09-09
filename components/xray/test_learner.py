#!/usr/bin/env python3
"""Stdlib checks. --router uses the installed ucode HTML parser over SSH."""
import argparse
import http.server
import os
from pathlib import Path
import re
import shlex
import ssl
import subprocess
import tempfile
import threading
import time

HERE = Path(__file__).resolve().parent
ARGS = argparse.ArgumentParser()
ARGS.add_argument('--router', help='remote staging directory containing resources.uc')
ARGS = ARGS.parse_args()
SSH = ['ssh', '-F', str(Path.home() / '.ssh/config'), '-o', 'BatchMode=yes', 'flint2']


def run(args, **kwargs):
    return subprocess.run(args, text=True, capture_output=True, timeout=20, **kwargs)


def resources(html):
    if ARGS.router:
        cmd = SSH + [f'ucode {shlex.quote(ARGS.router)}/xray-route-resources.uc example.com /dev/stdin']
    else:
        cmd = ['ucode', str(HERE / 'xray-route-resources.uc'), 'example.com', '/dev/stdin']
    result = run(cmd, input=html)
    assert result.returncode == 0, result.stderr
    return result.stdout.splitlines()


def check_resources():
    html = '''<!-- <script src="/fake.js"></script> -->
    <SCRIPT crossorigin SRC="/main.js?a=1&amp;b=2"></SCRIPT>
    <link href='style.css' rel=stylesheet><script src=other.mjs></script>
    <script src="https://evil.example/escape.js"></script>
    <script src="//example.com/main.js?a=1&amp;b=2"></script>
    <script src="https://example.com.evil/escape.js"></script>
    <script src="//evil.example/escape.js"></script>
    <script src="https://example.com@evil.example/escape.js"></script>
    <script src="javascript:alert(1)"></script>
    <script src="/bad&#10;path.js"></script>
    <script src="//example.com/last.js#fragment"></script>
    <script src="/fifth.js"></script>'''
    assert resources(html) == ['https://example.com/main.js?a=1&b=2',
                               'https://example.com/style.css',
                               'https://example.com/other.mjs',
                               'https://example.com/last.js']
    assert resources('<base href="/app/"><script src="main.js"></script>') == []
    assert resources('<script>"<script src=\'/fake.js\'>"</script>') == []
    print('PASS resource extraction: native HTML, origin boundary, entities, limit, base')


def check_parser():
    def log(request, message):
        return f'Sun Sep 6 2026 daemon.info xray[99]: [Info] [{request}] {message}\n'
    receive = 'proxy/dokodemo: received request for 1.1.1.1:443'
    route = 'app/dispatcher: taking detour [direct] for [tcp:example.com:443]'
    data = log(100, receive) + log(101, route)  # shared PID is not a request ID
    data += log(100, route) + log(100, route)  # no duplicate per request
    data += log(102, receive) + log(102, route.replace('tcp:', 'udp:'))
    for i, host in enumerate(['127.0.0.1', 'router.lan', 'home.arpa', 'x.local', 'bad;touch.x']):
        data += log(110+i, receive) + log(110+i, route.replace('example.com', host))
    data += log(120, receive) + log(120, route.replace(':443]', ':80]'))
    data += log(121, receive) + log(121, route.replace('[direct]', '[proxy]'))
    parsed = run(['awk', '-f', str(HERE / 'xray-route-candidates.awk')], input=data)
    assert parsed.returncode == 0, parsed.stderr
    assert parsed.stdout.splitlines() == ['example.com', 'example.com'], parsed.stdout
    assert run(['awk', '-f', str(HERE / 'xray-route-candidates.awk')],
               input=log(100, route)).stdout == ''
    print('PASS log parser: request IDs, early TCP/QUIC, filtering, no historical trigger')


def check_fetch(tmp):
    cert, key = tmp / 'cert.pem', tmp / 'key.pem'
    generated = run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
                     '-keyout', str(key), '-out', str(cert), '-days', '1',
                     '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost'])
    assert generated.returncode == 0, generated.stderr

    class Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def do_GET(self):
            try:
                assert self.headers['Range'] == 'bytes=0-65535'
                status = {'/404': 404, '/redirect': 302}.get(self.path, 200)
                self.send_response(status)
                self.send_header('Content-Type', 'text/html')
                if self.path != '/unknown-large':
                    self.send_header('Content-Length', str(1048577 if self.path == '/large' else 65536))
                self.end_headers()
                if self.path in ('/partial', '/stall'):
                    self.wfile.write(b'x' * 16384)
                    self.wfile.flush()
                    if self.path == '/stall':
                        time.sleep(2)
                else:
                    self.wfile.write(b'x' * (1048577 if self.path in ('/large', '/unknown-large') else 65536))
            except (BrokenPipeError, ConnectionResetError, ssl.SSLError):
                pass

    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(cert, key)
    server.socket = context.wrap_socket(server.socket, server_side=True)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    env = dict(os.environ, CURL_CA_BUNDLE=str(cert))
    try:
        for path, expected in [('/ok', 0), ('/partial', 1), ('/stall', 1),
                               ('/404', 2), ('/redirect', 2), ('/large', 2), ('/unknown-large', 2)]:
            result = run(['sh', str(HERE / 'xray-route-fetch'),
                          f'https://localhost:{server.server_port}{path}', '1'], env=env)
            assert result.returncode == expected, (path, result.returncode, result.stdout, result.stderr)
        assert run(['sh', str(HERE / 'xray-route-fetch'), 'file:///etc/passwd', '1']).returncode == 2
    finally:
        server.shutdown()
        server.server_close()
    print('PASS real HTTPS: complete, HTTP-200 partial/stall, HTTP errors, size bounds, scheme')


def executable(path, content):
    path.write_text(content)
    path.chmod(0o755)


def check_candidate(tmp):
    root = tmp / 'candidate'
    for name in ['usr/libexec', 'etc/xray/profiles', 'var/run', 'var/lock', 'tmp', 'bin']:
        (root / name).mkdir(parents=True, exist_ok=True)
    (root / 'etc/xray/profiles/main-test.json').write_text('{}')
    (root / 'etc/xray/profiles/backup-spacevpn-nl.json').write_text('{}')
    (root / 'etc/xray/profiles/backup-spacevpn-de.json').write_text('{}')
    (root / 'etc/xray/active-profile').write_text('main-test')
    source = (HERE / 'xray-route-learn-candidate').read_text()
    source = re.sub(r'/(?:usr/libexec|etc/xray|var/run|var/lock|tmp)/',
                    lambda match: str(root) + match[0], source)
    executable(root / 'candidate', source)
    executable(root / 'bin/uci', '#!/bin/sh\ncase "$3" in *.retry_delay) echo 1 ;; esac\n')
    executable(root / 'bin/logger', '#!/bin/sh\nexit 0\n')
    executable(root / 'bin/jsonfilter', '#!/bin/sh\n[ "$SCENARIO" != already ] || echo domain:example.com\nexit 0\n')
    executable(root / 'usr/libexec/xray-route-resources.uc', '#!/bin/sh\necho https://example.com/main.js\n')
    executable(root / 'usr/libexec/xray-route-fetch', '''#!/bin/sh
echo "fetch $1" >>"$CALLS"
[ "$#" -lt 3 ] || echo '<script src="/main.js"></script>' >"$3"
echo '200 text/html'
case "$SCENARIO" in
 root) exit 1 ;;
 large) exit 2 ;;
 healthy|already) exit 0 ;;
esac
case "$1" in */main.js)
 if [ "$SCENARIO" = flaky ] && [ "$(grep -c 'fetch .*main.js' "$CALLS")" -ge 2 ]; then exit 0; fi
 exit 1 ;;
esac
exit 0
''')
    executable(root / 'usr/libexec/xray-profile-probe', '''#!/bin/sh
echo "proxy $3 $5" >>"$CALLS"
echo "profile $1" >>"$CALLS"
[ "$SCENARIO" != proxy_fails ]
''')
    executable(root / 'usr/libexec/xray-route-domain', '#!/bin/sh\necho "route $*" >>"$CALLS"\n')
    state = root / 'var/run/xray-route-learner/example.com.next'
    calls = root / 'calls'
    for scenario in ['partial', 'root', 'healthy', 'large', 'flaky', 'proxy_fails', 'already']:
        state.unlink(missing_ok=True)
        calls.write_text('')
        env = dict(os.environ, PATH=str(root / 'bin') + ':' + os.environ['PATH'],
                   SCENARIO=scenario, CALLS=str(calls))
        result = run(['sh', str(root / 'candidate'), 'example.com'], env=env)
        assert result.returncode == 0, (scenario, result.returncode, result.stderr)
        lines = calls.read_text().splitlines()
        assert any(line.startswith('route ') for line in lines) == (scenario in ('partial', 'root')), (scenario, lines)
        if scenario in ('partial', 'root'):
            url = 'https://example.com/' + ('main.js' if scenario == 'partial' else '')
            assert lines.count('fetch ' + url) == 2, lines
            assert lines.count('proxy ' + url + ' network') == 2, lines
        result = run(['sh', str(root / 'candidate'), 'example.com'], env=env)
        assert result.returncode == 0 and calls.read_text().splitlines() == lines
    for active in ('backup-spacevpn-nl', 'backup-spacevpn-de'):
        (root / 'etc/xray/active-profile').write_text(active)
        state.unlink(missing_ok=True)
        calls.write_text('')
        env['SCENARIO'] = 'partial'
        assert run(['sh', str(root / 'candidate'), 'example.com'], env=env).returncode == 0
        assert calls.read_text().count(f'profile {root}/etc/xray/profiles/{active}.json') == 2
        assert 'route add example.com auto' in calls.read_text()
    (root / 'etc/xray/active-profile').write_text('main-test')
    # Legacy six-hour success must be rechecked once using the new probe.
    state.write_text(str(int(time.time()) + 21600) + '\n')
    calls.write_text('')
    env['SCENARIO'] = 'partial'
    assert run(['sh', str(root / 'candidate'), 'example.com'], env=env).returncode == 0
    assert 'route add example.com auto' in calls.read_text()
    before = calls.read_text()
    assert run(['sh', str(root / 'candidate'), 'x;touch.bad'], env=env).returncode == 2
    assert calls.read_text() == before
    print('PASS candidate: two matching failures/successes, recovery, no false route, cooldown migration')


if __name__ == '__main__':
    check_resources()
    check_parser()
    with tempfile.TemporaryDirectory(prefix='xray-learner-test-') as directory:
        check_fetch(Path(directory))
        check_candidate(Path(directory))
    print('ALL CHECKS PASSED')
