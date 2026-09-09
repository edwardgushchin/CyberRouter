#!/usr/bin/env python3
"""Run the real profile CLI/watchdog in a temporary fake router, without outages."""
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile

HERE = Path(__file__).resolve().parent
MAIN, NL, DE = 'main-test', 'backup-spacevpn-nl', 'backup-spacevpn-de'


def executable(path, text):
    path.write_text(text)
    path.chmod(0o755)


def check():
    with tempfile.TemporaryDirectory(prefix='xray-profiles-test-') as directory:
        root = Path(directory)
        for name in ('usr/bin', 'usr/libexec', 'etc/init.d', 'etc/xray/profiles',
                     'var/lock', 'tmp', 'bin'):
            (root / name).mkdir(parents=True)
        for name in (MAIN, NL, DE):
            (root / f'etc/xray/profiles/{name}.json').write_text(json.dumps({'profile': name}))
        for name in ('xray-profile', 'xray-profile-watchdog'):
            source = (HERE / name).read_text()
            source = re.sub(r'/(?:usr/bin|usr/libexec|etc/xray|etc/init.d|var/lock|tmp)/',
                            lambda m: str(root) + m[0], source)
            if name.endswith('watchdog'):
                source = source.replace('sleep "$START_GRACE"', ':')
                source = source.replace('while true; do',
                    'while [ "$(cat "$TEST_ROOT/tick")" -lt "$MAX_TICKS" ]; do')
            executable(root / 'usr/bin' / name, source)
        executable(root / 'bin/uci', '#!/bin/sh\nexit 1\n')
        executable(root / 'bin/logger', '#!/bin/sh\nexit 0\n')
        executable(root / 'bin/xray', '#!/bin/sh\nexit 0\n')
        executable(root / 'bin/sleep',
            '#!/bin/sh\necho $(($(cat "$TEST_ROOT/tick") + 1)) >"$TEST_ROOT/tick"\n')
        executable(root / 'bin/date', '#!/bin/sh\necho $(($(cat "$TEST_ROOT/tick") * 30))\n')
        for service in ('xray', 'xray-split', 'https-dns-proxy',
                        'xray-profile-watchdog', 'xray-route-learner'):
            executable(root / 'etc/init.d' / service, '''#!/bin/sh
if [ "$(basename "$0")" = xray ] && [ -f "$TEST_ROOT/restart-fails" ]; then
 case "$1" in restart|status) exit 1 ;; esac
fi
if [ "$1" = restart ] && [ "$(basename "$0")" = xray ]; then
 cat "$TEST_ROOT/etc/xray/active-profile" >>"$TEST_ROOT/switches"
fi
exit 0
''')
        probe = '''#!/usr/bin/env python3
import json, os, pathlib, sys
r = pathlib.Path(os.environ['TEST_ROOT'])
tick = int((r/'tick').read_text())
name = ((r/'etc/xray/active-profile').read_text().strip() if pathlib.Path(sys.argv[0]).name == 'curl'
        else pathlib.Path(sys.argv[1]).stem)
states = json.loads((r/'availability').read_text()).get(name, [False])
with (r/'probes').open('a') as f: f.write(name+'\\n')
sys.exit(0 if states[min(tick, len(states)-1)] else 1)
'''
        executable(root / 'bin/curl', probe)
        executable(root / 'usr/libexec/xray-profile-probe', probe)
        env = dict(os.environ, PATH=str(root / 'bin') + ':' + os.environ['PATH'],
                   TEST_ROOT=str(root), MAX_TICKS='7')
        active = root / 'etc/xray/active-profile'
        live = root / 'etc/xray/config.json'

        def reset(name=MAIN):
            active.write_text(name + '\n')
            live.write_bytes((root / f'etc/xray/profiles/{name}.json').read_bytes())
            for file, value in (('tick', '0'), ('switches', ''), ('probes', '')):
                (root / file).write_text(value)

        def run(name, *args):
            return subprocess.run([str(root / 'usr/bin' / name), *args],
                                  env=env, text=True, capture_output=True, timeout=15)

        reset()
        assert run('xray-profile', 'list').stdout.splitlines() == [MAIN, NL, DE]
        for alias, expected in (('backup', NL), ('backup2', DE), ('nl', NL), ('de', DE), ('main', MAIN)):
            result = run('xray-profile', alias)
            assert result.returncode == 0, result.stderr
            assert active.read_text().strip() == expected
            assert live.read_bytes() == (root / f'etc/xray/profiles/{expected}.json').read_bytes()
            assert f'Detected live profile:   {expected}' in run('xray-profile', 'status').stdout
        before = live.read_bytes()
        (root / 'restart-fails').touch()
        assert run('xray-profile', 'backup2').returncode != 0
        assert live.read_bytes() == before and active.read_text().strip() == MAIN
        (root / 'restart-fails').unlink()
        assert run('xray-profile', '../invalid').returncode != 0
        print('PASS CLI: both backup aliases, readback, failed-restart rollback, invalid profile')

        cases = [
            ('main-to-nl', MAIN, {MAIN: [False], NL: [True], DE: [True]}, [NL]),
            ('main-to-de', MAIN, {MAIN: [False], NL: [False], DE: [True]}, [DE]),
            ('nl-to-de', NL, {MAIN: [False], NL: [False], DE: [True]}, [DE]),
            ('de-to-nl', DE, {MAIN: [False], NL: [True], DE: [False]}, [NL]),
            ('recover-main', DE, {MAIN: [True], DE: [True]}, [MAIN]),
            ('all-down', MAIN, {}, []),
            ('transient-main', MAIN, {MAIN: [False, False, True], NL: [True]}, []),
            ('recovery-streak-reset', NL, {MAIN: [True, False, True, True, True], NL: [True]}, [MAIN]),
        ]
        for label, initial, states, expected in cases:
            reset(initial)
            (root / 'availability').write_text(json.dumps(states))
            result = run('xray-profile-watchdog')
            assert result.returncode == 0, (label, result.stderr)
            assert (root / 'switches').read_text().splitlines() == expected, label
            if label == 'main-to-de':
                probes = (root / 'probes').read_text().splitlines()
                assert probes[:5] == [MAIN, MAIN, MAIN, NL, DE], probes
            print('PASS watchdog:', label)
        reset()
        active.write_text('custom-profile\n')
        (root / 'availability').write_text('{}')
        assert run('xray-profile-watchdog').returncode == 0
        assert (root / 'switches').read_text() == '' and (root / 'probes').read_text() == ''
        print('PASS watchdog: unknown profile remains untouched')


if __name__ == '__main__':
    check()
    print('ALL PROFILE CHECKS PASSED')
