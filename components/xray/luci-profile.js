'use strict';
'require view';
'require fs';
'require ui';
'require poll';

var SCRIPT = '/usr/bin/xray-profile';

function tr(en, ru) {
	var lang = '';

	try {
		lang = String((L.env && (L.env.lang || L.env.i18nLanguage)) || document.documentElement.lang || navigator.language || '').toLowerCase();
	} catch (e) {}

	return /^ru([_-]|$)/.test(lang) ? ru : en;
}

function execProfile(args) {
	return fs.exec(SCRIPT, args || []).then(function(res) {
		if (res.code !== 0)
			throw new Error(String(res.stderr || res.stdout || ('exit code ' + res.code)).trim());

		return res;
	});
}

function parseStatus(text) {
	var status = {
		recorded: '',
		detected: '',
		services: [],
		health: [], guard: 'waiting'
	};

	String(text || '').replace(/\r/g, '').split('\n').forEach(function(line) {
		var match;
		match = line.match(/^TLS guard: (active|waiting)$/);
		if (match) { status.guard = match[1]; return; }
		match = line.match(/^TLS health: (\d+) ([a-z0-9][a-z0-9.-]*[a-z0-9]) (observing|confirmed|suspect|trial|unresolved|retry|fallback) (zapret|split|direct|vpn) (\d+)$/);
		if (match) {
			status.health.push({ time: Number(match[1]), host: match[2], state: match[3], mode: match[4], failures: Number(match[5]) });
			return;
		}

		match = line.match(/^Recorded active profile:\s*(.+)$/);
		if (match) {
			status.recorded = match[1];
			return;
		}

		match = line.match(/^Detected live profile:\s*(.+)$/);
		if (match) {
			status.detected = match[1];
			return;
		}

		match = line.match(/^\s*([A-Za-z0-9_.-]+)\s+runtime=([A-Za-z0-9_.-]+)\s+autostart=([A-Za-z0-9_.-]+)$/);
		if (match) {
			status.services.push({
				name: match[1],
				runtime: match[2],
				autostart: match[3]
			});
		}
	});

	return status;
}

function statusLabel(value) {
	switch (value) {
	case 'active':
		return tr('active', 'активна');
	case 'inactive':
		return tr('inactive', 'остановлена');
	case 'yes':
		return tr('yes', 'да');
	case 'no':
		return tr('no', 'нет');
	default:
		return value || tr('unknown', 'неизвестно');
	}
}

function profileLabel(value) {
	if (/^main(?:-|$)/.test(value))
		return tr('Main VDS', 'Основной VDS');
	if (value === 'backup' || value === 'backup-spacevpn-nl')
		return tr('Netherlands', 'Нидерланды');
	if (value === 'backup2' || value === 'backup-spacevpn-de')
		return tr('Germany', 'Германия');
	return value || tr('unknown', 'неизвестно');
}

function buttonClass(kind) {
	if (kind === 'local')
		return 'btn cbi-button-neutral';
	if (kind === 'backup' || kind === 'backup2')
		return 'btn cbi-button-action important';
	return 'btn cbi-button-action';
}

function setBusy(button, busy) {
	if (!button)
		return;

	button.disabled = !!busy;
	button.classList.toggle('spinning', !!busy);
}

function outputBlock(text) {
	return E('pre', {
		'style': 'white-space:pre-wrap;max-height:260px;overflow:auto'
	}, text || '');
}

