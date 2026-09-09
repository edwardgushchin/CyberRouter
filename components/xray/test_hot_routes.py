#!/usr/bin/env python3
"""Isolated Xray/route-helper integration on Flint 2; never alters production config.

Uses installed Xray/ucode plus Python stdlib and an SSH-owned nc pipe.
"""
import hashlib
import json
from pathlib import Path
import re
import select
import shlex
import socket
import socketserver
import subprocess
import threading
import time

HERE = Path(__file__).resolve().parent
SSH = ['ssh', '-F', str(Path.home() / '.ssh/config'), '-o', 'BatchMode=yes']
DOMAIN = 'route-hot-test.example'


def geosite(domain):
    """Настоящий protobuf GeoSiteList без дополнительной Python-зависимости."""
    def varint(value):
        result = bytearray()
        while value > 127:
            result.append((value & 127) | 128)
            value >>= 7
        result.append(value)
        return bytes(result)

    def field(number, value):
        return varint(number * 8 + 2) + varint(len(value)) + value

    entries = [domain] + [f'fixture-{i}.example' for i in range(6000)]
    group = field(1, b'REFILTER') + b''.join(
        field(2, b'\x08\x02' + field(2, entry.encode())) for entry in entries)
    return field(1, group)


def check_refilter(root, files, call, source, stream, port):
    assets = root + '/assets'
    remote(f'mkdir -p {assets} {root}/bin')
    blobs = [geosite(DOMAIN), geosite('another-fixture.example')]
    names = []
    for blob in blobs:
        name = 'refilter-' + hashlib.sha256(blob).hexdigest() + '.dat'
        put_binary(f'{assets}/{name}', blob)
        names.append(name)
    baseline = [json.loads(remote('cat ' + file).stdout) for file in files]
    before_auto = remote(f'cat {root}/etc/xray/auto-proxy-domains').stdout
    remote(f'{call} refilter {names[0]}')
    try:
        with socks(port) as fresh:
            echo(fresh)
    except (OSError, AssertionError):
        pass
    else:
        raise AssertionError('geosite rule did not change new connection route')
    for i in range(30):
        echo(stream, f'geosite-update-{i}'.encode())
    for file, original in zip(files, baseline):
        changed = json.loads(remote('cat ' + file).stdout)
        rule = changed['routing']['rules'].pop(-2)
        assert rule == {'type': 'field', 'ruleTag': 'auto-refilter-domains',
                        'domain': [f'ext:{names[0]}:refilter'], 'outboundTag': 'proxy'}
        assert changed == original, 'unrelated config changed'
    remote(f'{call} refilter {names[1]}')
    with socks(port) as fresh:
        echo(fresh)
    before = remote('sha256sum ' + ' '.join(files)).stdout
    remote(f'{call} refilter {names[1]}')
    assert remote('sha256sum ' + ' '.join(files)).stdout == before
    assert remote(f'cat {root}/etc/xray/auto-proxy-domains').stdout == before_auto

    # После обновления learner должен изменять прежнее правило и сохранять свою запись.
    remote(f'{call} add {DOMAIN} auto')
    remote(f'{call} refilter {names[0]}')
    for file in files:
        c = json.loads(remote('cat ' + file).stdout)
        assert 'domain:' + DOMAIN in c['routing']['rules'][0]['domain']
        assert len([r for r in c['routing']['rules'] if r.get('ruleTag') == 'auto-refilter-domains']) == 1
    assert remote(f'cat {root}/etc/xray/auto-proxy-domains').stdout.strip() == DOMAIN
    remote(f'{call} remove {DOMAIN}')
    remote(f'{call} refilter {names[1]}')
    put(root + '/no-api-helper', source.replace('127.0.0.1:10086', '127.0.0.1:10089'))
    before = remote('sha256sum ' + ' '.join(files)).stdout
    assert remote(f'XRAY_LOCATION_ASSET={assets} sh {root}/no-api-helper refilter {names[0]}', ok=False).returncode != 0
    assert remote('sha256sum ' + ' '.join(files)).stdout == before
    with socks(port) as fresh:
        echo(fresh)

    # Подменён только HTTPS-транспорт GitHub; ucode, Xray, API и запись профилей настоящие.
    put(root + '/bin/curl', f'''#!/bin/sh
printf '%s\\n' "$*" >>{root}/fetch-calls
[ ! -f {root}/fetch-fail ] || exit 28
while [ "$#" -gt 0 ]; do
    case "$1" in --output) shift; output="$1";; esac
    url="$1"
    shift
done
case "$url" in
    https://api.github.com/*) cp {root}/release.json "$output";;
    https://github.com/*) cp {root}/payload.dat "$output";;
    *) exit 22;;
esac
''')
    updater = (HERE / 'xray-refilter-update').read_text()
    updater = re.sub(r'/(?:etc/xray|var/lock|tmp)/', lambda m: root + m[0], updater)
    updater = re.sub(r'^ASSET_DIR=.*$', f'ASSET_DIR="{assets}"', updater, flags=re.M)
    updater = updater.replace('/usr/libexec/xray-route-domain', root + '/helper')
    put(root + '/updater', updater)
    remote(f'chmod +x {root}/bin/curl {root}/helper')
    update = f'PATH={root}/bin:$PATH sh {root}/updater'
    payload = geosite('updated-fixture.example')
    digest = hashlib.sha256(payload).hexdigest()
    metadata = {'draft': False, 'prerelease': False, 'assets': [{
        'name': 'geosite.dat', 'size': len(payload), 'digest': 'sha256:' + digest,
        'browser_download_url': 'https://github.com/1andrevich/Re-filter-lists/releases/download/test/geosite.dat'}]}
    put(root + '/release.json', json.dumps(metadata))
    put_binary(root + '/payload.dat', payload)
    remote(update)
    assert digest in remote(f'cat {root}/etc/xray/refilter-last-update').stdout
    before = remote('sha256sum ' + ' '.join(files)).stdout
    remote(update)
    calls = remote(f'cat {root}/fetch-calls').stdout.splitlines()
    assert len(calls) == 3, 'unchanged asset should not be downloaded again'
    assert all('--proto =https --proto-redir =https' in row for row in calls)
    assert all('--max-filesize 20971520' in row for row in calls)
    assert remote('sha256sum ' + ' '.join(files)).stdout == before

    remote(f'touch {root}/fetch-fail')
    assert remote(update, ok=False).returncode != 0
    remote(f'rm {root}/fetch-fail')
    bad_cases = [dict(metadata['assets'][0], digest='sha256:' + 'a' * 64),
                 dict(metadata['assets'][0], browser_download_url='https://untrusted.example/geosite.dat'),
                 dict(metadata['assets'][0], size=0)]
    for bad in bad_cases:
        put(root + '/release.json', json.dumps({'assets': [bad]}))
        assert remote(update, ok=False).returncode != 0
        assert remote('sha256sum ' + ' '.join(files)).stdout == before

    invalid = b'not-protobuf' * 10000
    bad = dict(metadata['assets'][0], digest='sha256:' + hashlib.sha256(invalid).hexdigest(), size=len(invalid))
    put(root + '/release.json', json.dumps({'assets': [bad]}))
    put_binary(root + '/payload.dat', invalid)
    assert remote(update, ok=False).returncode != 0
    assert remote('sha256sum ' + ' '.join(files)).stdout == before
    assert digest in remote(f'cat {root}/etc/xray/refilter-last-update').stdout
    echo(stream)
    with socks(port) as fresh:
        echo(fresh)
    print('PASS geosite update/replacement/no-op, learner preservation, API rollback, 30 old-stream exchanges')
    print('PASS updater download/cache, HTTPS restrictions, network/checksum/metadata/protobuf rejection')


