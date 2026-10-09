'use strict';
// Passwords travel on stdin and stay in root-only files; never in argv or replies.
import { stdin, readfile, writefile, open, rename, unlink } from 'fs';
import { cursor } from 'uci';
import { connect } from 'ubus';
const BASE='/etc/mobile-backup', RUN='/var/run/mobile-backup';
const uci=cursor(), bus=connect();
function read(path, fallback) { let s=readfile(path); return s ? json(s) : fallback; }
function save(path, value) {
    let f=open(path+'.new','w',0o600);
    if (!f || f.write(value) != length(value) || !f.close() || !rename(path+'.new',path)) die('Не удалось сохранить настройку');
}
function result(ok, message) { return {ok, message}; }
function station() {
    let found=[];
    uci.foreach('wireless','wifi-iface',s=>{if(s.mode=='sta' && s.network=='wwan')push(found,s);});
    if(length(found)>1) die('Несколько Wi-Fi клиентов wwan: проверьте штатные настройки беспроводной сети');
    return found[0];
}
function profiles() { return read(BASE+'/wifi-networks.json',[]); }
function same(a,b) { return a.radio==b.radio && a.ssid==b.ssid && a.encryption==b.encryption; }
function safe(p) { return {ssid:p.ssid,radio:p.radio,encryption:p.encryption}; }
function job() { return read(RUN+'/wifi-state', {state:'idle'}); }
function state(value, ssid) { save(RUN+'/wifi-state',sprintf('%J',{state:value,ssid:ssid||'',at:time()})); }
function radioValid(r) { return type(r)=='string' && match(r,/^radio[0-9]+$/) && uci.get('wireless',r)=='wifi-device'; }
function uplinkRadio(r) {
    let selected=trim(readfile(BASE+'/wifi-radio')||'');
    return radioValid(r) && (!selected || r==selected);
}
function valid(p) {
    if(!uplinkRadio(p.radio) || type(p.ssid)!='string' || length(p.ssid)<1 || length(p.ssid)>32 || match(p.ssid,/[[:cntrl:]]/)) return false;
    if(index(['none','psk2','sae','sae-mixed'],p.encryption)<0 || type(p.password)!='string')return false;
    if(p.encryption=='none')return p.password=='';
    return (length(p.password)>=8 && length(p.password)<=63 && !match(p.password,/[[:cntrl:]]/)) || (p.encryption=='psk2' && !!match(p.password,/^[0-9a-fA-F]{64}$/));
}
function wifiStatus() {
    let s=station(), link=bus.call('network.interface.wwan','status')||{};
    return {ssid:s?.ssid||'',radio:s?.device||'',enabled:!!s && s.disabled!='1',connected:!!s && s.disabled!='1' && !!link.up, saved:map(profiles(),safe),job:job()};
}
function scan() {
    let results=[], errors=[], own=[], radios=0;
    uci.foreach('wireless','wifi-iface',s=>{if(s.mode=='ap')push(own,s.ssid);});
    uci.foreach('wireless','wifi-device',r=>{
        let radio=r['.name'];
        if(!uplinkRadio(radio) || r.disabled=='1')return;
        radios++;
        let reply=bus.call('iwinfo','scan',{device:radio});
        if(type(reply?.results)!='array'){push(errors,radio);return;}
        for(let n in reply.results){
            if(!n.ssid || n.mode!='Master' || index(own,n.ssid)>=0)continue;
            let enc=n.encryption||{}, auth=enc.authentication||[], wpa=enc.wpa||[];
            let encryption=!enc.enabled?'none':index(auth,'sae')>=0?'sae':index(auth,'psk')>=0 && index(wpa,2)>=0?'psk2':'unsupported';
            let p={radio,ssid:n.ssid,encryption,signal:n.signal,band:n.band,channel:n.channel};
            if(length(filter(results,x=>same(x,p))))continue;
            p.saved=length(filter(profiles(),x=>same(x,p)))>0;
            push(results,p);
        }
    });
    sort(results,(a,b)=>b.signal-a.signal);
    return {ok:radios>0 && (!length(errors)||length(results)>0),networks:results,errors};
}
function restore(s, name) {
    uci.delete('wireless',name);
    if(s){
        uci.set('wireless',name,'wifi-iface');
        for(let k,v in s)if(substr(k,0,1)!='.')uci.set('wireless',name,k,v);
    }
    if(!uci.commit('wireless'))die('Не удалось восстановить Wi-Fi');
}
// A missing STA can suppress every AP on its radio. Release it when unused.
function releaseStation(reason) {
    if(readfile(RUN+'/wifi-pending'))return result(true,'Подключение ещё выполняется');
    let selected=trim(readfile(BASE+'/source')||'wan'), s=station();
    if(!s || s.disabled=='1')return result(true,'Wi-Fi клиент уже выключен');
    if(reason=='wired' && selected!='wan')return result(true,'Выбран другой источник');
    if(reason=='lost'){
        if(selected!='wwan' || bus.call('network.interface.wwan','status')?.up)return result(true,'Соединение уже восстановлено');
    } else if(reason!='wired')return result(false,'Неизвестная причина отключения');
    if(!radioValid(s.device))return result(false,'Неизвестный радиомодуль');
    uci.set('wireless',s['.name'],'disabled','1');
    if(!uci.commit('wireless'))die('Не удалось выключить Wi-Fi клиент');
    bus.call('network.interface.wwan','down');
    if(system('/sbin/wifi reload '+s.device+' >/dev/null 2>&1')!=0)die('Не удалось восстановить точку доступа');
    state('disconnected',s.ssid);
    return result(true,'Wi-Fi клиент выключен, домашняя точка доступа освобождена');
}

