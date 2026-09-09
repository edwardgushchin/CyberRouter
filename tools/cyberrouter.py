#!/usr/bin/env python3
"""Encrypted OpenWrt capture, verified recovery preparation and explicit deployment."""
import argparse
import datetime as dt
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import secrets
import shlex
import shutil
import subprocess
import tarfile
import tempfile

ROOT = Path(__file__).resolve().parents[1]
PRIVATE = ROOT / 'private'
CHUNK = 48 * 1024 * 1024
SSH_CONFIG = Path.home() / '.ssh/config'


def sha(path):
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def write_json(path, value):
    Path(path).write_text(json.dumps(value, ensure_ascii=True, indent=2) + '\n')


def private_directory(path):
    path = Path(path)
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    path.chmod(0o700)
    return path


def ssh(target):
    if not re.fullmatch(r'[A-Za-z0-9_][A-Za-z0-9_.@:-]*', target):
        raise ValueError('Invalid SSH target')
    return ['ssh', '-F', str(SSH_CONFIG), '-o', 'BatchMode=yes',
            '-o', 'ConnectTimeout=15', target]


def run(command, **kwargs):
    result = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, **kwargs)
    if result.returncode:
        # Вывод внешней команды может содержать настройки: сохраняем только в private.
        private_directory(PRIVATE)
        (PRIVATE / 'last-error.log').write_bytes(result.stderr)
        raise RuntimeError('Command failed; protected diagnostic: private/last-error.log')
    return result.stdout


def recovery_key(create=False):
    private_directory(PRIVATE)
    path = PRIVATE / 'recovery.key'
    if not path.exists() and create:
        spare = private_directory(Path.home() / '.local/share/codex/keys/CyberRouter') / 'recovery.key'
        if spare.exists():
            raise ValueError('Restore the existing separate recovery key into private/recovery.key first')
        with path.open('x') as stream:
            stream.write(secrets.token_urlsafe(48) + '\n')
        path.chmod(0o600)
        shutil.copyfile(path, spare)
        spare.chmod(0o600)
    if not path.is_file() or path.is_symlink() or path.stat().st_mode & 0o077:
        raise ValueError('A private/recovery.key file with permissions 0600 is required')
    return path


def gpg(source, destination, decrypt=False):
    home = private_directory(PRIVATE / 'gnupg')
    command = ['gpg', '--homedir', str(home), '--batch', '--yes', '--no-symkey-cache',
               '--pinentry-mode', 'loopback', '--passphrase-file', str(recovery_key()),
               '--output', str(destination)]
    command += ['--decrypt'] if decrypt else ['--symmetric', '--cipher-algo', 'AES256', '--compress-algo', 'none']
    run(command + [str(source)])
    Path(destination).chmod(0o600)


def safe_name(name):
    name = name.removeprefix('./').rstrip('/')
    if name in ('', '.'):
        return ''
    p = PurePosixPath(name)
    if p.is_absolute() or '..' in p.parts or any(c in name for c in '\n\0'):
        raise ValueError('Unsafe archive path')
    return str(p)


def unpack_bundle(bundle, destination):
    private_directory(destination)
    with tarfile.open(bundle) as archive:
        for member in archive:
            name = safe_name(member.name)
            if not name:
                continue
            if '/' in name or not member.isfile():
                raise ValueError('Recovery bundle must contain flat regular files')
            member.name = name
            archive.extract(member, destination, filter='data')
    for required in ('rootfs.tar.gz', 'upper.tar.gz', 'rom.tar.gz', 'board.json'):
        if not (Path(destination) / required).is_file():
            raise ValueError('Incomplete recovery bundle')


def seal(source, destination):
    recovery_key(create=True)
    destination = Path(destination)
    destination.mkdir(parents=True, exist_ok=False)
    with tempfile.TemporaryDirectory(dir=PRIVATE) as temporary:
        bundle = Path(temporary) / 'bundle.tar'
        with tarfile.open(bundle, 'w') as archive:
            for path in sorted(Path(source).iterdir()):
                if path.is_file() and not path.is_symlink():
                    archive.add(path, arcname=path.name)
        encrypted = Path(temporary) / 'payload.gpg'
        gpg(bundle, encrypted)
        parts = []
        with encrypted.open('rb') as stream:
            for index in range(10000):
                data = stream.read(CHUNK)
                if not data:
                    break
                path = destination / f'payload.gpg.part{index:04}'
                path.write_bytes(data)
                parts.append({'file': path.name, 'bytes': len(data), 'sha256': sha(path)})
        board = json.loads((Path(source) / 'board.json').read_text())
        manifest = {'format': 1, 'created_at': dt.datetime.now(dt.timezone.utc).isoformat(),
                    'board': board['board_name'], 'model': board['model'],
                    'release': board['release']['version'], 'revision': board['release']['revision'],
                    'kernel': board['kernel'], 'target': board['release']['target'],
                    'encrypted_sha256': sha(encrypted), 'parts': parts,
                    'package_count': len((Path(source) / 'packages.txt').read_text().splitlines()),
                    'includes_local_history': (Path(source) / 'history.tar.gz').exists()}
        write_json(destination / 'manifest.json', manifest)
    print(f'Encrypted snapshot: {destination.name}; {len(parts)} parts')