def remote(command, data=None, ok=True):
    result = subprocess.run(SSH + ['flint2', command], input=data, text=True,
                            capture_output=True, timeout=20)
    if ok:
        assert result.returncode == 0, (command, result.stderr)
    return result


def put(path, data):
    remote('cat >' + shlex.quote(path), data)


def put_binary(path, data):
    subprocess.run(SSH + ['flint2', 'cat >' + shlex.quote(path)], input=data,
                   capture_output=True, timeout=20, check=True)


def receive(sock, length):
    data = b''
    while len(data) < length:
        chunk = sock.recv(length - len(data))
        assert chunk, 'connection closed'
        data += chunk
    return data


class Pipe:
    def __init__(self):
        self.process = subprocess.Popen(SSH + ['flint2', 'nc 127.0.0.1 10828'],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, bufsize=0)

    def sendall(self, data):
        self.process.stdin.write(data)

    def recv(self, length):
        if not select.select([self.process.stdout], [], [], 2)[0]:
            raise TimeoutError('echo timed out')
        return self.process.stdout.read(length)

    def close(self):
        self.process.terminate()
        self.process.wait(timeout=5)

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()


def socks(port):
    sock = Pipe()
    try:
        sock.sendall(b'\x05\x01\x00')
        assert receive(sock, 2) == b'\x05\x00'
        host = DOMAIN.encode()
        sock.sendall(b'\x05\x01\x00\x03' + bytes([len(host)]) + host + port.to_bytes(2, 'big'))
        head = receive(sock, 4)
        assert head[:2] == b'\x05\x00', head
        receive(sock, {1: 4, 4: 16}[head[3]] + 2)
        return sock
    except BaseException:
        sock.close()
        raise


