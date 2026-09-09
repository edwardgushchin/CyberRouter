#!/usr/bin/env python3
"""Exercise the real Wi-Fi worker with isolated UCI/ubus state, no radio changes."""
from pathlib import Path
import shlex
import subprocess

ssh = ['ssh', '-F', str(Path.home() / '.ssh/config'), '-o', 'BatchMode=yes', 'flint2']
root = subprocess.check_output(ssh + ['mktemp -d /tmp/mobile-wifi-test.XXXXXX'], text=True).strip()
assert root.startswith('/tmp/mobile-wifi-test.')
source = (Path(__file__).parent / 'ui/wifi.uc').read_text()
source = source.replace("const BASE='/etc/mobile-backup', RUN='/var/run/mobile-backup';", f"const BASE='{root}', RUN='{root}';")
source = source[:source.index('\ntry {\n    let action=ARGV[0]')]
mock = '''
let original={'.name':'wifinet2',mode:'sta',network:'wwan',device:'radio0',ssid:'old network',encryption:'psk2',key:'old-test-password'};
let configuration=json(sprintf('%J',original)), reloads=0, shouldJoin=false, commands=[];
const uci={
    get:(cfg, section)=>index(['radio0','radio1'],section)>=0?'wifi-device':null,
    foreach:(cfg, kind, fn)=>{if(configuration)fn(configuration);},
    delete:(cfg,name)=>{configuration=null;},
    set:(cfg,name,key,value)=>{if(value==null)configuration={'.name':name};else configuration[key]=value;return true;},
    commit:()=>true
};
const bus={call:(object,method)=>{
    if(object=='network.interface.wwan' && method=='status')return {up:shouldJoin,l3_device:'wlan-test','ipv4-address':[{address:'192.0.2.2'}]};
    if(object=='iwinfo')return {ssid:'new network'};
    return {};
}};
function sleep(ms) {}
function system(command) { reloads++; push(commands,command); return 0; }
'''
source = source.replace('const uci=cursor(), bus=connect();', mock)
source += '''
let pending={radio:'radio0',ssid:'new network',encryption:'psk2',password:'new-test-password'};
save(BASE+'/source','wan\\n'); save(BASE+'/wifi-networks.json','[]');
save(RUN+'/wifi-pending',sprintf('%J',pending)); worker();
assert(job().state=='failed'); assert(trim(readfile(BASE+'/source'))=='wan');
assert(configuration.ssid==original.ssid && configuration.key==original.key && configuration.mode=='sta');
assert(length(profiles())==0 && !readfile(RUN+'/wifi-pending'));
shouldJoin=true;
save(RUN+'/wifi-pending',sprintf('%J',pending)); worker();
assert(job().state=='connected' && trim(readfile(BASE+'/source'))=='wwan');
assert(configuration.ssid==pending.ssid && configuration.key==pending.password);
assert(length(profiles())==1 && profiles()[0].password==pending.password);
assert(!readfile(RUN+'/wifi-pending'));
// Releasing a wired source must disable only STA, preserve profile and be idempotent.
save(BASE+'/source','wan\\n');
assert(releaseStation('wired').ok && configuration.disabled=='1');
assert(configuration.key==pending.password && length(profiles())==1);
let calls=reloads; assert(releaseStation('wired').ok && reloads==calls);
// Never interrupt a pending join, or a restored/up mobile connection.
configuration.disabled='0'; save(RUN+'/wifi-pending',sprintf('%J',pending));
assert(releaseStation('wired').ok && configuration.disabled=='0');unlink(RUN+'/wifi-pending');
save(BASE+'/source','wwan\\n');assert(releaseStation('wired').ok && configuration.disabled=='0');
assert(releaseStation('lost').ok && configuration.disabled=='0');
shouldJoin=false; assert(releaseStation('lost').ok && configuration.disabled=='1');
assert(trim(readfile(BASE+'/source'))=='wwan' && length(profiles())==1);
// A disabled old 2.4 GHz profile must not reload that radio when joining 5 GHz.
pending.radio='radio1'; configuration.device='radio0'; configuration.disabled='1';shouldJoin=true;
commands=[];save(RUN+'/wifi-pending',sprintf('%J',pending));worker();
assert(job().state=='connected' && configuration.device=='radio1');
assert(length(filter(commands,c=>index(c,'wifi reload radio0')>=0))==0);
assert(length(filter(commands,c=>index(c,'wifi reload radio1')>=0))==1);
print('Wi-Fi worker: failure restores station/source and keeps saved credentials; success saves profile and selects Wi-Fi; 7 radio release guards and independent 5 GHz reload passed\\n');
'''
try:
    subprocess.run(ssh + ['cat > ' + shlex.quote(root + '/test.uc')], input=source.encode(), check=True)
    subprocess.run(ssh + ['ucode ' + shlex.quote(root + '/test.uc')], check=True)
finally:
    subprocess.run(ssh + ['rm -rf ' + shlex.quote(root)], check=True)