def open_snapshot(snapshot, destination):
    snapshot, destination = Path(snapshot), Path(destination)
    if destination.exists() and any(destination.iterdir()):
        raise ValueError('Decryption directory must be empty')
    private_directory(destination)
    manifest = json.loads((snapshot / 'manifest.json').read_text())
    if manifest.get('format') != 1 or not manifest.get('parts'):
        raise ValueError('Unsupported or empty snapshot')
    encrypted = destination / 'payload.gpg'
    with encrypted.open('wb') as output:
        for index, part in enumerate(manifest['parts']):
            if part['file'] != f'payload.gpg.part{index:04}':
                raise ValueError('Invalid encrypted part sequence')
            path = snapshot / part['file']
            if path.stat().st_size != part['bytes'] or sha(path) != part['sha256']:
                raise ValueError('Encrypted snapshot integrity check failed')
            with path.open('rb') as stream:
                shutil.copyfileobj(stream, output)
    if sha(encrypted) != manifest['encrypted_sha256']:
        raise ValueError('Combined encrypted snapshot hash mismatch')
    bundle = destination / 'bundle.tar'
    gpg(encrypted, bundle, decrypt=True)
    unpack_bundle(bundle, destination / 'capture')
    encrypted.unlink()
    bundle.unlink()
    return destination / 'capture'


def archive_index(path):
    with tarfile.open(path) as archive:
        return {safe_name(m.name): m for m in archive if safe_name(m.name)}


def prepare(capture, destination):
    capture, destination = Path(capture), Path(destination)
    if destination.exists() and any(destination.iterdir()):
        raise ValueError('Preparation directory must be empty')
    private_directory(destination)
    root = archive_index(capture / 'rootfs.tar.gz')
    upper = archive_index(capture / 'upper.tar.gz')
    rom = archive_index(capture / 'rom.tar.gz')
    for required in ('etc/config/network', 'etc/config/wireless', 'etc/xray/config.json',
                     'usr/bin/xray', 'etc/init.d/mobile-backup', 'usr/local/bin/router-joiner'):
        if required not in root:
            raise ValueError('A required router component is missing from rootfs')
    selected = set(upper) & set(root)
    excluded = {'dev', 'proc', 'sys', 'tmp', 'run', 'overlay', 'rom', 'mnt'}
    removed = sorted({name for name in set(rom) - set(root) if name.split('/')[0] not in excluded}, key=lambda n: (n.count('/'), n), reverse=True)
    hashes, links = {}, {}
    with tarfile.open(capture / 'rootfs.tar.gz') as source, tarfile.open(destination / 'restore.tar.gz', 'w:gz') as output:
        for member in source:
            name = safe_name(member.name)
            if not name:
                continue
            if member.isfile():
                stream = source.extractfile(member)
                hashes[name] = hashlib.file_digest(stream, 'sha256').hexdigest()
            elif member.issym() or member.islnk():
                if '\n' in member.linkname or '\0' in member.linkname:
                    raise ValueError('Unsafe archive link')
                links[name] = member.linkname
            elif not member.isdir():
                raise ValueError('Unexpected special file in merged rootfs')
            if name in selected:
                member.name = name
                output.addfile(member, source.extractfile(member) if member.isfile() else None)
    (destination / 'deleted.txt').write_text(''.join(name + '\n' for name in removed), errors='surrogateescape')
    (destination / 'files.sha256').write_text(''.join(f'{value}  {name}\n' for name, value in sorted(hashes.items()) if name in selected), errors='surrogateescape')
    board = json.loads((capture / 'board.json').read_text())
    variables = {'EXPECTED_BOARD': board['board_name'], 'EXPECTED_VERSION': board['release']['version'],
                 'EXPECTED_REVISION': board['release']['revision'], 'EXPECTED_KERNEL': board['kernel']}
    (destination / 'board.env').write_text(''.join(f'{key}={shlex.quote(value)}\n' for key, value in variables.items()))
    shutil.copyfile(ROOT / 'tools/restore-router.sh', destination / 'restore-router.sh')
    write_json(destination / 'full-root-manifest.json', {'files': hashes, 'links': links})
    write_json(destination / 'plan.json', {'board': variables, 'overlay_entries': len(selected),
                                         'deleted_base_entries': len(removed), 'root_regular_files': len(hashes),
                                         'root_links': len(links), 'restore_archive_bytes': (destination / 'restore.tar.gz').stat().st_size})
    checked = ['restore.tar.gz', 'deleted.txt', 'files.sha256', 'board.env', 'restore-router.sh']
    (destination / 'SHA256SUMS').write_text(''.join(f'{sha(destination / n)}  {n}\n' for n in checked))
    print(f'Recovery prepared: {len(selected)} overlay entries, {len(removed)} deletions')


