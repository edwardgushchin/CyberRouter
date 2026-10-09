'use strict';
'require view';
'require rpc';
'require fs';
'require ui';

function detectLocale() {
	var htmlLang = '';
	var luciLang = '';
	var browserLang = '';

	try {
		htmlLang = document && document.documentElement ? (document.documentElement.getAttribute('lang') || '') : '';
	} catch (e) {}

	try {
		luciLang = window.L && L.env ? (L.env.lang || L.env.i18nLanguage || '') : '';
	} catch (e2) {}

	try {
		browserLang = (navigator.language || (navigator.languages && navigator.languages[0]) || '');
	} catch (e3) {}

	return String(htmlLang || luciLang || browserLang || 'en').toLowerCase();
}

var CURRENT_LOCALE = detectLocale();
var USE_RUSSIAN = /^ru([_-]|$)/.test(CURRENT_LOCALE);

function tr(en, ru) {
	return USE_RUSSIAN ? ru : en;
}

var callServiceList = rpc.declare({
	object: 'service',
	method: 'list',
	params: [ 'name', 'verbose' ],
	expect: { '': {} }
});

var callInitList = rpc.declare({
	object: 'luci',
	method: 'getInitList',
	params: [ 'name' ],
	expect: { '': {} }
});

var callInitAction = rpc.declare({
	object: 'luci',
	method: 'setInitAction',
	params: [ 'name', 'action' ],
	expect: { result: false }
});

function safeExec(cmd, args) {
	return fs.exec(cmd, args || []).catch(function(err) {
		return {
			code: -1,
			stdout: '',
			stderr: err ? (err.message || String(err)) : 'Unknown exec error'
		};
	});
}

function trimText(value) {
	return String(value || '').trim();
}

function normalizeText(text) {
	var value = String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
	return value.endsWith('\n') ? value : value + '\n';
}

function tailLines(text, limit) {
	var lines = String(text || '').split(/\n/).filter(function(line) { return trimText(line); });
	if (lines.length <= limit)
		return trimText(lines.join('\n'));
	return trimText(lines.slice(lines.length - limit).join('\n'));
}

function parseJsonText(text) {
	try {
		return { ok: true, value: JSON.parse(text) };
	} catch (err) {
		return { ok: false, error: err.message || String(err) };
	}
}

function parseStatusJson(text) {
	var parsed = parseJsonText(text || '{}');
	return parsed.ok && parsed.value && typeof parsed.value === 'object' ? parsed.value : {};
}

function getServiceInfo(serviceData, name) {
	var svc = serviceData && serviceData[name] ? serviceData[name] : null;
	var instances = svc && svc.instances ? Object.keys(svc.instances).map(function(key) { return svc.instances[key]; }) : [];
	var running = instances.filter(function(instance) { return !!instance.running; });
	var first = running[0] || instances[0] || null;
	var command = first && Array.isArray(first.command) ? first.command.join(' ') : '';

	return {
		totalCount: instances.length,
		runningCount: running.length,
		running: running.length > 0,
		pids: running.map(function(instance) { return instance.pid; }).filter(function(pid) { return pid != null; }),
		command: command
	};
}

function getStateLabel(enabled, running) {
	if (running)
		return tr('Running', 'Работает');
	if (!enabled)
		return tr('Disabled', 'Выключен');
	return tr('Stopped', 'Остановлен');
}

function getAutostartLabel(enabled) {
	return enabled ? tr('Enabled', 'Включён') : tr('Disabled', 'Выключен');
}

function buildServiceActions(running, enabled) {
	var actions = [];

	if (running) {
		actions.push({ action: 'restart', label: tr('Restart', 'Перезапустить') });
		actions.push({ action: 'stop', label: tr('Stop now', 'Остановить сейчас') });
	}
	else {
		actions.push({ action: 'start', label: tr('Start now', 'Запустить сейчас') });
	}

	actions.push({
		action: enabled ? 'disable' : 'enable',
		label: enabled ? tr('Disable autostart', 'Выключить автозапуск') : tr('Enable autostart', 'Включить автозапуск'),
		wide: !!enabled,
		extraClass: enabled ? 'xr-autostart-disable' : ''
	});

	return actions;
}

function extractSummary(config) {
	var summary = {
		proxyAddress: '',
		proxyPort: '',
		uuid: '',
		serverName: '',
		fingerprint: 'chrome',
		publicKey: '',
		shortId: '',
		spiderX: '/',
		debugSocksPort: '10808',
		tproxyPort: '12345',
		logLevel: 'info',
		proxyDomains: []
	};

	if (!config || typeof config !== 'object')
		return summary;

	if (config.log && config.log.loglevel)
		summary.logLevel = String(config.log.loglevel);

	(config.inbounds || []).forEach(function(inbound) {
		if (inbound.tag === 'debug-socks' && inbound.port != null)
			summary.debugSocksPort = String(inbound.port);
		if (inbound.tag === 'tproxy-in' && inbound.port != null)
			summary.tproxyPort = String(inbound.port);
	});

	(config.outbounds || []).forEach(function(outbound) {
		if (outbound.tag !== 'proxy')
			return;

		var vnext = outbound.settings && outbound.settings.vnext && outbound.settings.vnext[0] ? outbound.settings.vnext[0] : null;
		var user = vnext && Array.isArray(vnext.users) && vnext.users[0] ? vnext.users[0] : null;
		var reality = outbound.streamSettings && outbound.streamSettings.realitySettings ? outbound.streamSettings.realitySettings : null;

		if (vnext && vnext.address)
			summary.proxyAddress = String(vnext.address);
		if (vnext && vnext.port != null)
			summary.proxyPort = String(vnext.port);
		if (user && user.id)
			summary.uuid = String(user.id);
		if (reality && reality.serverName)
			summary.serverName = String(reality.serverName);
		if (reality && reality.fingerprint)
			summary.fingerprint = String(reality.fingerprint);
		if (reality && reality.publicKey)
			summary.publicKey = String(reality.publicKey);
		if (reality && reality.shortId)
			summary.shortId = String(reality.shortId);
		if (reality && reality.spiderX != null)
			summary.spiderX = String(reality.spiderX);
	});

	var rule = proxyDomainRule(config);
	if (rule)
		summary.proxyDomains = rule.domain.slice();

	return summary;
}

