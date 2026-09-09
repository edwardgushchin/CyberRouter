// Exercise the real LuCI view with a fake RPC endpoint; never switch the router.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function E(tag, attrs, children) {
  if (typeof attrs === 'string' || Array.isArray(attrs)) { children = attrs; attrs = {}; }
  return {
    tag, attrs: attrs || {}, children: children == null ? [] : [].concat(children),
    get firstChild() { return this.children[0]; },
    appendChild(child) { this.children.push(child); },
    removeChild(child) { this.children.splice(this.children.indexOf(child), 1); }
  };
}
function flatten(node) {
  return typeof node === 'object' ? [node, ...node.children.flatMap(flatten)] : [];
}

(async () => {
  const calls = [], confirmations = [];
  let accepted = true, selected = 'main-test';
  const status = () => `Recorded active profile: ${selected}\nDetected live profile: ${selected}\nxray runtime=active autostart=yes\n`;
  const ui = {
    addNotification() {},
    createHandlerFn: (self, method, ...args) => event => self[method](...args, event)
  };
  const rpc = { exec: async (script, args) => {
    assert.equal(script, '/usr/bin/xray-profile');
    calls.push(args);
    if (args[0] !== 'status') selected = {
      main: 'main-test', backup: 'backup-spacevpn-nl', backup2: 'backup-spacevpn-de', local: 'custom/unknown'
    }[args[0]];
    return { code: 0, stdout: status() };
  } };
  const source = fs.readFileSync(path.join(__dirname, 'luci-profile.js'), 'utf8');
  const view = new Function('view', 'fs', 'ui', 'L', 'E', 'document', 'navigator', 'confirm', source)(
    { extend: value => value }, rpc, ui, { env: { lang: 'ru' }, bind: (fn, self) => fn.bind(self) },
    E, { documentElement: { lang: 'ru' } }, { language: 'ru' },
    text => { confirmations.push(text); return accepted; }
  );
  const nodes = flatten(view.render({ stdout: status() }));
  const buttons = nodes.filter(node => node.tag === 'button');
  assert.deepEqual(buttons.map(node => node.children.join('')), [
    'Основной VDS', 'Резерв: Нидерланды', 'Резерв: Германия', 'Отключить Xray', 'Обновить'
  ]);
  assert.equal(view.detectedNode.textContent, 'Основной VDS');
  const event = () => ({ currentTarget: { disabled: false, classList: { toggle() {} } } });
  for (const [index, command, label] of [[1, 'backup', 'Нидерланды'], [2, 'backup2', 'Германия'], [0, 'main', 'Основной VDS']]) {
    calls.length = 0;
    await buttons[index].attrs.click(event());
    assert.deepEqual(calls, [[command], ['status']]);
    assert.ok(confirmations.at(-1).includes(label));
    assert.ok(!confirmations.at(-1).includes('Остановить'));
    assert.equal(view.detectedNode.textContent, label);
  }
  calls.length = 0;
  accepted = false;
  await buttons[2].attrs.click(event());
  assert.deepEqual(calls, []);
  accepted = true;
  await buttons[3].attrs.click(event());
  assert.deepEqual(calls, [['local'], ['status']]);
  assert.ok(confirmations.at(-1).includes('Остановить'));
  calls.length = 0;
  await buttons[4].attrs.click(event());
  assert.deepEqual(calls, [['status']]);
  console.log('PASS LuCI: both country buttons, exact RPC commands, confirmations, status labels, cancel, off and refresh');
})().catch(error => { console.error(error); process.exitCode = 1; });
