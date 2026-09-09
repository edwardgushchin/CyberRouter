#!/usr/bin/env python3
"""Offline checks with synthetic settings and keys. Never connects to a router."""
import importlib.util
import io
import json
import os
from pathlib import Path
import sys
import tarfile
import tempfile
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'tools'))
import cyberrouter as c
spec = importlib.util.spec_from_file_location('verification', c.ROOT / 'tools/verify-recovery.py')
v = importlib.util.module_from_spec(spec); spec.loader.exec_module(v)


def rejected(fn):
    try:
        fn()
    except (ValueError, RuntimeError):
        return
    raise AssertionError('unsafe input accepted')


def archive(path, files):
    with tarfile.open(path, 'w:gz') as t:
        for name, value in files.items():
            m = tarfile.TarInfo(name)
            if value is None:
                m.type = tarfile.DIRTYPE; m.mode = 0o755
                t.addfile(m)
            elif isinstance(value, tuple):
                m.type = tarfile.SYMTYPE; m.linkname = value[0]; m.mode = 0o777
                t.addfile(m)
            else:
                m.mode = 0o600; m.size = len(value)
                t.addfile(m, io.BytesIO(value))


def check():
    os.umask(0o077)
    for name in ('../etc/passwd', '/etc/passwd', 'a/../../b', 'a\nb'):
        rejected(lambda: c.safe_name(name))
    assert c.safe_name('./etc/a\r') == 'etc/a\r'
    for target in ('-oProxyCommand=sh', 'root@host;id', 'root host'):
        rejected(lambda: c.ssh(target))
    with tempfile.TemporaryDirectory() as temp:
        root = Path(temp); c.PRIVATE = c.private_directory(root / 'private')
        (c.PRIVATE / 'recovery.key').write_text('synthetic-test-key-only\n')
        (c.PRIVATE / 'recovery.key').chmod(0o600)
        source = root / 'capture'; source.mkdir()
        required = ('etc/config/network', 'etc/config/wireless', 'etc/xray/config.json',
                    'usr/bin/xray', 'etc/init.d/mobile-backup', 'usr/local/bin/router-joiner')
        base = {'etc': None, 'etc/base': b'base', 'etc/deleted': b'remove',
                'dev': None, 'dev/ignored': b'transient'}
        live = {'etc': None, 'etc/base': b'base', **{n: b'test' for n in required},
                'etc/link': ('/tmp/test',), 'etc/odd\r\udc88': b'keep filename bytes'}
        overlay = {n: value for n, value in live.items() if n != 'etc/base'}
        archive(source / 'rom.tar.gz', base)
        archive(source / 'rootfs.tar.gz', live)
        archive(source / 'upper.tar.gz', overlay)
        board = {'board_name': 'test,board', 'model': 'Test', 'kernel': 'test-kernel',
                 'release': {'version': 'test', 'revision': 'test-revision', 'target': 'test/test'}}
        c.write_json(source / 'board.json', board)
        (source / 'packages.txt').write_text('fake-1.0\n')
        prepared = root / 'prepared'; c.prepare(source, prepared)
        assert (prepared / 'deleted.txt').read_text() == 'etc/deleted\n'
        assert v.verify(source, prepared)['files'] == 8
        c.seal(source, root / 'encrypted')
        opened = c.open_snapshot(root / 'encrypted', root / 'opened')
        assert c.sha(opened / 'rootfs.tar.gz') == c.sha(source / 'rootfs.tar.gz')
        part = root / 'encrypted/payload.gpg.part0000'
        original = part.read_bytes(); part.write_bytes(original[:-1] + bytes([original[-1] ^ 1]))
        rejected(lambda: c.open_snapshot(root / 'encrypted', root / 'tampered'))
        part.write_bytes(original)
        (c.PRIVATE / 'recovery.key').write_text('wrong-key\n')
        rejected(lambda: c.open_snapshot(root / 'encrypted', root / 'wrong-key'))
        args = SimpleNamespace(prepared=prepared, target='replacement', apply=False)
        with patch.object(c, 'run', return_value=json.dumps(board).encode()) as run:
            c.deploy(args); assert run.call_count == 1
        wrong = dict(board, board_name='other,board')
        with patch.object(c, 'run', return_value=json.dumps(wrong).encode()) as run:
            rejected(lambda: c.deploy(args)); assert run.call_count == 1
        args.apply = True
        with patch.object(c, 'run', side_effect=[json.dumps(board).encode(), RuntimeError('configured')]) as run:
            rejected(lambda: c.deploy(args)); assert run.call_count == 2
        # Authentication and archive validation precede any target mutation.
        (prepared / 'restore.tar.gz').write_bytes(b'broken')
        rejected(lambda: v.verify(source, prepared))
        print('PASS recovery: reconstruction, modes/links, unusual names, encryption roundtrip, tampering, wrong key, hardware and live-router guards')


if __name__ == '__main__':
    check()