function normalizeDomainInput(text, previous) {
	var seen = {};
	var result = [];
	var known = Object.create(null);
	(previous || []).forEach(function(token) { known[token.replace(/^domain:/, '').toLowerCase()] = token; });

	String(text || '').split(/\n/).forEach(function(line) {
		var value = trimText(line).replace(/^domain:/, '').toLowerCase().replace(/\.$/, '');
		if (!value || /^#/.test(value))
			return;
		if (!seen[value]) {
			seen[value] = true;
			result.push(known[value] || 'domain:' + value);
		}
	});

	return result;
}

function proxyDomainRule(config) {
	var best = null;
	(config.routing && Array.isArray(config.routing.rules) ? config.routing.rules : []).forEach(function(rule) {
		if (!rule || rule.outboundTag !== 'proxy' || !Array.isArray(rule.domain))
			return;
		if (rule.ruleTag === 'common-proxy-domains')
			best = rule;
		else if (!rule.ruleTag && (!best || (best.ruleTag !== 'common-proxy-domains' && rule.domain.length > best.domain.length)))
			best = rule;
	});
	return best;
}

function updateConnectionSettings(config, fields) {
	config = config || {};
	config.log = config.log || {};
	config.log.loglevel = fields.logLevel || 'info';

	if (!Array.isArray(config.outbounds))
		config.outbounds = [];

	var proxy = null;
	config.outbounds.some(function(item) {
		if (item && item.tag === 'proxy') {
			proxy = item;
			return true;
		}
		return false;
	});

	if (!proxy) {
		proxy = { tag: 'proxy' };
		config.outbounds.unshift(proxy);
	}

	proxy.protocol = 'vless';
	proxy.settings = proxy.settings || {};
	proxy.settings.vnext = Array.isArray(proxy.settings.vnext) ? proxy.settings.vnext : [ {} ];
	proxy.settings.vnext[0] = proxy.settings.vnext[0] || {};
	proxy.settings.vnext[0].address = fields.address;
	proxy.settings.vnext[0].port = parseInt(fields.port, 10);
	proxy.settings.vnext[0].users = Array.isArray(proxy.settings.vnext[0].users) ? proxy.settings.vnext[0].users : [ {} ];
	proxy.settings.vnext[0].users[0] = proxy.settings.vnext[0].users[0] || {};
	proxy.settings.vnext[0].users[0].id = fields.uuid;
	proxy.settings.vnext[0].users[0].encryption = 'none';
	proxy.settings.vnext[0].users[0].flow = 'xtls-rprx-vision';

	proxy.streamSettings = proxy.streamSettings || {};
	proxy.streamSettings.network = 'tcp';
	proxy.streamSettings.security = 'reality';
	proxy.streamSettings.realitySettings = proxy.streamSettings.realitySettings || {};
	proxy.streamSettings.realitySettings.serverName = fields.serverName;
	proxy.streamSettings.realitySettings.fingerprint = fields.fingerprint || 'chrome';
	proxy.streamSettings.realitySettings.publicKey = fields.publicKey;
	proxy.streamSettings.realitySettings.shortId = fields.shortId;
	proxy.streamSettings.realitySettings.spiderX = fields.spiderX || '/';

	return config;
}

function parseHttpsDnsProxyConfig(text) {
	var result = {
		listenAddr: '127.0.0.1',
		forceDns: '0',
		resolvers: []
	};
	var current = null;

	String(text || '').split(/\n/).forEach(function(line) {
		var configMatch = line.match(/^\s*config\s+([^\s]+)(?:\s+'([^']+)')?/);
		var optionMatch = line.match(/^\s*option\s+([^\s]+)\s+'([^']*)'/);
		if (configMatch) {
			current = { type: configMatch[1], name: configMatch[2] || '' };
			if (current.type === 'https-dns-proxy')
				result.resolvers.push({ resolver_url: '', bootstrap_dns: '', listen_port: '' });
			return;
		}
		if (!optionMatch || !current)
			return;

		if (current.type === 'main') {
			if (optionMatch[1] === 'listen_addr')
				result.listenAddr = optionMatch[2];
			else if (optionMatch[1] === 'force_dns')
				result.forceDns = optionMatch[2];
		}
		else if (current.type === 'https-dns-proxy') {
			var item = result.resolvers[result.resolvers.length - 1];
			item[optionMatch[1]] = optionMatch[2];
		}
	});

	return result;
}

function ensureInitAction(serviceName, action) {
	return callInitAction(serviceName, action).then(function(success) {
		if (!success)
			throw new Error('Command failed: ' + serviceName + ' ' + action);
		return true;
	});
}

function getServiceActionClass(action) {
	switch (action) {
	case 'restart':
		return 'cbi-button-apply';
	case 'start':
	case 'enable':
		return 'cbi-button-action';
	case 'stop':
	case 'disable':
		return 'cbi-button-negative';
	default:
		return 'cbi-button-neutral';
	}
}

function makeButton(label, handler, cls) {
	return E('button', {
		'class': 'btn cbi-button ' + (cls || 'cbi-button-neutral'),
		'click': ui.createHandlerFn(this, handler)
	}, label);
}

function makeField(label, input) {
	return E('div', { 'class': 'cbi-value' }, [
		E('label', { 'class': 'cbi-value-title' }, label),
		E('div', { 'class': 'cbi-value-field' }, [ input ])
	]);
}

function makeWideField(label, input) {
	return E('div', { 'class': 'cbi-value xr-wide' }, [
		E('label', { 'class': 'cbi-value-title' }, label),
		E('div', { 'class': 'cbi-value-field' }, [ input ])
	]);
}

if (!window.__xrayNativeStylesInjected) {
	window.__xrayNativeStylesInjected = true;
	document.head.append(E('style', { 'type': 'text/css' }, `
		.xr-native .cbi-section { margin-bottom: 1.25rem; }
		.xr-native .cbi-value-field > input,
		.xr-native .cbi-value-field > select,
		.xr-native .cbi-value-field > textarea { width: 100%; box-sizing: border-box; }
		.xr-native .xr-actions { display: flex; flex-wrap: wrap; gap: .5rem; }
		.xr-native .xr-actions .btn { margin: 0; }
		.xr-native .xr-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: .75rem; }
		.xr-native .xr-service-actions {
			display: grid;
			grid-template-columns: repeat(2, minmax(0, 1fr));
			gap: .5rem;
		}
		.xr-native .xr-service-actions .btn {
			width: 100% !important;
			min-width: 0;
			white-space: nowrap;
			overflow: hidden;
			text-overflow: ellipsis;
		}
		.xr-native .xr-service-actions .btn.xr-service-action-wide {
			grid-column: 1 / -1;
			white-space: normal;
			text-overflow: clip;
		}
		.xr-native .xr-service-actions .btn.xr-autostart-disable {
			background: #b13a48 !important;
			border-color: #b13a48 !important;
			color: #fff !important;
		}
		.xr-native .xr-service-box h3 { margin-bottom: .25rem; }
		.xr-native .xr-kv { line-height: 1.55; }
		.xr-native .cbi-value.xr-wide { display: block; }
		.xr-native .cbi-value.xr-wide > .cbi-value-title { display: block; width: 100%; margin: 0 0 .5rem 0; }
		.xr-native .cbi-value.xr-wide > .cbi-value-field { display: block; width: 100%; max-width: none; margin: 0; }
		.xr-native .cbi-value.xr-wide textarea { min-height: 12rem; }
		.xr-native .xr-kv dt { font-weight: 600; }
		.xr-native .xr-kv dd { margin: 0 0 .75rem 0; color: var(--text-color-medium, inherit); word-break: break-word; }
		.xr-native .xr-log { min-height: 14rem; font-family: monospace; }
		.xr-native .xr-advanced { margin-top: .75rem; }
		.xr-native .xr-advanced > summary { cursor: pointer; font-weight: 600; }
		.xr-native .cbi-section-descr.xr-inline-note { margin-top: .5rem; }
		.xr-native .xr-status-ok { color: #2ea256; font-weight: 600; }
		.xr-native .xr-status-error { color: #d9534f; font-weight: 600; }
		.xr-native .xr-status-warn { color: #c28800; font-weight: 600; }
	`));
}