return view.extend({
	load: function() {
		return execProfile([ 'status' ]).catch(function(err) {
			return { code: -1, stdout: '', stderr: err ? (err.message || String(err)) : '' };
		});
	},

	handleRefresh: function(ev) {
		var button = ev.currentTarget;
		setBusy(button, true);

		return execProfile([ 'status' ]).then(L.bind(function(res) {
			this.updateStatus(parseStatus(res.stdout));
			this.setOutput(res.stdout);
		}, this)).catch(function(err) {
			ui.addNotification(null, E('p', err.message || String(err)), 'danger');
		}).finally(function() {
			setBusy(button, false);
		});
	},

	handleSwitch: function(mode, ev) {
		var button = ev.currentTarget;
		var confirmText = mode === 'local'
			? tr('Stop router Xray services for local V2RayTun mode?', 'Остановить роутерные службы Xray для режима локального V2RayTun?')
			: tr('Switch router Xray to ', 'Переключить роутерный Xray на «') + profileLabel(mode) +
				tr('? Connections will briefly reconnect.', '»? Соединения ненадолго переподключатся.');

		if (!confirm(confirmText))
			return Promise.resolve();

		setBusy(button, true);
		this.setOutput(tr('Running command...', 'Выполняю команду...'));

		return execProfile([ mode ]).then(L.bind(function(res) {
			this.setOutput(res.stdout || tr('Done.', 'Готово.'));
			ui.addNotification(null, E('p', tr('Xray profile command completed.', 'Команда профиля Xray выполнена.')), 'info');
			return execProfile([ 'status' ]);
		}, this)).then(L.bind(function(res) {
			this.updateStatus(parseStatus(res.stdout));
		}, this)).catch(function(err) {
			var message = err.message || String(err);
			this.setOutput(message);
			ui.addNotification(null, E('p', message), 'danger');
		}.bind(this)).finally(function() {
			setBusy(button, false);
		});
	},

	setOutput: function(text) {
		if (!this.outputNode)
			return;

		while (this.outputNode.firstChild)
			this.outputNode.removeChild(this.outputNode.firstChild);

		this.outputNode.appendChild(outputBlock(String(text || '').replace(/main-(?:\d{1,3}\.){3}\d{1,3}/g, 'main')));
	},

	updateStatus: function(status) {
		var healthSnapshot = JSON.stringify([ status.guard, status.health ]);
		if (this.healthNode && this.healthSnapshot !== healthSnapshot) {
			this.healthSnapshot = healthSnapshot;
			while (this.healthNode.firstChild) this.healthNode.removeChild(this.healthNode.firstChild);
			this.healthNode.appendChild(E('p', {}, status.guard === 'active'
				? tr('TLS monitoring is active.', 'Наблюдение TLS включено.')
				: tr('TLS monitoring is unavailable. Observations below may be stale.', 'Наблюдение TLS недоступно. Сведения ниже могут быть устаревшими.')));
			var modes = { zapret: 'zapret', split: tr('zapret: segmentation', 'zapret: сегментация'), direct: tr('Direct', 'Прямое соединение'), vpn: tr('VPN fallback', 'VPN после проверки') };
			var states = {
				observing: tr('Waiting for TLS outcome', 'Ожидается результат TLS'),
				confirmed: tr('TLS continued', 'TLS-соединение продолжено'),
				suspect: tr('Connection failure observed', 'Замечен сбой соединения'),
				trial: tr('Repeated failures; testing an alternative', 'Повторные сбои; проверяется альтернатива'),
				unresolved: tr('All three paths failed; investigation needed', 'Три способа дали сбои; нужна проверка'),
				retry: tr('Retrying the preferred strategy', 'Повторная проверка основной стратегии'),
				fallback: tr('The complete resource succeeded through VPN after direct failures', 'Ресурс целиком загрузился через VPN после прямых сбоев')
			};
			if (!status.health.length) this.healthNode.appendChild(E('p', {}, tr('No TLS observations yet.', 'Наблюдений TLS пока нет.')));
			status.health.forEach(function(item) {
				this.healthNode.appendChild(E('div', {
					'class': /^(suspect|trial|unresolved)$/.test(item.state) ? 'alert-message warning' : '',
					'style': 'padding:8px 0;border-bottom:1px solid var(--border-color,#8884)' }, [
					E('strong', {}, item.host + ' — ' + modes[item.mode]),
					E('div', {}, states[item.state] + (item.failures ? ' (' + item.failures + ')' : '') + ' · ' +
						(item.time ? new Date(item.time * 1000).toLocaleString() : '—'))
				]));
			}, this);
		}
		if (this.recordedNode)
			this.recordedNode.textContent = profileLabel(status.recorded);

		if (this.detectedNode)
			this.detectedNode.textContent = profileLabel(status.detected);

		if (this.servicesNode) {
			while (this.servicesNode.firstChild)
				this.servicesNode.removeChild(this.servicesNode.firstChild);

			if (!status.services.length) {
				this.servicesNode.appendChild(E('em', tr('No service status available', 'Статус служб недоступен')));
			}
			else {
				status.services.forEach(function(service) {
					this.servicesNode.appendChild(E('tr', { 'class': 'tr' }, [
						E('td', { 'class': 'td left' }, service.name),
						E('td', { 'class': 'td left' }, statusLabel(service.runtime)),
						E('td', { 'class': 'td left' }, statusLabel(service.autostart))
					]));
				}, this);
			}
		}
	},

	render: function(res) {
		var status = parseStatus(res && res.stdout);
		var recordedNode = E('strong');
		var detectedNode = E('strong');
		var servicesNode = E('tbody');
		var outputNode = E('div');
		var healthNode = E('div', { 'role': 'status', 'aria-live': 'polite' });
		this.healthNode = healthNode;

		this.recordedNode = recordedNode;
		this.detectedNode = detectedNode;
		this.servicesNode = servicesNode;
		this.outputNode = outputNode;

		this.updateStatus(status);
		this.setOutput(res && res.stderr ? res.stderr : (res && res.stdout));
		poll.add(L.bind(function() {
			return execProfile([ 'status' ]).then(L.bind(function(next) {
				this.updateStatus(parseStatus(next.stdout));
			}, this)).catch(L.bind(function() {
				this.healthSnapshot = null;
				if (this.healthNode.firstChild) this.healthNode.firstChild.textContent = tr('Could not refresh connection status.', 'Не удалось обновить состояние соединений.');
			}, this));
		}, this), 15);

		return E([], [
			E('h2', {}, tr('Xray Profile', 'Профиль Xray')),
			E('p', { 'class': 'cbi-section-descr' }, tr(
				'Choose the main VDS or a SpaceVPN backup in the Netherlands or Germany.',
				'Выбери основной VDS или резервный канал SpaceVPN: Нидерланды либо Германия.'
			)),
			E('div', { 'class': 'cbi-section' }, [
				E('div', { 'style': 'margin-bottom:12px' }, [
					E('div', {}, [ tr('Selected profile: ', 'Выбранный профиль: '), recordedNode ]),
					E('div', {}, [ tr('Applied profile: ', 'Фактически применён: '), detectedNode ])
				]),
				E('table', { 'class': 'table' }, [
					E('thead', {}, E('tr', { 'class': 'tr table-titles' }, [
						E('th', { 'class': 'th left' }, tr('Service', 'Служба')),
						E('th', { 'class': 'th left' }, tr('Runtime', 'Сейчас')),
						E('th', { 'class': 'th left' }, tr('Autostart', 'Автозапуск'))
					])),
					servicesNode
				]),
				E('div', { 'style': 'display:flex;flex-wrap:wrap;gap:8px;margin:14px 0' }, [
					E('button', {
						'class': buttonClass('main'),
						'style': 'min-height:44px',
						'click': ui.createHandlerFn(this, 'handleSwitch', 'main')
					}, tr('Main VDS', 'Основной VDS')),
					E('button', {
						'class': buttonClass('backup'),
						'style': 'min-height:44px',
						'click': ui.createHandlerFn(this, 'handleSwitch', 'backup')
					}, tr('Backup: Netherlands', 'Резерв: Нидерланды')),
					E('button', {
						'class': buttonClass('backup2'),
						'style': 'min-height:44px',
						'click': ui.createHandlerFn(this, 'handleSwitch', 'backup2')
					}, tr('Backup: Germany', 'Резерв: Германия')),
					E('button', {
						'class': buttonClass('local'),
						'style': 'min-height:44px',
						'click': ui.createHandlerFn(this, 'handleSwitch', 'local')
					}, tr('Stop Xray', 'Отключить Xray')),
					E('button', {
						'class': 'btn cbi-button-reload',
						'style': 'min-height:44px',
						'click': ui.createHandlerFn(this, 'handleRefresh')
					}, tr('Refresh', 'Обновить'))
				]),
				E('p', { 'class': 'cbi-section-descr' }, tr(
					'Automatic priority: main → Netherlands → Germany. While the watchdog is running, a manually selected backup returns to the main profile after three successful recovery checks.',
					'Порядок автоматики: основной → Нидерланды → Германия. Пока автоматика активна, после ручного выбора резерва она вернёт основной профиль, когда он пройдёт три проверки восстановления.'
				))
			]),
			E('div', { 'class': 'cbi-section' }, [
				E('h3', {}, tr('Website connections', 'Соединения с сайтами')),
				E('p', {}, tr('Preference: configured zapret → zapret segmentation → direct. VPN is used only for a resource that failed directly and passed the full VPN check.',
					'Приоритет: текущий zapret → сегментация zapret → прямое соединение. VPN включается только для ресурса, который не загрузился напрямую и прошёл полную проверку через VPN.')),
				E('p', { 'class': 'cbi-section-descr' }, tr('Updates every 15 seconds. TLS observations do not verify page contents, HTTP errors, QUIC or calls.',
					'Обновление каждые 15 секунд. Эти наблюдения не проверяют содержимое страниц, ошибки HTTP, QUIC и звонки.')),
				healthNode
			]),
			E('div', { 'class': 'cbi-section' }, [
				E('h3', {}, tr('Command output', 'Вывод команды')),
				outputNode
			])
		]);
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
