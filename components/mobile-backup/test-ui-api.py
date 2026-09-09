#!/usr/bin/env python3
"""Read/negative smoke checks against the installed router API; no credentials."""
from pathlib import Path
import json
import shlex
import subprocess
import urllib.request

ssh = ['ssh', '-F', str(Path.home() / '.ssh/config'), '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', 'flint2']
for value in [
    {'operation': 'policy', 'value': 'auto; touch /tmp/mobile-ui-injected'},
    {'operation': 'priority', 'value': '../../etc/passwd'},
    {'operation': 'unknown', 'value': ''},
    {'operation': 'source', 'value': 'wan;touch /tmp/mobile-ui-injected'},
]:
    result = json.loads(subprocess.check_output(ssh + ['ubus call luci.mobile-backup action ' + shlex.quote(json.dumps(value))]))
    assert result['ok'] is False
for value in [
    {'operation':'join','radio':'radio0','ssid':'test','encryption':'psk2','password':'short'},
    {'operation':'join','radio':'radio0;touch /tmp/mobile-ui-injected','ssid':'test','encryption':'none','password':''},
    {'operation':'saved','radio':'radio0','ssid':'not-a-saved-network','encryption':'psk2','password':''},
    {'operation':'join','radio':'radio0','ssid':'bad\nname','encryption':'none','password':''},
]:
    result = json.loads(subprocess.check_output(ssh + ['ubus call luci.mobile-backup wifi ' + shlex.quote(json.dumps(value))]))
    assert result['ok'] is False
subprocess.run(ssh + ['test ! -e /tmp/mobile-ui-injected && test ! -e /var/run/mobile-backup/wifi-pending'], check=True)
request = urllib.request.Request('http://10.0.0.1/ubus', data=json.dumps({
    'jsonrpc': '2.0', 'id': 1, 'method': 'call',
    'params': ['0' * 32, 'luci.mobile-backup', 'action', {'operation': 'policy', 'value': 'direct'}],
}).encode(), headers={'Content-Type': 'application/json'})
with urllib.request.urlopen(request, timeout=10) as response:
    result = json.load(response)
assert result.get('result', [None])[0] == 6 or result.get('error')
status = json.loads(subprocess.check_output(ssh + ["ubus call luci.mobile-backup status '{}' "]))
assert {p['id'] for p in status['providers']} == {'telemost', 'wbstream', 'vk'}
assert len(status['probes']) == 5
assert status['source'] in ('wan','wwan')
assert any(p['ssid']=='CyberNetwork S25' for p in status['wifi']['saved'])
assert not any(key in json.dumps(status).lower() for key in ['access_token', 'joinlink', 'cookies', 'password'])
print('UI API: 8 invalid commands rejected; anonymous control denied; status schema checked')
