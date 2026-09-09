#!/usr/bin/env python3
"""Run saved Xray configuration checks in an isolated filesystem on matching ARM hardware."""
import argparse
import json
from pathlib import Path
import re
import subprocess
import tarfile
import cyberrouter as c


def check(capture, prepared, target):
    capture, prepared = Path(capture), Path(prepared)
    saved = json.loads((capture / 'board.json').read_text())
    current = json.loads(c.run(c.ssh(target) + ['ubus call system board'], timeout=30))
    if (saved['board_name'], saved['kernel']) != (current['board_name'], current['kernel']):
        raise ValueError('Native verification requires matching hardware and kernel')
    members = c.archive_index(capture / 'rootfs.tar.gz')
    size = sum(m.size for m in members.values()) // 1024 + 131072
    for name, member in members.items():
        if not (member.isfile() or member.isdir() or member.issym() or member.islnk()):
            raise ValueError('Special files are not allowed during validation')
        if member.islnk():
            c.safe_name(member.linkname)
        if any(str(p) in members and not members[str(p)].isdir() for p in Path(name).parents):
            raise ValueError('Archive contains a child below a non-directory')
    available = int(c.run(c.ssh(target) + ["df -k /tmp | awk 'END {print $4}'"], timeout=30))
    if available < size:
        raise ValueError('Insufficient router RAM for a temporary filesystem check')
    before = c.run(c.ssh(target) + ['pidof xray'], timeout=30).strip()
    stage = c.run(c.ssh(target) + ['umask 077; mktemp -d /tmp/cyberrouter-check.XXXXXX'], timeout=30).decode().strip()
    if not re.fullmatch(r'/tmp/cyberrouter-check\.[A-Za-z0-9]+', stage):
        raise ValueError('Unexpected temporary path')
    try:
        with (capture / 'rom.tar.gz').open('rb') as source:
            c.run(c.ssh(target) + [f'mkdir {stage}/root; tar -xzf - -C {stage}/root'], stdin=source, timeout=300)
        # Delete base entries inside chroot: absolute links cannot escape the temporary root.
        c.run(c.ssh(target) + [f'cat > {stage}/deleted.txt'], input=(prepared / 'deleted.txt').read_bytes(), timeout=30)
        c.run(c.ssh(target) + [f'''while IFS= read -r name; do chroot {stage}/root /bin/rm -rf "/$name"; done <{stage}/deleted.txt'''], timeout=30)
        with (prepared / 'restore.tar.gz').open('rb') as source:
            c.run(c.ssh(target) + [f'tar -xzf - -C {stage}/root'], stdin=source, timeout=300)
        c.run(c.ssh(target) + [f'cat > {stage}/root/files.sha256'], input=(prepared / 'files.sha256').read_bytes(), timeout=30)
        command = f'''set -eu
root={stage}/root
mkdir -p "$root/tmp" "$root/dev" "$root/proc" "$root/sys"
chmod 1777 "$root/tmp"
# /tmp is nodev: validation only needs a writable redirection sink.
rm -f "$root/dev/null"
: > "$root/dev/null"
chmod 666 "$root/dev/null"
chroot "$root" /bin/sh -c '
set -eu
cd /
sha256sum -c /files.sha256 >/tmp/files-check.log 2>&1
export XRAY_LOCATION_ASSET=/usr/share/xray
for config in /etc/xray/profiles/*.json /etc/xray/config.json; do
 /usr/bin/xray run -test -c "$config" >>/tmp/xray-check.log 2>&1
done
uci -c /etc/config export >/dev/null
for script in /usr/bin/xray-* /etc/init.d/mobile-*; do
 [ -f "$script" ] && /bin/sh -n "$script"
done
'
'''
        c.run(c.ssh(target) + ['sh -s'], input=command.encode(), timeout=120)
        after = c.run(c.ssh(target) + ['pidof xray'], timeout=30).strip()
        if before != after:
            raise ValueError('Live Xray process set changed during verification; inspect router')
        return {'native_overlay_extraction_and_hashes': 'passed', 'native_xray_config_validation': 'passed', 'native_uci_parse': 'passed',
                'native_shell_syntax': 'passed', 'live_xray_pids_unchanged': True,
                'services_started_in_chroot': False}
    finally:
        c.run(c.ssh(target) + ['rm -rf ' + stage], timeout=60)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('capture')
    parser.add_argument('prepared')
    parser.add_argument('--target', default='flint2')
    parser.add_argument('--report')
    args = parser.parse_args()
    try:
        report = check(args.capture, args.prepared, args.target)
        if args.report:
            c.write_json(args.report, report)
        print(json.dumps(report, indent=2))
    except (ValueError, RuntimeError) as error:
        raise SystemExit(str(error))