def echo(sock, data=b'route-update-keeps-this-connection'):
    sock.sendall(data)
    assert receive(sock, len(data)) == data


class Echo(socketserver.BaseRequestHandler):
    def handle(self):
        try:
            while data := self.request.recv(4096):
                self.request.sendall(data)
        except OSError:
            pass


if __name__ == '__main__':
    root = remote('mktemp -d /tmp/xray-hot-test.XXXXXX').stdout.strip()
    assert re.fullmatch(r'/tmp/xray-hot-test\.[a-zA-Z0-9]+', root)
    stream = None
    pid = None
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as route:
        route.connect(('10.0.0.1', 22))
        local_ip = route.getsockname()[0]
    server = socketserver.ThreadingTCPServer((local_ip, 0), Echo)
    port = server.server_address[1]
    server.daemon_threads = True
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        remote(f'mkdir -p {root}/etc/xray/profiles {root}/var/lock {root}/tmp {root}/assets')
        config = {
            'log': {'loglevel': 'warning'},
            'api': {'tag': 'route-api', 'listen': '127.0.0.1:10086', 'services': ['RoutingService']},
            'dns': {'hosts': {DOMAIN: local_ip}},
            'inbounds': [{'listen': '127.0.0.1', 'port': 10828, 'protocol': 'socks',
                          'tag': 'test-in', 'settings': {'auth': 'noauth'}}],
            'outbounds': [{'tag': 'direct', 'protocol': 'freedom', 'settings': {'domainStrategy': 'UseIP'}},
                          {'tag': 'proxy', 'protocol': 'blackhole'}],
            'routing': {'domainStrategy': 'AsIs', 'rules': [
                {'type': 'field', 'domain': ['domain:already-blocked.example'], 'outboundTag': 'proxy'},
                {'type': 'field', 'inboundTag': ['test-in'], 'outboundTag': 'direct'}]}}
        files = [f'{root}/etc/xray/{name}' for name in (
            'config.json', 'profiles/main-test.json', 'profiles/backup-spacevpn-nl.json',
            'profiles/backup-spacevpn-de.json')]
        for file in files:
            put(file, json.dumps(config))
        put(f'{root}/etc/xray/active-profile', 'main-test\n')
        source = (HERE / 'xray-route-domain').read_text()
        source = re.sub(r'/(?:etc/xray|var/lock|tmp)/', lambda m: root + m[0], source)
        source = source.replace('127.0.0.1:10085', '127.0.0.1:10086')
        source = source.replace('TAG="xray-route-learner"', 'TAG="xray-hot-test"')
        put(root + '/helper', source)
        remote(f'xray run -test -c {files[0]} >/dev/null')
        pid = remote(f'xray run -c {files[0]} >{root}/xray.log 2>&1 </dev/null & echo $!').stdout.strip()
        assert pid.isdigit()
        for _ in range(30):
            try:
                stream = socks(port)
                echo(stream)
                break
            except OSError:
                time.sleep(.1)
        assert stream is not None
        start = remote(f'cat /proc/{pid}/stat').stdout
        call = f'XRAY_LOCATION_ASSET={root}/assets sh {root}/helper'
        remote(f'{call} add {DOMAIN} auto')
        for i in range(30):
            echo(stream, f'after-add-{i}'.encode())
        blocked = False
        try:
            with socks(port) as fresh:
                echo(fresh)
        except (OSError, AssertionError):
            blocked = True
        assert blocked, 'new connection did not follow changed route'
        for file in files:
            saved = json.loads(remote('cat ' + file).stdout)
            assert 'domain:' + DOMAIN in saved['routing']['rules'][0]['domain']
        before = remote('sha256sum ' + ' '.join(files)).stdout
        remote(f'{call} add {DOMAIN} auto')
        assert remote('sha256sum ' + ' '.join(files)).stdout == before
        assert remote(f'{call} add bad.local', ok=False).returncode == 2
        remote(f'{call} remove {DOMAIN}')
        with socks(port) as fresh:
            echo(fresh)
        echo(stream)
        print('PASS actual helper add/remove/no-op: new routes change, 30 old-stream exchanges survive')

        for active in ('backup-spacevpn-nl', 'backup-spacevpn-de'):
            put(f'{root}/etc/xray/active-profile', active + '\n')
            remote(f'{call} add {DOMAIN} auto')
            for file in files:
                saved = json.loads(remote('cat ' + file).stdout)
                assert 'domain:' + DOMAIN in saved['routing']['rules'][0]['domain']
            remote(f'{call} remove {DOMAIN}')
            echo(stream)
        put(f'{root}/etc/xray/active-profile', 'main-test\n')
        print('PASS route synchronization with either backup active')

        check_refilter(root, files, call, source, stream, port)

        # Unavailable API: restore all saved files, never restart Xray or learn a rule.
        before = remote('sha256sum ' + ' '.join(files)).stdout
        put(root + '/no-api-helper', source.replace('127.0.0.1:10086', '127.0.0.1:10089'))
        failed = remote(f'XRAY_LOCATION_ASSET={root}/assets sh {root}/no-api-helper add {DOMAIN} auto', ok=False)
        assert failed.returncode != 0
        assert remote('sha256sum ' + ' '.join(files)).stdout == before
        assert remote(f'cat {root}/etc/xray/auto-proxy-domains').stdout == ''
        echo(stream)
        with socks(port) as fresh:
            echo(fresh)
        # Preserve custom live edits; reject before changing either saved profile.
        put(files[0], json.dumps(config, indent=2))
        before = remote('sha256sum ' + ' '.join(files)).stdout
        assert remote(f'{call} add {DOMAIN} auto', ok=False).returncode != 0
        assert remote('sha256sum ' + ' '.join(files)).stdout == before
        assert remote(f'cat /proc/{pid}/stat').stdout.split()[21] == start.split()[21]
        echo(stream)
        print('PASS API failure rollback, custom-config guard, unchanged Xray PID/start time')
    finally:
        if stream is not None:
            stream.close()
        if pid is not None and pid.isdigit():
            remote(f'kill {pid}', ok=False)
        remote('rm -rf ' + shlex.quote(root))
        server.shutdown()
        server.server_close()
    print('ALL HOT-ROUTE CHECKS PASSED; isolated process and echo server removed')