function worker() {
    let p=read(RUN+'/wifi-pending',null);
    if(!p || !valid(p))die('Нет корректного запроса подключения');
    let old=station(), name=old?.['.name']||'mobile_backup_sta';
    let previous=trim(readfile(BASE+'/source')||'wan');
    try {
        state('connecting',p.ssid);
        // A user-initiated join uses the wire while authentication/DHCP is pending.
        save(BASE+'/source','wan\n');
        system('/usr/sbin/mobile-backup normal >/dev/null 2>&1');
        if(old)uci.delete('wireless',name);
        uci.set('wireless',name,'wifi-iface');
        for(let k,v in {device:p.radio,network:'wwan',mode:'sta',ssid:p.ssid,encryption:p.encryption,disabled:'0'})uci.set('wireless',name,k,v);
        if(p.encryption!='none')uci.set('wireless',name,'key',p.password);
        if(!uci.commit('wireless'))die('Запись Wi-Fi не удалась');
        bus.call('network.interface.wwan','down');
        system('/sbin/wifi reload '+p.radio+' >/dev/null 2>&1');
        if(old && old.disabled!='1' && old.device!=p.radio && radioValid(old.device))system('/sbin/wifi reload '+old.device+' >/dev/null 2>&1');
        bus.call('network.interface.wwan','up');
        let joined=false;
        for(let i=0;i<25;i++){
            sleep(2000);
            let link=bus.call('network.interface.wwan','status')||{};
            let info=link.l3_device ? bus.call('iwinfo','info',{device:link.l3_device}) : {};
            if(link.up && length(link['ipv4-address']||[]) && info?.ssid==p.ssid){joined=true;break;}
        }
        if(!joined)die('Не удалось подключиться');
        let saved=filter(profiles(),x=>!same(x,p)); push(saved,p);
        save(BASE+'/wifi-networks.json',sprintf('%J',map(saved,x=>({radio:x.radio,ssid:x.ssid,encryption:x.encryption,password:x.password}))));
        save(BASE+'/source','wwan\n');
        state('connected',p.ssid);
    } catch(e) {
        restore(old,name);
        system('/sbin/wifi reload '+p.radio+' >/dev/null 2>&1');
        if(old && old.disabled!='1' && old.device!=p.radio && radioValid(old.device))system('/sbin/wifi reload '+old.device+' >/dev/null 2>&1');
        save(BASE+'/source',previous+'\n');
        state('failed',p.ssid);
    }
    unlink(RUN+'/wifi-pending');
}
function command(p) {
    let current=job();
    if(index(['queued','connecting'],current.state)>=0)return result(false,'Подключение уже выполняется');
    if(p.operation=='forget'){
        let saved=profiles(), remain=filter(saved,x=>!same(x,p));
        if(length(saved)==length(remain))return result(false,'Сеть не сохранена');
        save(BASE+'/wifi-networks.json',sprintf('%J',remain));
        return result(true,'Сеть удалена из сохранённых');
    }
    if(p.operation!='join' && p.operation!='saved')return result(false,'Неизвестная команда Wi-Fi');
    if(p.operation=='saved'){
        let found=filter(profiles(),x=>same(x,p));
        if(!length(found))return result(false,'Сеть не сохранена');
        p=found[0];
    }
    if(!uplinkRadio(p.radio))return result(false,'Для подключения используйте выделенный Wi-Fi адаптер');
    if(!valid(p))return result(false,'Проверьте сеть и пароль: WPA2/WPA3 — 8–63 символа');
    // No reload for a working saved connection; selecting the source is enough.
    let s=wifiStatus();
    if(s.connected && s.ssid==p.ssid && s.radio==p.radio && p.operation!='join'){
        save(BASE+'/source','wwan\n');state('connected',p.ssid);
        return result(true,'Выбрана Wi-Fi сеть');
    }
    save(RUN+'/wifi-pending',sprintf('%J',p));state('queued',p.ssid);
    if(system('/etc/init.d/mobile-wifi restart >/dev/null 2>&1')!=0){unlink(RUN+'/wifi-pending');state('failed',p.ssid);return result(false,'Не удалось запустить подключение');}
    return result(true,'Подключаемся. Обычно это занимает до минуты');
}
try {
    let action=ARGV[0], out;
    if(action=='status') { out=json(stdin.read('all')); out.wifi=wifiStatus(); }
    else if(action=='scan') out=scan();
    else if(action=='release') out=releaseStation(ARGV[1]);
    else if(action=='command') out=command(json(stdin.read('all')));
    else if(action=='test'){
        let radio=trim(readfile(BASE+'/wifi-radio')||'radio0');
        for(let enc in ['none','psk2','sae','sae-mixed'])assert(valid({radio,ssid:'example',encryption:enc,password:enc=='none'?'':'12345678'}));
        for(let p in [
            {radio:'radio0;touch /tmp/injected',ssid:'x',encryption:'none',password:''},
            {radio,ssid:'',encryption:'none',password:''},
            {radio,ssid:'x\n',encryption:'none',password:''},
            {radio,ssid:'x',encryption:'psk2',password:'short'},
            {radio,ssid:'x',encryption:'enterprise',password:'12345678'},
            {radio,ssid:'x',encryption:'none',password:'unexpected'}
        ])assert(!valid(p));
        assert(same({radio:'r',ssid:'a',encryption:'x'},{radio:'r',ssid:'a',encryption:'x'}));
        assert(!same({radio:'r',ssid:'a',encryption:'x'},{radio:'s',ssid:'a',encryption:'x'}));
        out=result(true,'12 Wi-Fi validation checks passed');
    }
    else if(action=='worker'){worker();exit(0);}
    else if(action=='import'){
        let s=station();
        if(s && !length(profiles())){let p={radio:s.device,ssid:s.ssid,encryption:s.encryption,password:s.key||''};if(valid(p))save(BASE+'/wifi-networks.json',sprintf('%J',[p]));}
        out=result(true,'Сохранённая сеть импортирована');
    }
    else die('Неизвестный метод');
    printf('%J\n',out);
} catch(e) { if(ARGV[0]=='test')warn(e.message+'\n'); printf('%J\n',result(false,'Не удалось выполнить операцию Wi-Fi')); exit(1); }