return view.extend({
	load: function() {
		return this.fetchData();
	},

	fetchData: function() {
		return Promise.all([
			callInitList('xray'),
			callInitList('xray-split'),
			callInitList('https-dns-proxy'),
			callServiceList('xray', 1),
			callServiceList('https-dns-proxy', 1),
			fs.read('/etc/xray/config.json').catch(function() { return ''; }),
			fs.read('/etc/xray/90-xray-tproxy-table.nft').catch(function() { return ''; }),
			fs.read('/etc/xray/91-xray-tproxy-prerouting.nft').catch(function() { return ''; }),
			fs.read('/etc/config/https-dns-proxy').catch(function() { return ''; }),
			fs.read('/tmp/xray-luci-status.json').catch(function() { return '{}'; }),
			safeExec('/usr/bin/xray', [ 'version' ]),
			safeExec('/sbin/ip', [ 'rule', 'show' ]),
			safeExec('/usr/sbin/nft', [ 'list', 'chain', 'inet', 'fw4', 'xray_tproxy' ]),
			safeExec('/sbin/logread', [ '-e', 'xray' ]),
			safeExec('/sbin/logread', [ '-e', 'https-dns-proxy' ]),
			safeExec('/bin/sh', [ '-c', 'uci show dhcp | grep -E "doh_server|server=|noresolv" || true' ]),
			safeExec('/bin/sh', [ '-c', 'ls -1dt /etc/xray/luci-backups/* 2>/dev/null | head -n 1 || true' ])
		]);
	},

	setOutput: function(text) {
		var value = trimText(text || '');
		this.statusState = this.statusState || {};
		this.statusState.lastOutput = value;
		if (this.outputArea)
			this.outputArea.value = value;
		return this.writeStatusState(this.statusState).catch(function() {});
	},

	notifyError: function(prefix, err) {
		var message = prefix + ': ' + (err && (err.message || err.stderr || err) ? (err.message || err.stderr || err) : tr('Unknown error', 'Неизвестная ошибка'));
		this.setOutput(message);
		ui.addNotification(null, E('p', message));
	},

	notifyInfo: function(message, details) {
		this.setOutput(details || message);
		ui.addNotification(null, E('p', message), 'info');
	},

	writeStatusState: function(data) {
		this.statusState = data || {};
		return fs.write('/tmp/xray-luci-status.json', JSON.stringify(this.statusState, null, 2) + '\n');
	},

	refreshAll: function() {
		var self = this;
		return this.fetchData().then(function(data) {
			self.data = data;
			self.applyData(data);
			return data;
		});
	},

	applyData: function(data) {
		var initXray = data[0] || {};
		var initSplit = data[1] || {};
		var initDns = data[2] || {};
		var xrayServiceList = data[3] || {};
		var dnsServiceList = data[4] || {};
		var configText = data[5] || '';
		var tableText = data[6] || '';
		var preroutingText = data[7] || '';
		var dnsConfigText = data[8] || '';
		var statusText = data[9] || '{}';
		var versionRes = data[10] || { code: -1, stdout: '', stderr: '' };
		var ipRulesRes = data[11] || { code: -1, stdout: '', stderr: '' };
		var nftRes = data[12] || { code: -1, stdout: '', stderr: '' };
		var xrayLogRes = data[13] || { code: -1, stdout: '', stderr: '' };
		var dnsLogRes = data[14] || { code: -1, stdout: '', stderr: '' };
		var dnsmasqRes = data[15] || { code: -1, stdout: '', stderr: '' };
		var latestBackupRes = data[16] || { code: -1, stdout: '', stderr: '' };

		this.configArea.value = normalizeText(configText || '');
		this.routingArea.value = (extractSummary(parseJsonText(configText).value || {}).proxyDomains || []).map(function(item) {
			return String(item).replace(/^domain:/, '');
		}).join('\n');
		this.tableArea.value = normalizeText(tableText || '');
		this.preroutingArea.value = normalizeText(preroutingText || '');
		this.dnsConfigArea.value = normalizeText(dnsConfigText || '');
		this.xrayLogArea.value = tailLines(xrayLogRes.stdout || xrayLogRes.stderr || '', 120);
		this.dnsLogArea.value = tailLines(dnsLogRes.stdout || dnsLogRes.stderr || '', 120);

		var statusState = parseStatusJson(statusText || '{}');
		this.outputArea.value = statusState.lastOutput || '';
		this.statusState = statusState;
		var parsedConfig = parseJsonText(configText || '{}');
		var summary = extractSummary(parsedConfig.ok ? parsedConfig.value : {});
		var dnsSummary = parseHttpsDnsProxyConfig(dnsConfigText || '');
		var xrayEnabled = !!(initXray.xray && initXray.xray.enabled);
		var splitEnabled = !!(initSplit['xray-split'] && initSplit['xray-split'].enabled);
		var dnsEnabled = !!(initDns['https-dns-proxy'] && initDns['https-dns-proxy'].enabled);
		var xraySvc = getServiceInfo(xrayServiceList, 'xray');
		var dnsSvc = getServiceInfo(dnsServiceList, 'https-dns-proxy');
		var splitRunning = /fwmark 0x1 lookup 100/.test(ipRulesRes.stdout || '') && /chain xray_tproxy/.test(nftRes.stdout || '');
		var latestBackup = trimText(latestBackupRes.stdout || latestBackupRes.stderr || '');
		var openaiTest = statusState.tests && statusState.tests.openai ? statusState.tests.openai : null;
		var directTest = statusState.tests && statusState.tests.direct ? statusState.tests.direct : null;

		this.serviceOverview.innerHTML = '';
		this.serviceOverview.appendChild(E('div', { 'class': 'xr-grid' }, [
			this.renderServiceBox({
				name: 'xray',
				runtimeTitle: tr('Process', 'Процесс'),
				runtimeState: getStateLabel(true, xraySvc.running),
				autostartEnabled: xrayEnabled,
				detail: xraySvc.pids.join(', ') || '-',
				actions: buildServiceActions(xraySvc.running, xrayEnabled)
			}),
			this.renderServiceBox({
				name: 'xray-split',
				runtimeTitle: tr('Policy', 'Политика'),
				runtimeState: splitRunning ? tr('Active', 'Активна') : tr('Inactive', 'Неактивна'),
				autostartEnabled: splitEnabled,
				detail: splitRunning ? tr('fwmark 0x1 → table 100', 'fwmark 0x1 → table 100') : '-',
				actions: buildServiceActions(splitRunning, splitEnabled)
			}),
			this.renderServiceBox({
				name: 'https-dns-proxy',
				runtimeTitle: tr('Process', 'Процесс'),
				runtimeState: getStateLabel(true, dnsSvc.running),
				autostartEnabled: dnsEnabled,
				detail: dnsSvc.pids.join(', ') || '-',
				actions: buildServiceActions(dnsSvc.running, dnsEnabled)
			})
		]));

		this.connectionInfo.innerHTML = '';
		this.connectionInfo.appendChild(E('dl', { 'class': 'xr-kv' }, [
			E('dt', tr('Xray version', 'Версия Xray')), E('dd', trimText((versionRes.stdout || versionRes.stderr || '').split(/\n/)[0]) || '-'),
			E('dt', tr('Server', 'Сервер')), E('dd', summary.proxyAddress ? (summary.proxyAddress + ':' + summary.proxyPort) : '-'),
			E('dt', tr('UUID', 'UUID')), E('dd', summary.uuid || '-'),
			E('dt', tr('REALITY serverName', 'REALITY serverName')), E('dd', summary.serverName || '-'),
			E('dt', tr('Fingerprint', 'Fingerprint')), E('dd', summary.fingerprint || '-'),
			E('dt', tr('Public key', 'Public key')), E('dd', summary.publicKey || '-'),
			E('dt', tr('Short ID', 'Short ID')), E('dd', summary.shortId || '-'),
			E('dt', tr('Debug SOCKS port', 'Порт debug SOCKS')), E('dd', summary.debugSocksPort || '-'),
			E('dt', tr('TProxy port', 'Порт TProxy')), E('dd', summary.tproxyPort || '-'),
			E('dt', tr('Log level', 'Уровень логов')), E('dd', summary.logLevel || '-')
		]));

		this.connectionAddress.value = summary.proxyAddress || '';
		this.connectionPort.value = summary.proxyPort || '';
		this.connectionUuid.value = summary.uuid || '';
		this.connectionServerName.value = summary.serverName || '';
		this.connectionFingerprint.value = summary.fingerprint || 'chrome';
		this.connectionPublicKey.value = summary.publicKey || '';
		this.connectionShortId.value = summary.shortId || '';
		this.connectionSpiderX.value = summary.spiderX || '/';
		this.connectionLogLevel.value = summary.logLevel || 'info';

		this.routingInfo.textContent = summary.proxyDomains.length ? summary.proxyDomains.map(function(item) { return String(item).replace(/^domain:/, ''); }).join(', ') : '-';
		this.routingStatus.textContent = openaiTest ? (openaiTest.status + ' · ' + (openaiTest.http || '-')) : tr('Not run yet', 'Ещё не запускался');
		this.routingStatus.className = openaiTest ? ('cbi-value-field ' + (openaiTest.status === 'ok' ? 'xr-status-ok' : 'xr-status-error')) : 'cbi-value-field xr-status-warn';
		this.directStatus.textContent = directTest ? (directTest.status + ' · ' + (directTest.http || '-')) : tr('Not run yet', 'Ещё не запускался');
		this.directStatus.className = directTest ? ('cbi-value-field ' + (directTest.status === 'ok' ? 'xr-status-ok' : 'xr-status-error')) : 'cbi-value-field xr-status-warn';
		this.restoreStatus.textContent = statusState.lastRestore ? ((statusState.lastRestore.at || '-') + ' · ' + (statusState.lastRestore.path || '-')) : '-';
		this.backupStatus.textContent = latestBackup || (statusState.lastBackup && statusState.lastBackup.path) || '-';

		this.dnsInfo.innerHTML = '';
		this.dnsInfo.appendChild(E('dl', { 'class': 'xr-kv' }, [
			E('dt', tr('Listen address', 'Адрес прослушивания')), E('dd', dnsSummary.listenAddr || '-'),
			E('dt', tr('force_dns', 'force_dns')), E('dd', dnsSummary.forceDns || '-'),
			E('dt', tr('Primary resolver', 'Основной резолвер')), E('dd', dnsSummary.resolvers[0] && dnsSummary.resolvers[0].resolver_url ? dnsSummary.resolvers[0].resolver_url : '-'),
			E('dt', tr('Backup resolver', 'Резервный резолвер')), E('dd', dnsSummary.resolvers[1] && dnsSummary.resolvers[1].resolver_url ? dnsSummary.resolvers[1].resolver_url : '-'),
			E('dt', tr('dnsmasq state', 'Состояние dnsmasq')), E('dd', trimText(dnsmasqRes.stdout || dnsmasqRes.stderr || '') || '-')
		]));
	},

	renderServiceBox: function(status) {
		var self = this;
		var serviceName = status.name;
		var actions = Array.isArray(status.actions) ? status.actions : [];

		return E('div', { 'class': 'cbi-section xr-service-box' }, [
			E('h3', serviceName),
			E('p', { 'class': 'cbi-section-descr' }, [
				(status.runtimeTitle || tr('Process', 'Процесс')) + ': ' + (status.runtimeState || '-'),
				E('br'),
				tr('Autostart', 'Автозапуск') + ': ' + getAutostartLabel(!!status.autostartEnabled),
				E('br'),
				tr('Detail', 'Деталь') + ': ' + (status.detail || '-')
			]),
			E('div', { 'class': 'cbi-section-node xr-service-actions' }, actions.map(function(item) {
				return E('button', {
					'class': 'btn cbi-button ' + getServiceActionClass(item.action) + (item.wide ? ' xr-service-action-wide' : '') + (item.extraClass ? ' ' + item.extraClass : ''),
					'title': item.label,
					'click': ui.createHandlerFn(self, function(ev) {
						if (ev && ev.currentTarget)
							ev.currentTarget.blur();
						return ensureInitAction(serviceName, item.action).then(function() {
							self.notifyInfo(tr('Ran %s %s', 'Выполнено %s %s').format(serviceName, item.action));
							return self.refreshAll();
						}).catch(function(err) {
							self.notifyError(tr('Unable to run service action', 'Не удалось выполнить действие сервиса'), err);
						});
					})
				}, item.label);
			}))
		]);
	},

	handleRestartStack: function(ev) {
		var self = this;
		if (ev && ev.currentTarget)
			ev.currentTarget.blur();

		return ensureInitAction('xray-split', 'restart').then(function() {
			return ensureInitAction('xray', 'restart');
		}).then(function() {
			return safeExec('/etc/init.d/firewall', [ 'reload' ]);
		}).then(function(res) {
			if (res.code !== 0)
				throw new Error(trimText((res.stdout || '') + '\n' + (res.stderr || '')) || 'firewall reload failed');
			self.notifyInfo(tr('Restarted xray-split, xray and reloaded firewall.', 'Перезапущены xray-split, xray и перезагружен firewall.'));
			return self.refreshAll();
		}).catch(function(err) {
			self.notifyError(tr('Unable to restart stack', 'Не удалось перезапустить стек'), err);
		});
	},

	handleSaveConnection: function(ev) {
		var self = this;
		if (ev && ev.currentTarget)
			ev.currentTarget.blur();

		var currentParse = parseJsonText(this.configArea.value || '{}');
		if (!currentParse.ok) {
			self.notifyError(tr('Current config is not valid JSON', 'Текущий конфиг не является валидным JSON'), currentParse.error);
			return Promise.resolve();
		}

		var fields = {
			address: trimText(this.connectionAddress.value),
			port: trimText(this.connectionPort.value),
			uuid: trimText(this.connectionUuid.value),
			serverName: trimText(this.connectionServerName.value),
			fingerprint: trimText(this.connectionFingerprint.value) || 'chrome',
			publicKey: trimText(this.connectionPublicKey.value),
			shortId: trimText(this.connectionShortId.value),
			spiderX: trimText(this.connectionSpiderX.value) || '/',
			logLevel: trimText(this.connectionLogLevel.value) || 'info'
		};

		if (!fields.address || !fields.port || !fields.uuid || !fields.serverName || !fields.publicKey) {
			self.notifyError(tr('Connection settings are incomplete', 'Настройки соединения заполнены не полностью'), tr('Address, port, UUID, serverName and publicKey are required.', 'Нужны address, port, UUID, serverName и publicKey.'));
			return Promise.resolve();
		}
		if (!/^\d+$/.test(fields.port)) {
			self.notifyError(tr('Port must be numeric', 'Порт должен быть числом'), fields.port);
			return Promise.resolve();
		}

		var nextConfig = updateConnectionSettings(currentParse.value, fields);
		var nextText = JSON.stringify(nextConfig, null, 2) + '\n';
		var tempPath = '/tmp/xray-luci-validate.json';

		return fs.write(tempPath, nextText).then(function() {
			return safeExec('/usr/bin/xray', [ 'run', '-test', '-config', tempPath ]);
		}).then(function(res) {
			if (res.code !== 0)
				throw new Error(trimText((res.stdout || '') + '\n' + (res.stderr || '')) || 'xray test failed');
			return fs.write('/etc/xray/config.json', nextText);
		}).then(function() {
			return ensureInitAction('xray', 'restart');
		}).then(function() {
			self.notifyInfo(tr('Connection settings saved and Xray restarted.', 'Настройки соединения сохранены, Xray перезапущен.'));
			return self.refreshAll();
		}).catch(function(err) {
			self.notifyError(tr('Unable to save connection settings', 'Не удалось сохранить настройки соединения'), err);
		});
	},

	handleSaveRouting: function(ev) {
		var self = this;
		if (ev && ev.currentTarget)
			ev.currentTarget.blur();

		var currentParse = parseJsonText(this.data[5] || '{}');
		var rule = currentParse.ok && proxyDomainRule(currentParse.value);
		if (!rule) {
			self.notifyError(tr('Proxy domain list is unavailable', 'Список proxy-доменов недоступен'), currentParse.error);
			return Promise.resolve();
		}

		var request = { previous: rule.domain, domains: normalizeDomainInput(this.routingArea.value || '', rule.domain) };
		var tempPath = '/tmp/xray-luci-routing.json';
		return fs.write(tempPath, JSON.stringify(request) + '\n').then(function() {
			return safeExec('/bin/sh', [ '-c', 'exec /usr/libexec/xray-route-domain set-domains /tmp/xray-luci-routing.json' ]);
		}).then(function(res) {
			if (res.code !== 0)
				throw new Error(trimText((res.stdout || '') + '\n' + (res.stderr || '')) || 'routing update failed');
			self.notifyInfo(tr('Routing domains saved in all profiles.', 'Домены маршрутизации сохранены во всех профилях.'));
			return self.refreshAll();
		}).catch(function(err) {
			self.notifyError(tr('Unable to save routing domains', 'Не удалось сохранить домены маршрутизации'), err);
		});
	},

	handleSaveDnsConfig: function(ev) {
		var self = this;
		if (ev && ev.currentTarget)
			ev.currentTarget.blur();

		var raw = normalizeText(this.dnsConfigArea.value || '');
		return fs.write('/etc/config/https-dns-proxy', raw).then(function() {
			return ensureInitAction('https-dns-proxy', 'restart');
		}).then(function() {
			self.notifyInfo(tr('Saved /etc/config/https-dns-proxy and restarted HTTPS DNS Proxy.', 'Сохранён /etc/config/https-dns-proxy и перезапущен HTTPS DNS Proxy.'));
			return self.refreshAll();
		}).catch(function(err) {
			self.notifyError(tr('Unable to save HTTPS DNS Proxy config', 'Не удалось сохранить конфиг HTTPS DNS Proxy'), err);
		});
	},

	handleSaveFirewallFile: function(path, textarea, label, ev) {
		var self = this;
		if (ev && ev.currentTarget)
			ev.currentTarget.blur();

		var newText = normalizeText(textarea.value || '');
		var oldText = '';
		return fs.read(path).catch(function() { return ''; }).then(function(currentText) {
			oldText = normalizeText(currentText || '');
			return fs.write(path, newText);
		}).then(function() {
			return safeExec('/sbin/fw4', [ 'check' ]);
		}).then(function(res) {
			if (res.code !== 0) {
				return fs.write(path, oldText).then(function() {
					throw new Error(trimText((res.stdout || '') + '\n' + (res.stderr || '')) || 'fw4 check failed');
				});
			}
			return safeExec('/etc/init.d/firewall', [ 'reload' ]).then(function(reloadRes) {
				if (reloadRes.code !== 0)
					throw new Error(trimText((reloadRes.stdout || '') + '\n' + (reloadRes.stderr || '')) || 'firewall reload failed');
				return ensureInitAction('xray-split', 'restart');
			}).then(function() {
				self.notifyInfo(tr('Saved %s, firewall check passed and firewall reloaded.', 'Сохранён %s, проверка firewall пройдена и firewall перезагружен.').format(label));
				return self.refreshAll();
			});
		}).catch(function(err) {
			self.notifyError(tr('Unable to save %s', 'Не удалось сохранить %s').format(label), err);
		});
	},

	handleSaveRawConfig: function(ev) {
		var self = this;
		if (ev && ev.currentTarget)
			ev.currentTarget.blur();

		var parse = parseJsonText(this.configArea.value || '{}');
		if (!parse.ok) {
			self.notifyError(tr('Config JSON is invalid', 'JSON конфига невалиден'), parse.error);
			return Promise.resolve();
		}
		var text = JSON.stringify(parse.value, null, 2) + '\n';
		var tempPath = '/tmp/xray-luci-raw.json';
		return fs.write(tempPath, text).then(function() {
			return safeExec('/usr/bin/xray', [ 'run', '-test', '-config', tempPath ]);
		}).then(function(res) {
			if (res.code !== 0)
				throw new Error(trimText((res.stdout || '') + '\n' + (res.stderr || '')) || 'xray test failed');
			return fs.write('/etc/xray/config.json', text);
		}).then(function() {
			return ensureInitAction('xray', 'restart');
		}).then(function() {
			self.notifyInfo(tr('Raw Xray config saved and validated.', 'Raw-конфиг Xray сохранён и проверен.'));
			return self.refreshAll();
		}).catch(function(err) {
			self.notifyError(tr('Unable to save raw Xray config', 'Не удалось сохранить raw-конфиг Xray'), err);
		});
	},

	handleBackupConfig: function(ev) {
		var self = this;
		if (ev && ev.currentTarget)
			ev.currentTarget.blur();

		return safeExec('/bin/sh', [ '-c', 'ts=$(date +%Y%m%d-%H%M%S); d=/etc/xray/luci-backups/$ts; mkdir -p "$d"; cp -a /etc/xray/config.json "$d/"; cp -a /etc/xray/90-xray-tproxy-table.nft "$d/"; cp -a /etc/xray/91-xray-tproxy-prerouting.nft "$d/"; [ -e /etc/config/https-dns-proxy ] && cp -a /etc/config/https-dns-proxy "$d/https-dns-proxy" || true; printf "%s\n" "$d"' ]).then(function(res) {
			if (res.code !== 0)
				throw new Error(trimText((res.stdout || '') + '\n' + (res.stderr || '')) || 'backup failed');
			var path = trimText(res.stdout || res.stderr || '');
			var state = self.statusState || {};
			state.lastBackup = { path: path, at: new Date().toISOString() };
			self.statusState = state;
			return self.writeStatusState(state).then(function() {
				self.notifyInfo(tr('Backup created: %s', 'Создан backup: %s').format(path));
				return self.refreshAll();
			});
		}).catch(function(err) {
			self.notifyError(tr('Unable to create backup', 'Не удалось создать backup'), err);
		});
	},

	handleRestoreBackup: function(ev) {
		var self = this;
		if (ev && ev.currentTarget)
			ev.currentTarget.blur();

		return safeExec('/bin/sh', [ '-c', 'd=$(ls -1dt /etc/xray/luci-backups/* 2>/dev/null | head -n 1); [ -n "$d" ] || { echo "No backups found"; exit 2; }; [ -e "$d/config.json" ] && cp -a "$d/config.json" /etc/xray/config.json; [ -e "$d/90-xray-tproxy-table.nft" ] && cp -a "$d/90-xray-tproxy-table.nft" /etc/xray/90-xray-tproxy-table.nft; [ -e "$d/91-xray-tproxy-prerouting.nft" ] && cp -a "$d/91-xray-tproxy-prerouting.nft" /etc/xray/91-xray-tproxy-prerouting.nft; [ -e "$d/https-dns-proxy" ] && cp -a "$d/https-dns-proxy" /etc/config/https-dns-proxy || true; /etc/init.d/https-dns-proxy restart >/dev/null 2>&1 || true; /etc/init.d/xray restart >/dev/null 2>&1 || true; /etc/init.d/xray-split restart >/dev/null 2>&1 || true; /etc/init.d/firewall reload >/dev/null 2>&1 || true; printf "%s\n" "$d"' ]).then(function(res) {
			if (res.code !== 0)
				throw new Error(trimText((res.stdout || '') + '\n' + (res.stderr || '')) || 'restore failed');
			var path = trimText(res.stdout || res.stderr || '');
			var state = self.statusState || {};
			state.lastRestore = { path: path, at: new Date().toISOString() };
			self.statusState = state;
			return self.writeStatusState(state).then(function() {
				self.notifyInfo(tr('Restored latest backup: %s', 'Восстановлен последний backup: %s').format(path));
				return self.refreshAll();
			});
		}).catch(function(err) {
			self.notifyError(tr('Unable to restore latest backup', 'Не удалось восстановить последний backup'), err);
		});
	},

	handleRouteTest: function(kind, ev) {
		var self = this;
		if (ev && ev.currentTarget)
			ev.currentTarget.blur();

		var parse = parseJsonText(this.configArea.value || '{}');
		if (!parse.ok) {
			self.notifyError(tr('Current config is not valid JSON', 'Текущий конфиг не является валидным JSON'), parse.error);
			return Promise.resolve();
		}

		var summary = extractSummary(parse.value);
		var port = summary.debugSocksPort || '10808';
		var target = (kind === 'openai') ? 'https://chatgpt.com' : 'https://example.com';
		var expectedRoute = (kind === 'openai') ? 'proxy' : 'direct';
		var state = self.statusState || {};

		return safeExec('/usr/bin/curl', [ '-k', '-I', '--socks5-hostname', '127.0.0.1:' + port, '--max-time', '20', target ]).then(function(res) {
			var output = trimText((res.stdout || '') + '\n' + (res.stderr || ''));
			var httpLine = (output.match(/HTTP\/[0-9.]+\s+\d+/m) || [ '' ])[0];
			return safeExec('/sbin/logread', [ '-e', 'debug-socks -> ' + expectedRoute, '-e', 'accepted tcp:', '-e', 'chatgpt.com', '-e', 'example.com' ]).then(function(logRes) {
				var combinedLog = trimText((logRes.stdout || '') + '\n' + (logRes.stderr || ''));
				var routeLines = combinedLog.split(/\n/).filter(function(line) {
					return line.indexOf('debug-socks -> ' + expectedRoute) >= 0;
				});
				var routeLine = routeLines.length ? routeLines[routeLines.length - 1] : '';
				var ok = false;
				var reason = routeLine || tr('No matching log line', 'Нет подходящей строки в логах');

				if (kind === 'openai')
					ok = !!routeLine && !!httpLine;
				else
					ok = (!!routeLine && !!httpLine) || (!!routeLine && !httpLine) || (!!httpLine && routeLine.indexOf('debug-socks -> direct') >= 0);

				state.tests = state.tests || {};
				state.tests[kind] = {
					target: target,
					status: ok ? 'ok' : 'error',
					route: expectedRoute,
					http: httpLine || tr('No HTTP line', 'Нет HTTP-строки'),
					log: reason,
					at: new Date().toISOString()
				};
				self.statusState = state;
				return self.writeStatusState(state).then(function() {
					self.setOutput((httpLine || output || '') + '\n\n' + (routeLine || combinedLog || ''));
					return self.refreshAll();
				});
			});
		}).catch(function(err) {
			self.notifyError(tr('Route test failed: %s', 'Тест маршрута не удался: %s').format(kind), err);
		});
	},

	render: function(data) {
		var self = this;
		this.data = data;
		this.activeTab = this.activeTab || 'connection';

		this.serviceOverview = E('div');
		this.connectionInfo = E('div');
		this.routingInfo = E('div', '-');
		this.routingStatus = E('span', '-');
		this.directStatus = E('span', '-');
		this.restoreStatus = E('span', '-');
		this.backupStatus = E('span', '-');
		this.dnsInfo = E('div');

		this.connectionAddress = E('input', { 'class': 'cbi-input-text', 'type': 'text' });
		this.connectionPort = E('input', { 'class': 'cbi-input-text', 'type': 'text' });
		this.connectionUuid = E('input', { 'class': 'cbi-input-text', 'type': 'text' });
		this.connectionServerName = E('input', { 'class': 'cbi-input-text', 'type': 'text' });
		this.connectionFingerprint = E('input', { 'class': 'cbi-input-text', 'type': 'text' });
		this.connectionPublicKey = E('input', { 'class': 'cbi-input-text', 'type': 'text' });
		this.connectionShortId = E('input', { 'class': 'cbi-input-text', 'type': 'text' });
		this.connectionSpiderX = E('input', { 'class': 'cbi-input-text', 'type': 'text' });
		this.connectionLogLevel = E('select', { 'class': 'cbi-input-select' }, [
			E('option', { 'value': 'debug' }, 'debug'),
			E('option', { 'value': 'info' }, 'info'),
			E('option', { 'value': 'warning' }, 'warning'),
			E('option', { 'value': 'error' }, 'error')
		]);

		this.routingArea = E('textarea', { 'class': 'cbi-input-textarea', 'rows': 12 });
		this.tableArea = E('textarea', { 'class': 'cbi-input-textarea', 'rows': 12 });
		this.preroutingArea = E('textarea', { 'class': 'cbi-input-textarea', 'rows': 8 });
		this.dnsConfigArea = E('textarea', { 'class': 'cbi-input-textarea', 'rows': 14 });
		this.configArea = E('textarea', { 'class': 'cbi-input-textarea', 'rows': 20 });
		this.xrayLogArea = E('textarea', { 'class': 'cbi-input-textarea xr-log', 'readonly': 'readonly' });
		this.dnsLogArea = E('textarea', { 'class': 'cbi-input-textarea xr-log', 'readonly': 'readonly' });
		this.outputArea = E('textarea', { 'class': 'cbi-input-textarea xr-log', 'readonly': 'readonly' });

		var tabGroup = E('div');

		function makeTab(name, tabTitle, description, children) {
			return E('div', {
				'data-tab': name,
				'data-tab-title': tabTitle,
				'data-tab-active': (self.activeTab === name) ? 'true' : 'false'
			}, [
				E('div', { 'class': 'cbi-section' }, [
					E('h3', tabTitle),
					E('p', { 'class': 'cbi-section-descr' }, description)
				]),
				children
			]);
		}

		var root = E('div', { 'class': 'cbi-map xr-native' }, [
			E('h2', tr('Xray', 'Xray')),
			E('p', { 'class': 'cbi-section-descr' }, tr('Native-style control surface for Xray split routing on Flint. Service actions stay immediate; editors are grouped by operational area.', 'Панель управления Xray в более нативном стиле LuCI. Действия сервисов остаются мгновенными, редакторы сгруппированы по операционным зонам.')),
			E('div', { 'class': 'cbi-section' }, [
				E('h3', tr('Services', 'Сервисы')),
				E('p', { 'class': 'cbi-section-descr' }, tr('Runtime actions affect the current process now; autostart only changes what happens after the router reboots.', 'Кнопки запуска/остановки меняют текущее состояние сервиса сейчас; автозапуск влияет только на поведение после перезагрузки роутера.')),
				E('div', { 'class': 'cbi-section-node' }, [ this.serviceOverview ])
			]),
			tabGroup,
			makeTab('connection', tr('Connection settings', 'Настройки соединения'), tr('Edit VLESS/REALITY parameters and keep raw JSON available as an advanced block.', 'Редактирование параметров VLESS/REALITY с сохранением raw JSON в advanced-блоке.'), E('div', {}, [
				E('div', { 'class': 'cbi-section' }, [
					E('h3', tr('Current summary', 'Текущая сводка')),
					E('div', { 'class': 'cbi-section-node' }, [ this.connectionInfo ])
				]),
				E('div', { 'class': 'cbi-section' }, [
					E('h3', tr('VLESS / REALITY', 'VLESS / REALITY')),
					E('div', { 'class': 'cbi-section-node' }, [
						makeField(tr('Address', 'Address'), this.connectionAddress),
						makeField(tr('Port', 'Port'), this.connectionPort),
						makeField(tr('UUID', 'UUID'), this.connectionUuid),
						makeField(tr('serverName', 'serverName'), this.connectionServerName),
						makeField(tr('Fingerprint', 'Fingerprint'), this.connectionFingerprint),
						makeField(tr('Public key', 'Public key'), this.connectionPublicKey),
						makeField(tr('Short ID', 'Short ID'), this.connectionShortId),
						makeField(tr('SpiderX', 'SpiderX'), this.connectionSpiderX),
						makeField(tr('Log level', 'Уровень логов'), this.connectionLogLevel),
						E('div', { 'class': 'xr-actions' }, [
							E('button', { 'class': 'btn cbi-button cbi-button-save', 'click': ui.createHandlerFn(this, function(ev) { return self.handleSaveConnection(ev); }) }, tr('Save connection settings', 'Сохранить настройки соединения'))
						]),
						E('p', { 'class': 'cbi-section-descr xr-inline-note' }, tr('The config is validated with xray run -test before replacing /etc/xray/config.json.', 'Перед заменой /etc/xray/config.json конфиг проверяется через xray run -test.'))
					])
				]),
				E('details', { 'class': 'cbi-section xr-advanced' }, [
					E('summary', tr('Advanced: raw /etc/xray/config.json', 'Advanced: raw /etc/xray/config.json')),
					E('div', { 'class': 'cbi-section-node' }, [
						makeWideField(tr('Raw config JSON', 'Raw JSON конфига'), this.configArea),
						E('div', { 'class': 'xr-actions' }, [
							E('button', { 'class': 'btn cbi-button cbi-button-save', 'click': ui.createHandlerFn(this, function(ev) { return self.handleSaveRawConfig(ev); }) }, tr('Save raw config', 'Сохранить raw-конфиг'))
						])
					])
				])
			])),
			makeTab('routing', tr('Routing', 'Маршрутизация'), tr('Maintain the proxy domain list, create/restore backups, and run route tests.', 'Управление списком proxy-доменов, backup/restore и тестами маршрутизации.'), E('div', {}, [
				E('div', { 'class': 'cbi-section' }, [
					E('h3', tr('Proxy domain list', 'Список proxy-доменов')),
					E('div', { 'class': 'cbi-section-node' }, [
						E('p', { 'class': 'cbi-section-descr' }, [ tr('Current domains: ', 'Текущие домены: '), this.routingInfo ]),
						makeWideField(tr('One hostname per line', 'Один hostname на строку'), this.routingArea),
						E('div', { 'class': 'xr-actions' }, [
							E('button', { 'class': 'btn cbi-button cbi-button-save', 'click': ui.createHandlerFn(this, function(ev) { return self.handleSaveRouting(ev); }) }, tr('Save routing domains', 'Сохранить домены маршрутизации'))
						])
					])
				]),
				E('div', { 'class': 'cbi-section' }, [
					E('h3', tr('Backups and tests', 'Backup и тесты')),
					E('div', { 'class': 'cbi-section-node' }, [
						E('div', { 'class': 'xr-grid' }, [
							E('div', { 'class': 'cbi-value' }, [ E('label', { 'class': 'cbi-value-title' }, tr('Latest backup', 'Последний backup')), E('div', { 'class': 'cbi-value-field' }, [ this.backupStatus ]) ]),
							E('div', { 'class': 'cbi-value' }, [ E('label', { 'class': 'cbi-value-title' }, tr('Last restore', 'Последнее восстановление')), E('div', { 'class': 'cbi-value-field' }, [ this.restoreStatus ]) ]),
							E('div', { 'class': 'cbi-value' }, [ E('label', { 'class': 'cbi-value-title' }, tr('OpenAI route test', 'Тест маршрута OpenAI')), E('div', { 'class': 'cbi-value-field' }, [ this.routingStatus ]) ]),
							E('div', { 'class': 'cbi-value' }, [ E('label', { 'class': 'cbi-value-title' }, tr('Direct route test', 'Тест direct-маршрута')), E('div', { 'class': 'cbi-value-field' }, [ this.directStatus ]) ])
						]),
						E('div', { 'class': 'xr-actions' }, [
							E('button', { 'class': 'btn cbi-button cbi-button-action', 'click': ui.createHandlerFn(this, function(ev) { return self.handleBackupConfig(ev); }) }, tr('Backup current config', 'Сделать backup текущего конфига')),
							E('button', { 'class': 'btn cbi-button cbi-button-action', 'click': ui.createHandlerFn(this, function(ev) { return self.handleRestoreBackup(ev); }) }, tr('Restore latest backup', 'Восстановить последний backup')),
							E('button', { 'class': 'btn cbi-button cbi-button-apply', 'click': ui.createHandlerFn(this, function(ev) { return self.handleRouteTest('openai', ev); }) }, tr('Test OpenAI route', 'Проверить маршрут OpenAI')),
							E('button', { 'class': 'btn cbi-button cbi-button-apply', 'click': ui.createHandlerFn(this, function(ev) { return self.handleRouteTest('direct', ev); }) }, tr('Test direct route', 'Проверить direct-маршрут'))
						]),
						E('p', { 'class': 'cbi-section-descr xr-inline-note' }, tr('OpenAI test now accepts HTTP 403 as valid when the debug SOCKS traffic was actually routed to proxy. Direct test looks for the route decision itself instead of requiring a too-specific host log line.', 'Тест OpenAI теперь принимает HTTP 403 как валидный результат, если трафик debug SOCKS действительно ушёл в proxy. Direct-тест ориентируется на сам route-decision, а не на слишком специфичную строку хоста в логах.'))
					])
				])
			])),
			makeTab('dns', tr('DNS', 'DNS'), tr('HTTPS DNS Proxy overview and raw config editor.', 'Сводка по HTTPS DNS Proxy и raw-редактор конфигурации.'), E('div', {}, [
				E('div', { 'class': 'cbi-section' }, [
					E('h3', tr('Resolver summary', 'Сводка резолверов')),
					E('div', { 'class': 'cbi-section-node' }, [ this.dnsInfo ])
				]),
				E('div', { 'class': 'cbi-section' }, [
					E('h3', tr('Raw /etc/config/https-dns-proxy', 'Raw /etc/config/https-dns-proxy')),
					E('div', { 'class': 'cbi-section-node' }, [
						makeWideField(tr('HTTPS DNS Proxy config', 'Конфиг HTTPS DNS Proxy'), this.dnsConfigArea),
						E('div', { 'class': 'xr-actions' }, [
							E('button', { 'class': 'btn cbi-button cbi-button-save', 'click': ui.createHandlerFn(this, function(ev) { return self.handleSaveDnsConfig(ev); }) }, tr('Save DNS config', 'Сохранить DNS-конфиг'))
						])
					])
				])
			])),
			makeTab('firewall', tr('Firewall', 'Firewall'), tr('Edit the fw4 include fragments used by the Xray TProxy policy.', 'Редактирование fw4 include-фрагментов для политики Xray TProxy.'), E('div', {}, [
				E('div', { 'class': 'cbi-section' }, [
					E('h3', '/etc/xray/90-xray-tproxy-table.nft'),
					E('div', { 'class': 'cbi-section-node' }, [
						makeWideField(tr('Table include', 'Table include'), this.tableArea),
						E('div', { 'class': 'xr-actions' }, [
							E('button', { 'class': 'btn cbi-button cbi-button-save', 'click': ui.createHandlerFn(this, function(ev) { return self.handleSaveFirewallFile('/etc/xray/90-xray-tproxy-table.nft', self.tableArea, '/etc/xray/90-xray-tproxy-table.nft', ev); }) }, tr('Save table include', 'Сохранить table include'))
						])
					])
				]),
				E('div', { 'class': 'cbi-section' }, [
					E('h3', '/etc/xray/91-xray-tproxy-prerouting.nft'),
					E('div', { 'class': 'cbi-section-node' }, [
						makeWideField(tr('Prerouting include', 'Prerouting include'), this.preroutingArea),
						E('div', { 'class': 'xr-actions' }, [
							E('button', { 'class': 'btn cbi-button cbi-button-save', 'click': ui.createHandlerFn(this, function(ev) { return self.handleSaveFirewallFile('/etc/xray/91-xray-tproxy-prerouting.nft', self.preroutingArea, '/etc/xray/91-xray-tproxy-prerouting.nft', ev); }) }, tr('Save prerouting include', 'Сохранить prerouting include'))
						])
					])
				])
			])),
			makeTab('logs', tr('Logs and command output', 'Логи и вывод команд'), tr('Validation results, test output, and short tails of related logs.', 'Результаты валидации, вывод тестов и короткие хвосты связанных логов.'), E('div', {}, [
				E('div', { 'class': 'cbi-section' }, [
					E('h3', tr('Last command output', 'Последний вывод команды')),
					E('div', { 'class': 'cbi-section-node' }, [ makeWideField(tr('Output', 'Вывод'), this.outputArea) ])
				]),
				E('div', { 'class': 'cbi-section' }, [
					E('h3', 'logread -e xray'),
					E('div', { 'class': 'cbi-section-node' }, [ makeWideField(tr('Xray log tail', 'Хвост логов Xray'), this.xrayLogArea) ])
				]),
				E('div', { 'class': 'cbi-section' }, [
					E('h3', 'logread -e https-dns-proxy'),
					E('div', { 'class': 'cbi-section-node' }, [ makeWideField(tr('HTTPS DNS Proxy log tail', 'Хвост логов HTTPS DNS Proxy'), this.dnsLogArea) ])
				])
			]))
		]);

		Array.prototype.slice.call(root.childNodes).forEach(function(node) {
			if (node && node.getAttribute && node.hasAttribute('data-tab-title'))
				tabGroup.appendChild(node);
		});

		ui.tabs.initTabGroup(tabGroup.childNodes);
		ui.tabs.updateTabs(null, root);
		this.applyData(data);
		return root;
	},

	handleSave: null,
	handleSaveApply: null,
	handleReset: null
});