def capture_router(args):
    private_directory(PRIVATE)
    recovery_key(create=True)
    source = private_directory(PRIVATE / ('capture-' + dt.datetime.now().strftime('%Y%m%d-%H%M%S')))
    stage = run(ssh(args.target) + ['sh -s'], input=(ROOT / 'tools/capture-router.sh').read_bytes(), timeout=300).decode().strip()
    if not re.fullmatch(r'/tmp/cyberrouter-capture\.[A-Za-z0-9]+', stage):
        raise ValueError('Unexpected remote staging path')
    try:
        archive = source / 'download.tar'
        with archive.open('wb') as output, (source / 'download.log').open('wb') as error:
            result = subprocess.run(ssh(args.target) + [f'tar -cf - -C {stage} .'], stdout=output, stderr=error, timeout=300)
        if result.returncode:
            raise RuntimeError('Snapshot download failed')
        unpack_bundle(archive, source / 'capture')
        archive.unlink()
    finally:
        run(ssh(args.target) + ['rm -rf ' + stage], timeout=30)
    if args.history:
        with tarfile.open(source / 'capture/history.tar.gz', 'w:gz') as archive:
            archive.add(args.history, arcname='router-history')
    seal(source / 'capture', args.output)


def deploy(args):
    prepared = Path(args.prepared).resolve()
    plan = json.loads((prepared / 'plan.json').read_text())
    board = json.loads(run(ssh(args.target) + ['ubus call system board'], timeout=30))
    expected = plan['board']
    if (board['board_name'], board['release']['version'], board['release']['revision'], board['kernel']) != (
            expected['EXPECTED_BOARD'], expected['EXPECTED_VERSION'], expected['EXPECTED_REVISION'], expected['EXPECTED_KERNEL']):
        raise ValueError('Target hardware/firmware mismatch: use the migration guide, never force an exact restore')
    print(f'Target compatible: {board["model"]}, OpenWrt {board["release"]["version"]}')
    if not args.apply:
        print('Plan only. Deployment requires --apply; no router files changed.')
        return
    run(ssh(args.target) + ['test ! -e /etc/xray/config.json && test ! -e /etc/mobile-backup'], timeout=30)
    run(['sha256sum', '-c', 'SHA256SUMS'], cwd=prepared, timeout=30)
    stage = run(ssh(args.target) + ['umask 077; mktemp -d /tmp/cyberrouter-restore.XXXXXX'], timeout=30).decode().strip()
    if not re.fullmatch(r'/tmp/cyberrouter-restore\.[A-Za-z0-9]+', stage):
        raise ValueError('Unexpected target staging path')
    files = ['restore.tar.gz', 'deleted.txt', 'files.sha256', 'board.env', 'restore-router.sh', 'SHA256SUMS']
    with tempfile.TemporaryFile() as bundle:
        with tarfile.open(fileobj=bundle, mode='w') as archive:
            for name in files:
                archive.add(prepared / name, arcname=name)
        bundle.seek(0)
        result = subprocess.run(ssh(args.target) + [f'tar -xf - -C {stage}'], stdin=bundle, capture_output=True, timeout=300)
        if result.returncode:
            raise RuntimeError('Recovery upload failed; target configuration unchanged')
    output = run(ssh(args.target) + [f'cd {stage} && sh restore-router.sh --apply'], timeout=300)
    print(output.decode().strip())
    print('Files restored. Reboot the replacement router to activate network and services.')


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    capture = commands.add_parser('capture')
    capture.add_argument('--target', default='flint2')
    capture.add_argument('--output', required=True)
    capture.add_argument('--history')
    sealing = commands.add_parser('seal')
    sealing.add_argument('capture')
    sealing.add_argument('output')
    opening = commands.add_parser('open')
    opening.add_argument('snapshot')
    opening.add_argument('--output', required=True)
    preparing = commands.add_parser('prepare')
    preparing.add_argument('capture')
    preparing.add_argument('--output', required=True)
    deployment = commands.add_parser('deploy')
    deployment.add_argument('prepared')
    deployment.add_argument('--target', required=True)
    deployment.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    if args.command == 'capture':
        capture_router(args)
    elif args.command == 'seal':
        seal(args.capture, args.output)
    elif args.command == 'open':
        result = open_snapshot(args.snapshot, args.output)
        print('Snapshot authenticated and decrypted to protected capture directory:', result)
    elif args.command == 'prepare':
        prepare(args.capture, args.output)
    else:
        deploy(args)


if __name__ == '__main__':
    try:
        main()
    except (ValueError, RuntimeError) as error:
        raise SystemExit(str(error))
