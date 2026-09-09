#!/usr/bin/env python3
"""Rehearse the filesystem overlay without touching a router or following symlinks."""
import argparse
import hashlib
import json
from pathlib import Path
import tarfile
import cyberrouter as core

EXCLUDED = {'dev', 'proc', 'sys', 'tmp', 'run', 'overlay', 'rom', 'mnt'}


def tree(path):
    result = {}
    with tarfile.open(path) as archive:
        for member in archive:
            name = core.safe_name(member.name)
            if not name or name.split('/')[0] in EXCLUDED:
                continue
            if member.isfile():
                value = ('file', hashlib.file_digest(archive.extractfile(member), 'sha256').hexdigest())
            elif member.issym() or member.islnk():
                value = ('symlink' if member.issym() else 'hardlink', member.linkname)
            elif member.isdir():
                value = ('directory', '')
            else:
                raise ValueError('Unexpected persistent special file')
            if name in result:
                raise ValueError('Duplicate archive path')
            result[name] = (*value, member.mode, member.uid, member.gid)
    return result


def verify(capture, prepared):
    capture, prepared = Path(capture), Path(prepared)
    core.run(['sha256sum', '-c', 'SHA256SUMS'], cwd=prepared, timeout=30)
    expected = tree(capture / 'rootfs.tar.gz')
    reconstructed = tree(capture / 'rom.tar.gz')
    deleted = (prepared / 'deleted.txt').read_text(errors='surrogateescape').split('\n')
    for name in filter(None, deleted):
        core.safe_name(name)
        reconstructed = {n: v for n, v in reconstructed.items() if n != name and not n.startswith(name + '/')}
    reconstructed.update(tree(prepared / 'restore.tar.gz'))
    differences = [name for name in expected.keys() | reconstructed.keys() if expected.get(name) != reconstructed.get(name)]
    if differences:
        core.write_json(prepared / 'verification-differences.json', differences)
        raise ValueError(f'Reconstruction differs in {len(differences)} entries; details kept private')
    report = {'filesystem_reconstruction': 'passed', 'entries': len(expected),
              'files': sum(v[0] == 'file' for v in expected.values()),
              'links': sum(v[0] in ('symlink', 'hardlink') for v in expected.values()),
              'checked': ['file bytes (SHA-256)', 'path set', 'symlink targets', 'mode', 'uid', 'gid', 'base deletions'],
              'physical_factory_restore': 'not performed'}
    core.write_json(prepared / 'verification.json', report)
    return report


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('capture')
    parser.add_argument('prepared')
    args = parser.parse_args()
    try:
        print(json.dumps(verify(args.capture, args.prepared), indent=2))
    except (ValueError, RuntimeError) as error:
        raise SystemExit(str(error))
