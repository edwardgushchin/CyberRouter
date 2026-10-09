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
let configuration=json(sprintf('%J',original)), reloads=0, shouldJoin=false, commands=[], scans=[];
const uci={
    get:(cfg, section)=>index(['radio0','radio1','radio2'],section)>=0?'wifi-device':null,
    foreach:(cfg, kind, fn)=>{
        if(kind=='wifi-device'){for(let r in ['radio0','radio1','radio2'])fn({'.name':r});}
        else if(configuration)fn(configuration);
    },
    delete:(cfg,name)=>{configuration=null;},
    set:(cfg,name,key,value)=>{if(value==null)configuration={'.name':name};else configuration[key]=value;return true;},
    commit:()=>true
};
const bus={call:(object,method,args)=>{
    if(object=='network.interface.wwan' && method=='status')return {up:shouldJoin,l3_device:'wlan-test','ipv4-address':[{address:'192.0.2.2'}]};
    if(object=='iwinfo' && method=='scan'){
        push(scans,args.device);
        return {results:[{ssid:'new network',mode:'Master',encryption:{enabled:false},signal:-40,band:2,channel:1}]};
    }
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
// A pinned USB radio is used by scan, command validation and the worker.
save(BASE+'/wifi-radio','radio2\\n');
assert(!valid(pending));
assert(!command({operation:'join',radio:'radio0',ssid:'test',encryption:'none',password:''}).ok);
assert(!readfile(RUN+'/wifi-pending'));
let found=scan();
assert(found.ok && length(found.networks)==1 && found.networks[0].radio=='radio2');
assert(length(scans)==1 && scans[0]=='radio2');
pending.radio='radio2'; configuration.device='radio0'; configuration.disabled='1';
commands=[];save(RUN+'/wifi-pending',sprintf('%J',pending));worker();
assert(job().state=='connected' && configuration.device=='radio2');
assert(length(filter(commands,c=>index(c,'wifi reload radio2')>=0))==1);
assert(length(filter(commands,c=>index(c,'wifi reload radio0')>=0 || index(c,'wifi reload radio1')>=0))==0);
// An unavailable pin must never fall back to the home radios.
save(BASE+'/wifi-radio','radio9\\n'); scans=[];
assert(!valid(pending)); assert(!scan().ok && length(scans)==0);
print('Wi-Fi worker: rollback, saved credentials, release guards, independent reload and USB-only scan/join passed\\n');
'''
try:
    subprocess.run(ssh + ['cat > ' + shlex.quote(root + '/test.uc')], input=source.encode(), check=True)
    subprocess.run(ssh + ['ucode ' + shlex.quote(root + '/test.uc')], check=True)
finally:
    subprocess.run(ssh + ['rm -rf ' + shlex.quote(root)], check=True)
