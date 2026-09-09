#!/usr/bin/env python3
"""Check Git candidates, encrypted snapshot parts and bundled firmware; never reads private/."""
import hashlib
import json
from pathlib import Path
import re
import subprocess

ROOT = Path(__file__).resolve().parents[1]


def digest(path):
    with path.open('rb') as f:
        return hashlib.file_digest(f, 'sha256').hexdigest()


def check():
    names = subprocess.check_output(['git', 'ls-files', '--cached', '--others', '--exclude-standard', '-z'], cwd=ROOT).decode().split('\0')
    bad = []
    key_marker = b'-----BEGIN ' + b'(?:OPENSSH |RSA |EC |DSA )?PRIVATE KEY-----'
    connection = rb'(?:vless|vmess|trojan)://' + rb'[^\s"\x27<>]{12,}'
    for name in filter(None, names):
        path = ROOT / name
        if 'private' in Path(name).parts or path.is_symlink():
            bad.append(name); continue
        if path.stat().st_size >= 100 * 1024 * 1024:
            bad.append(name); continue
        if '.gpg.part' in name or path.suffix == '.bin':
            continue
        data = path.read_bytes()
        if re.search(key_marker, data) or re.search(connection, data):
            bad.append(name)
    if bad:
        # Only paths, never matching values.
        raise ValueError('Unsafe Git candidates: ' + ', '.join(bad))
    for manifest in (ROOT / 'snapshots').glob('*/manifest.json'):
        value = json.loads(manifest.read_text())
        combined = hashlib.sha256()
        for index, part in enumerate(value['parts']):
            if part['file'] != f'payload.gpg.part{index:04}':
                raise ValueError('Invalid ciphertext part order')
            path = manifest.parent / part['file']
            if path.stat().st_size != part['bytes'] or digest(path) != part['sha256']:
                raise ValueError('Damaged snapshot: ' + manifest.parent.name)
            with path.open('rb') as stream:
                for chunk in iter(lambda: stream.read(1024 * 1024), b''):
                    combined.update(chunk)
        if combined.hexdigest() != value['encrypted_sha256']:
            raise ValueError('Combined snapshot hash mismatch')
    subprocess.run(['sha256sum', '-c', 'SHA256SUMS'], cwd=ROOT / 'firmware', check=True, stdout=subprocess.DEVNULL)
    print('PASS repository: no plaintext key/connection strings, no private Git candidates; snapshot and firmware hashes verified')


if __name__ == '__main__':
    try:
        check()
    except ValueError as error:
        raise SystemExit(str(error))
