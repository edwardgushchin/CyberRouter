const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

(async () => {
  const calls = [], writes = [], notices = [];
  let code = 0;
  const source = fs.readFileSync(process.argv[2] || path.join(__dirname,
    '../runtime/www/luci-static/resources/view/xray/status.js'), 'utf8');
  const { extractSummary, controller } = new Function('view', 'rpc', 'fs', 'ui',
    'document', 'window', 'navigator', 'L',
    source.replace('return view.extend({', 'const controller = view.extend({') +
    '\nreturn { extractSummary, controller };')(
      { extend: value => value }, { declare: () => () => {} }, {
        write: async (file, text) => writes.push([file, JSON.parse(text)]),
        exec: async (command, args) => { calls.push([command, args]); return {code, stderr: code ? 'stale list' : ''}; }
      }, {}, {}, {__xrayNativeStylesInjected: true}, {}, {});
  const avatar = {ruleTag: 'youtube-avatars-proxy', outboundTag: 'proxy',
    domain: ['domain:yt3.ggpht.com', 'domain:yt4.ggpht.com']};
  const common = {outboundTag: 'proxy', domain: ['domain:a.example', 'domain:b.example', 'domain:c.example']};
  const config = {routing: {rules: [avatar, common,
    {ruleTag: 'auto-refilter-domains', outboundTag: 'proxy', domain: ['ext:test:refilter']}]}};
  assert.deepEqual(extractSummary(config).proxyDomains, common.domain);
  common.ruleTag = 'common-proxy-domains';
  common.domain = ['domain:a.example', 'domain:geosite:LEGACY', 'domain:192.0.2.10'];
  config.routing.rules.push({outboundTag: 'proxy', domain: ['geosite:a', 'geosite:b', 'geosite:c', 'geosite:d']});
  assert.deepEqual(extractSummary(config).proxyDomains, common.domain, 'short list keeps its own rule');
  controller.data = [];
  controller.data[5] = JSON.stringify(config);
  controller.routingArea = {value: ' A.example\ngeosite:LEGACY\n192.0.2.10\nFlightradar24.com.\nflightradar24.com\n'};
  controller.notifyInfo = text => notices.push(['ok', text]);
  controller.notifyError = (text, error) => notices.push(['error', error.message]);
  controller.refreshAll = async () => calls.push(['refresh']);
  await controller.handleSaveRouting();
  assert.deepEqual(writes, [['/tmp/xray-luci-routing.json', {
    previous: common.domain, domains: [...common.domain, 'domain:flightradar24.com']
  }]]);
  const saveCommand = ['/bin/sh', ['-c', 'exec /usr/libexec/xray-route-domain set-domains /tmp/xray-luci-routing.json']];
  assert.deepEqual(calls, [saveCommand, ['refresh']]);
  assert.equal(notices[0][0], 'ok');
  code = 1; calls.length = 0;
  await controller.handleSaveRouting();
  assert.deepEqual(calls, [saveCommand]);
  assert.deepEqual(notices.at(-1), ['error', 'stale list']);
  console.log('PASS LuCI routing: common rule, short list, normalized domains, transactional save, error propagation');
})().catch(error => { console.error(error); process.exitCode = 1; });
