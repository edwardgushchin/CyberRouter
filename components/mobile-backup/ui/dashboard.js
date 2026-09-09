'use strict';
'require view';
'require rpc';
'require poll';

var getStatus = rpc.declare({object:'luci.mobile-backup', method:'status', expect:{'':{}}});
var setAction = rpc.declare({object:'luci.mobile-backup', method:'action', params:['operation','value'], expect:{'':{}}});
var scanWifi = rpc.declare({object:'luci.mobile-backup',method:'scan',expect:{'':{}}});
var wifiAction = rpc.declare({object:'luci.mobile-backup',method:'wifi',params:['operation','radio','ssid','encryption','password'],expect:{'':{}}});
var panelRoot;
function element(id){return panelRoot && panelRoot.querySelector('[id="'+id+'"]');}
var names = {telemost:'Телемост', wbstream:'WB Stream', vk:'VK'};
var captchaURL = 'http://10.0.0.1:10982/';
var styles = L.resource('mobile-backup/dashboard.css');
function block(tag, cls, children) { return E(tag, {'class':cls}, children); }
function text(id, value) { var el=element(id); if(el && el.textContent!==String(value)) el.textContent=String(value); }
function clock(t) { return t ? new Date(t*1000).toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit',second:'2-digit'}) : 'ещё нет данных'; }
function pill(label, tone) { return block('span','mb-pill '+(tone||''),label); }
function icon(name) {
    var paths={home:'M3 10 12 3l9 7v11h-6v-7H9v7H3Z',router:'M3 13h18v8H3ZM7 17h.01M11 17h.01M6 13V5m12 8V5M9 7q3-3 6 0',globe:'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20ZM2 12h20M12 2q8 10 0 20-8-10 0-20',shield:'m12 2 9 4v6c0 5-9 10-9 10S3 17 3 12V6ZM8 12l3 3 5-6',phone:'M7 2h10v20H7ZM10 18h4',arrow:'M4 12h16m-6-6 6 6-6 6',refresh:'M20 7v5h-5M4 17v-5h5M6 7a7 7 0 0 1 12-1l2 6M4 12l2 6a7 7 0 0 0 12-1'};
    var svg=document.createElementNS('http://www.w3.org/2000/svg','svg');
    [['viewBox','0 0 24 24'],['fill','none'],['stroke','currentColor'],['stroke-width','1.6'],['stroke-linecap','round'],['stroke-linejoin','round'],['aria-hidden','true']].forEach(function(a){svg.setAttribute(a[0],a[1]);});
    var p=document.createElementNS('http://www.w3.org/2000/svg','path'); p.setAttribute('d',paths[name]||paths.shield); svg.appendChild(p); return svg;
}
function eventLabel(code) {
    var parts=code.split('='), value=parts[1];
    if(parts[0]==='uplink') return value==='wan'?'Домашняя сеть перешла на МТС':'Домашняя сеть перешла на телефон';
    if(parts[0]==='mode') return value==='bypass'?'Обход белых списков включён':'Обычный доступ, обход выключен';
    if(parts[0]==='provider_start') return 'Подключаем '+names[value];
    if(parts[0]==='provider_ready') return names[value]+': HTTPS и UDP проверены';
    if(parts[0]==='provider_failed') return names[value]+': канал не ответил';
    return {all_providers_failed:'Резервные каналы не ответили',vk_auth_required:'VK требуется авторизация'}[code]||'Состояние изменилось';
}
return view.extend({
    load: function(){ return getStatus(); },
    handleSaveApply:null, handleSave:null, handleReset:null,
    command: function(operation,value){
        var self=this; self.busy=true; self.paint(self.data);
        text('mb-feedback','Отправляем команду…');
        return setAction(operation,value||'').then(function(result){
            if(!result.ok) throw new Error(result.message||'Команда не выполнена');
            text('mb-feedback',operation==='policy'?'Режим сохранён. Текущий маршрут показан выше; переключение может занять до нескольких минут.':operation==='source'?'Источник сохранён. Маршрут обновится после текущей проверки.':operation==='priority'?'Приоритет сохранён. Он будет использован при следующем подключении.':'Команда принята. Ожидаем результат…');
            return getStatus();
        }).then(function(data){self.data=data;}).catch(function(err){text('mb-feedback','Не удалось выполнить команду: '+err.message);}).finally(function(){self.busy=false;self.paint(self.data);});
    },
    button:function(label,operation,value,cls){
        var self=this;
        return E('button',{'type':'button','class':'mb-button '+(cls||''),'data-command':operation,'click':function(){self.command(operation,value);}},label);
    },
    scanNetworks:function(){
        var self=this; self.scanning=true; self.paint(self.data);
        text('mb-wifi-feedback','Ищем сети 2,4 и 5 ГГц…');
        return scanWifi().then(function(r){
            if(!r.ok)throw new Error('Радиомодуль не ответил. Повторите поиск.');
            var list=element('mb-networks'); list.replaceChildren();
            (r.networks||[]).forEach(function(n){
                var button=E('button',{'type':'button','class':'mb-button mb-network','click':function(){self.chooseNetwork(n);}},[
                    block('span','',[block('strong','',n.ssid),block('small','',(n.band===2?'2,4':n.band)+' ГГц · '+n.signal+' dBm · '+(n.encryption==='none'?'Открытая':n.encryption==='unsupported'?'Тип защиты не поддерживается':({psk2:'WPA2',sae:'WPA3','sae-mixed':'WPA2/WPA3'}[n.encryption]||n.encryption)))]),
                    block('span','mb-small',n.saved?'Сохранена':'Выбрать')
                ]); button.disabled=n.encryption==='unsupported'; list.appendChild(button);
            });
            text('mb-wifi-feedback',(r.networks||[]).length?'Выберите сеть из списка.'+(r.errors.length?' Один радиомодуль не ответил.':''):'Сети не найдены. Включите точку доступа телефона и повторите поиск.');
        }).catch(function(e){text('mb-wifi-feedback',e.message);}).finally(function(){self.scanning=false;self.paint(self.data);});
    },
    chooseNetwork:function(n){
        this.selectedNetwork=n;
        element('mb-join').hidden=false; text('mb-join-title','Подключение к '+n.ssid);
        var saved=!!n.saved;
        element('mb-use-saved-row').hidden=!saved;
        element('mb-use-saved').checked=saved;
        element('mb-password').value=''; element('mb-password').type='password'; element('mb-show-password').checked=false;
        element('mb-password-row').hidden=saved || n.encryption==='none';
        text('mb-join-note',n.encryption==='none'?'Открытая сеть: пароль не требуется.':'Пароль сохранится на роутере после успешного подключения.');
        element('mb-join').scrollIntoView({block:'nearest'});
        if(!saved && n.encryption!=='none')element('mb-password').focus();
    },
    joinNetwork:function(n,saved){
        var self=this, password=saved?'':element('mb-password').value;
        if(!saved && n.encryption!=='none' && !((password.length>=8 && password.length<=63)||(n.encryption==='psk2' && /^[a-fA-F0-9]{64}$/.test(password)))){
            text('mb-wifi-feedback','Введите пароль из 8–63 символов.');element('mb-password').focus();return;
        }
        self.wifiBusy=true;self.paint(self.data);text('mb-wifi-feedback','Отправляем настройки подключения…');
        return wifiAction(saved?'saved':'join',n.radio,n.ssid,n.encryption,password).then(function(r){
            if(!r.ok)throw new Error(r.message);
            element('mb-password').value='';element('mb-join').hidden=true;
            text('mb-wifi-feedback',r.message);return getStatus();
        }).then(function(d){self.paint(d);}).catch(function(e){text('mb-wifi-feedback',e.message);}).finally(function(){self.wifiBusy=false;self.paint(self.data);});
    },
    watchCaptcha:function(){
        if(this.captchaWindow && !this.captchaWindow.closed){this.captchaWindow.focus();return;}
        this.captchaWindow=window.open(L.resource('mobile-backup/captcha-wait.html'),'cybernetwork-vk-captcha','popup,width=540,height=760');
        if(!this.captchaWindow){text('mb-feedback','Браузер заблокировал окно. Разрешите всплывающие окна для роутера или используйте кнопку «Пройти CAPTCHA».');return;}
        this.captchaWindow.opener=null;
        this.openedChallenge=''; this.paint(this.data);
    },
    paint:function(d){
        if(!d || !this.root) return;
        this.data=d;
        var wifi=d.wifi||{}, job=wifi.job||{}, joining=job.state==='queued'||job.state==='connecting';
        var stale=!!this.connectionError || !d.checked_at || d.now-d.checked_at>120, bypass=d.mode==='bypass', mobile=d.uplink==='wwan', c=d.checks||{}, vk=d.vk||{};
        var connected=d.link_state!=='disconnected' && (mobile ? (bypass ? d.proxy_state==='ready' : +c.mobile_external>=2) : +c.wan_external>=2);
        var title=stale?'Проверяем соединение':d.link_state==='disconnected'?'Выбранный источник недоступен':bypass?'Интернет через '+(names[d.provider]||'обход'):mobile?'Интернет через Wi-Fi':'Интернет через МТС';
        text('mb-title',title);
        text('mb-description',d.link_state==='disconnected'?'Подключите выбранный источник или выберите другой вручную.':bypass?'Обход включён для устройств домашней сети.':mobile?(wifi.ssid||'Wi-Fi')+' · обычный доступ, обход выключен.':'Проводной канал выбран вручную. Подключиться к Wi-Fi можно ниже.');
        text('mb-live',!d.running?'Служба остановлена':stale?'Данные устарели':connected?'Соединение активно':'Проверяем доступ');
        element('mb-live').className='mb-pill '+(!d.running||stale||!connected?'amber':'green');
        text('mb-fresh','Проверено '+clock(d.checked_at));
        text('mb-path-source',mobile?'Wi-Fi':'МТС'); text('mb-path-kind',bypass?(names[d.provider]||'Обход'):'Прямой доступ');
        text('mb-wan-count',(c.wan_external||'0')+' / 3'); text('mb-mobile-count',(c.mobile_external||'0')+' / 3');
        text('mb-wan-state',d.source==='wan'?'Выбран вручную':'Не выбран');
        text('mb-wifi-name',wifi.ssid||'Wi-Fi · телефон или другая сеть');
        text('mb-wifi-connection',wifi.connected?'Подключено к '+wifi.ssid:'Нет подключения к Wi-Fi');
        this.root.querySelectorAll('[data-source]').forEach(function(el){el.setAttribute('aria-pressed',String(el.dataset.source===d.source));});
        var savedSignature=JSON.stringify(wifi.saved||[]), self=this;
        if(savedSignature!==this.savedSignature){
            this.savedSignature=savedSignature;var savedList=element('mb-saved');savedList.replaceChildren();
            (wifi.saved||[]).forEach(function(n){savedList.appendChild(block('div','mb-saved-row',[block('div','',[block('strong','',n.ssid),block('small','',n.radio==='radio0'?'2,4 ГГц · пароль сохранён':'5 ГГц · пароль сохранён')]),E('button',{'type':'button','class':'mb-button','data-wifi-control':'','click':function(){self.joinNetwork(n,true);}},'Подключиться')]));});
            if(!(wifi.saved||[]).length)savedList.appendChild(block('p','mb-muted','После первого подключения сеть появится здесь.'));
        }
        var wifiDisabled=!!this.wifiBusy||!!this.connectionError||joining;
        this.root.querySelectorAll('[data-wifi-control]').forEach(function(el){el.disabled=wifiDisabled;});
        element('mb-scan').disabled=wifiDisabled||!!this.scanning;
        text('mb-scan',this.scanning?'Ищем сети…':'Найти Wi-Fi сети');
        if(job.state==='connecting'||job.state==='queued')text('mb-wifi-job','Подключаемся к '+job.ssid+'… До минуты; во время настройки используется проводной канал.');
        else if(job.state==='failed')text('mb-wifi-job','Не удалось подключиться к '+job.ssid+'. Проверьте пароль и точку доступа. Прежняя настройка восстановлена.');
        else if(!wifi.enabled)text('mb-wifi-job',d.source==='wan'?'Подключение к телефону выключено. Домашние Wi-Fi сети работают независимо от него.':'Точка доступа отключена или потеряна. Для возврата интернета включите её и нажмите «Подключиться».');
        else text('mb-wifi-job',wifi.connected?'Сеть подключена. Источник интернета выбирается вручную.':'Включите точку доступа, найдите сеть и подключитесь.');
        text('mb-mobile-state',{open:'Без признаков ограничений',limited:'Признаки белых списков',offline:'Нет доступа к проверочным сайтам',uncertain:'Неоднозначный результат'}[c.mobile_state]||'Ожидаем проверку');
        text('mb-allowed','Разрешённые сервисы: '+(c.mobile_allowed||'0')+' из 2');
        this.root.querySelectorAll('[data-policy]').forEach(function(el){el.setAttribute('aria-pressed',String(el.dataset.policy===d.policy));});
        var apply=(d.source==='wwan'&&d.policy==='bypass'&&!bypass)||(d.policy==='direct'&&bypass);
        text('mb-policy-note',d.source==='wan'?'Эта настройка действует при выбранном Wi-Fi. Через проводной МТС обход выключен.':apply?'Применяем режим. Текущий путь ещё не изменился.':d.policy==='auto'?'Обход включится после 3 подтверждений ограничений и выключится после 4 успешных проверок.':d.policy==='direct'?'Выбранная Wi-Fi сеть используется напрямую. Обход выключен.':'Выбранная Wi-Fi сеть используется через первый доступный канал обхода.');
        (d.providers||[]).forEach(function(p,i){
            var card=element('mb-provider-'+p.id), active=d.provider===p.id&&bypass;
            card.style.order=i; card.classList.toggle('is-active',active);
            text('mb-rank-'+p.id,String(i+1).padStart(2,'0'));
            text('mb-provider-state-'+p.id,active?'В работе':d.provider===p.id?'Подключение…':p.result==='ready'?'Проверка пройдена':p.result==='failed'?'Не ответил':'Готов к подключению');
            text('mb-provider-time-'+p.id,p.checked_at?'Последняя проверка '+clock(p.checked_at):'Проверится при включении обхода');
            var button=card.querySelector('button'); button.disabled=i===0||!!this.busy||!!this.connectionError; button.textContent=i===0?'Первый в очереди':'Сделать первым';
        },this);
        this.root.querySelectorAll('[data-command]').forEach(function(el){if(el.dataset.command!=='priority')el.disabled=!!this.busy||!!this.connectionError||(el.dataset.command==='source'&&joining);},this);
        this.root.querySelector('[data-source="wwan"]').disabled=!!this.busy||wifiDisabled||!wifi.connected;
        this.root.querySelector('[data-command="reconnect"]').disabled=!!this.busy||!!this.connectionError||d.source!=='wwan'||(!bypass && d.policy!=='bypass');
        var captcha=element('mb-vk'); captcha.classList.toggle('needs-action',!!vk.challenge);
        text('mb-vk-title',vk.challenge?'VK ждёт вашей проверки':vk.running?'Запрашиваем авторизацию VK':vk.state==='error'?'Не удалось обновить VK':vk.authorized?'VK авторизован':'VK нужно авторизовать');
        text('mb-vk-copy',vk.challenge?'Откройте CAPTCHA и пройдите проверку. Другие каналы продолжат работать.':vk.running?'Если понадобится CAPTCHA, здесь появится кнопка. Можно заранее открыть окно ожидания.':vk.state==='error'?'Новая авторизация не завершилась. Можно повторить попытку; сохранённая сессия не удалялась.':vk.authorized?'Авторизация сохранена на роутере. При новом запросе CAPTCHA панель покажет уведомление.':'Запустите авторизацию. Действующая сессия сохранится до успешного завершения новой проверки.');
        var open=element('mb-captcha-open'); open.hidden=!vk.challenge;
        this.root.querySelector('[data-command="authorize"]').hidden=!!vk.running;
        var cancelAuth=this.root.querySelector('[data-command="cancel-auth"]');
        cancelAuth.hidden=!vk.running && vk.state!=='error';
        cancelAuth.textContent=vk.running?'Отменить проверку':vk.authorized?'Оставить текущую авторизацию':'Сбросить ошибку';
        var watching=this.captchaWindow&&!this.captchaWindow.closed;
        text('mb-watch',watching?'Окно ожидания открыто':'Ждать CAPTCHA в отдельном окне');
        if(vk.challenge && watching && this.openedChallenge!==vk.challenge){
            try { this.captchaWindow.location=captchaURL; this.openedChallenge=vk.challenge; } catch(e) { text('mb-feedback','Новая CAPTCHA доступна. Нажмите «Пройти CAPTCHA».'); }
        }
        if(!vk.running && watching && this.openedChallenge){
            try { this.captchaWindow.location=L.resource('mobile-backup/captcha-wait.html')+(vk.state==='ready'?'?complete=1':'?expired=1'); this.openedChallenge=''; } catch(e) {}
        }
        document.title=(vk.challenge?'CAPTCHA VK · ':'')+'Резервный интернет · CyberNetwork';
        var signature=JSON.stringify(d.probes), probes=element('mb-probes');
        if(signature!==this.probeSignature){
            this.probeSignature=signature; probes.replaceChildren();
            (d.probes||[]).forEach(function(p){
                function result(v){return block('span','mb-result '+(v==='1'?'yes':v==='0'?'no':''),v==='1'?'Доступен':v==='0'?'Нет ответа':'—');}
                probes.appendChild(E('tr',{},[E('th',{'scope':'row'},[block('strong','',p.host),block('small','',p.group==='external'?'Внешний сервис':'Разрешённый сервис')]),E('td',{},result(p.wan)),E('td',{},result(p.wwan))]));
            });
        }
        var logSignature=JSON.stringify(d.events), log=element('mb-events');
        if(logSignature!==this.logSignature){
            this.logSignature=logSignature; log.replaceChildren();
            if(!(d.events||[]).length) log.appendChild(block('p','mb-muted','Новые переключения появятся здесь.'));
            (d.events||[]).slice().reverse().forEach(function(e){log.appendChild(block('li','',[E('time',{},clock(e.at)),block('span','',eventLabel(e.event))]));});
        }
    },
    render:function(data){
        var self=this;
        var modes=[['auto','Автоматически','Рекомендуется'],['direct','Без обхода','Обычный доступ'],['bypass','Через обход','Принудительно']];
        var providerCards=['telemost','wbstream','vk'].map(function(p){return E('article',{'class':'mb-provider','id':'mb-provider-'+p},[
            block('div','mb-row',[block('span','mb-monogram '+p,p==='telemost'?'T':p==='vk'?'VK':'W'),E('span',{'class':'mb-rank','id':'mb-rank-'+p},'')]),
            block('h3','',names[p]),E('p',{'id':'mb-provider-state-'+p,'class':'mb-provider-status'},'Готов к подключению'),E('p',{'id':'mb-provider-time-'+p,'class':'mb-small'},''),
            self.button('Сделать первым','priority',p)
        ]);});
        this.root=E('div',{'id':'mobile-backup','class':'mb'},[
            E('link',{'rel':'stylesheet','href':styles}),
            block('header','mb-header',[block('div','',[block('div','mb-eyebrow','CYBERNETWORK'),block('h1','','Резервный интернет')]),block('div','mb-update',[E('span',{'id':'mb-live','class':'mb-pill'},'Подключаемся'),E('span',{'id':'mb-fresh','class':'mb-small'},'')])]),
            block('section','mb-hero',[block('div','mb-hero-copy',[block('span','mb-eyebrow','ТЕКУЩЕЕ ПОДКЛЮЧЕНИЕ'),E('h2',{'id':'mb-title'},''),E('p',{'id':'mb-description'},'')]),block('div','mb-path',[
                block('div','mb-node',[icon('home'),block('span','','Дом')]),icon('arrow'),block('div','mb-node mb-node-router',[icon('router'),block('span','','Flint 2')]),icon('arrow'),block('div','mb-node',[icon('globe'),E('span',{'id':'mb-path-source'},''),E('small',{'id':'mb-path-kind'},'')])
            ])]),
            block('div','mb-uplinks',[
                block('article','mb-uplink',[icon('router'),block('div','',[block('h3','','Домашний МТС'),E('p',{'id':'mb-wan-state'},'')]),block('div','mb-score',[E('strong',{'id':'mb-wan-count'},''),block('small','','внешних сервисов')])]),
                block('article','mb-uplink',[icon('phone'),block('div','',[E('h3',{'id':'mb-wifi-name'},'Wi-Fi'),E('p',{'id':'mb-mobile-state'},''),E('small',{'id':'mb-allowed'},'')]),block('div','mb-score',[E('strong',{'id':'mb-mobile-count'},''),block('small','','внешних сервисов')])])
            ]),
            block('section','mb-panel mb-source-panel',[
                block('div','mb-section-heading',[block('div','',[block('h2','','Источник интернета'),block('p','mb-muted','Выберите проводной канал или подключитесь к Wi-Fi.')]),pill('Выбирается вручную')]),
                block('div','mb-sources',[['wan','Проводной МТС'],['wwan','Подключённый Wi-Fi']].map(function(s){var b=self.button(s[1],'source',s[0],'mb-mode');b.dataset.source=s[0];b.setAttribute('aria-pressed','false');return b;})),
                E('p',{'id':'mb-wifi-connection','class':'mb-policy-note'},''),
                block('div','mb-section-heading mb-wifi-heading',[block('h3','','Сохранённые сети'),E('button',{'id':'mb-scan','type':'button','class':'mb-button','click':function(){self.scanNetworks();}},'Найти Wi-Fi сети')]),
                E('div',{'id':'mb-saved'},[]),E('p',{'id':'mb-wifi-job','class':'mb-policy-note','role':'status','aria-live':'polite'},''),
                E('div',{'id':'mb-networks','class':'mb-networks'},[]),
                E('form',{'id':'mb-join','class':'mb-join','hidden':true,'submit':function(ev){ev.preventDefault();self.joinNetwork(self.selectedNetwork,element('mb-use-saved').checked);}},[
                    E('h3',{'id':'mb-join-title'},''),
                    E('label',{'id':'mb-use-saved-row','class':'mb-check'},[E('input',{'id':'mb-use-saved','type':'checkbox','change':function(ev){element('mb-password-row').hidden=ev.target.checked||self.selectedNetwork.encryption==='none';}}),'Использовать сохранённый пароль']),
                    E('div',{'id':'mb-password-row'},[E('label',{'for':'mb-password'},'Пароль Wi-Fi'),E('input',{'id':'mb-password','type':'password','autocomplete':'new-password','maxlength':64}),E('label',{'class':'mb-check'},[E('input',{'id':'mb-show-password','type':'checkbox','change':function(ev){element('mb-password').type=ev.target.checked?'text':'password';}}),'Показать пароль'])]),
                    E('p',{'id':'mb-join-note','class':'mb-muted'},''),
                    block('div','mb-join-actions',[E('button',{'type':'submit','class':'mb-button mb-primary','data-wifi-control':''},'Подключиться'),E('button',{'type':'button','class':'mb-button','click':function(){element('mb-join').hidden=true;element('mb-password').value='';}},'Отмена')])
                ]),
                E('p',{'id':'mb-wifi-feedback','class':'mb-policy-note','role':'status','aria-live':'polite'},''),
                block('p','mb-footnote','Общий радиомодуль 2,4 ГГц может прерывать домашний Wi-Fi при подключении телефона. Для независимой работы нужен отдельный Wi-Fi-приёмник. При выборе МТС телефон отключается, пароль сохраняется.')
            ]),
            block('section','mb-panel',[block('div','mb-section-heading',[block('div','',[block('h2','','Обход белых списков'),block('p','mb-muted','Применяется к выбранной Wi-Fi сети и всем домашним устройствам.')]),pill('Автозапуск на роутере','')]),
                block('div','mb-modes',modes.map(function(m){var b=self.button([block('strong','',m[1]),block('small','',m[2])],'policy',m[0],'mb-mode');b.dataset.policy=m[0];b.setAttribute('aria-pressed','false');return b;})),
                E('p',{'id':'mb-policy-note','class':'mb-policy-note'},'')
            ]),
            block('div','mb-columns',[
                block('section','mb-panel mb-channels',[block('div','mb-section-heading',[block('div','',[block('h2','','Каналы обхода'),block('p','mb-muted','Первый доступный канал подхватит соединение.')]),icon('shield')]),block('div','mb-providers',providerCards),self.button('Переподключить обход','reconnect','','mb-reconnect')]),
                E('section',{'class':'mb-panel mb-vk','id':'mb-vk','aria-label':'Авторизация VK'},[block('div','mb-vk-top',[block('span','mb-monogram vk','VK'),pill('Авторизация')]),E('h2',{'id':'mb-vk-title'},''),E('p',{'id':'mb-vk-copy','class':'mb-muted'},''),
                    E('a',{'id':'mb-captcha-open','class':'mb-button mb-primary','href':captchaURL,'target':'_blank','rel':'noopener noreferrer','hidden':true},'Пройти CAPTCHA ↗'),
                    self.button('Обновить авторизацию','authorize','','mb-full'),self.button('Отменить проверку','cancel-auth','','mb-full'),
                    E('button',{'id':'mb-watch','class':'mb-watch','type':'button','click':function(){self.watchCaptcha();}},'Ждать CAPTCHA в отдельном окне'),
                    block('small','mb-footnote','Оставьте панель открытой для автоматического появления CAPTCHA. Прохождение доступно с основного компьютера.')
                ])
            ]),
            E('div',{'id':'mb-feedback','class':'mb-feedback','role':'status','aria-live':'polite'},'Настройки сохраняются сразу. Доступ к панели защищён входом в роутер.'),
            E('a',{'id':'mb-relogin','class':'mb-button','href':L.url('admin/services/mobile-backup'),'hidden':true},'Обновить панель / войти заново'),
            block('div','mb-columns mb-bottom',[
                block('section','mb-panel',[block('h2','','Проверка доступности'),block('p','mb-muted','Прямые HTTPS-запросы, независимо от обхода.'),block('div','mb-table-wrap',[E('table',{'class':'mb-table'},[E('thead',{},E('tr',{},[E('th',{'scope':'col'},'Сервис'),E('th',{'scope':'col'},'МТС'),E('th',{'scope':'col'},'Wi-Fi')])),E('tbody',{'id':'mb-probes'},[])])])]),
                block('section','mb-panel',[block('h2','','Последние события'),block('p','mb-muted','Подключения и переключения этой сессии.'),E('ol',{'id':'mb-events','class':'mb-events'},[])])
            ]),
            block('footer','mb-footer',[block('div','mb-links',[block('span','','Flint 2'),E('a',{href:L.url('admin/services/xray')},'Xray'),E('a',{href:L.url('admin/services/zapret2')},'Zapret2'),E('a',{href:L.url('admin/services/https-dns-proxy')},'DNS')]),E('button',{'type':'button','class':'mb-watch','click':function(ev){self.paused=!self.paused;ev.currentTarget.textContent=self.paused?'Возобновить обновление':'Приостановить обновление';}},'Приостановить обновление')])
        ]);
        panelRoot=this.root;
        this.paint(data);
        poll.add(function(){
            if(self.paused || (document.hidden && (!self.captchaWindow || self.captchaWindow.closed)))return Promise.resolve();
            return getStatus().then(function(d){self.connectionError=false; element('mb-relogin').hidden=true; self.paint(d);}).catch(function(){self.connectionError=true; self.paint(self.data); text('mb-live','Панель недоступна');element('mb-live').className='mb-pill amber';element('mb-relogin').hidden=false;text('mb-feedback','Не удалось обновить состояние. Возможно, истекла сессия входа в роутер. Показаны последние полученные данные.');});
        },5);
        return this.root;
    }
});
