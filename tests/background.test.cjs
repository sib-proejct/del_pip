const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const source = fs.readFileSync(require('node:path').join(__dirname, '../background.js'), 'utf8');

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function setup(executeScript, writeBadge) {
  const listeners = {}, badges = [], titles = [];
  const event = name => ({ addListener(fn) { listeners[name] = fn; } });
  vm.runInNewContext(source, { chrome: {
    action: {
      onClicked: event('click'),
      async setBadgeBackgroundColor() {},
      async setBadgeText(value) {
        if (writeBadge) await writeBadge(value);
        badges.push(value);
      },
      async setTitle(value) { titles.push(value); }
    },
    tabs: { onUpdated: event('update'), onRemoved: event('remove') },
    scripting: { executeScript }
  } });
  return { listeners, badges, titles };
}

test('toolbar shows success and injection failure', async () => {
  for (const fail of [false, true]) {
    const env = setup(async options => {
      assert.equal(options.target.allFrames, true);
      if (fail) throw new Error('Restricted page');
      return [{ result: { removed: 2 } }, { result: { removed: 1 } }];
    });
    await env.listeners.click({ id: 1 });
    assert.equal(env.badges.at(-1).text, fail ? '!' : 'ON');
    if (!fail) assert.match(env.titles.at(-1).title, /3개/);
  }
});

test('reload clears state and does not reset an unrelated tab', async () => {
  const env = setup(async () => [{ result: { removed: 1 } }]);
  await env.listeners.click({ id: 1 });
  await env.listeners.click({ id: 2 });
  await env.listeners.update(1, { status: 'loading' });
  assert.equal(env.badges.filter(b => b.tabId === 1).at(-1).text, '');
  assert.equal(env.badges.filter(b => b.tabId === 2).at(-1).text, 'ON');
  assert.equal(env.titles.at(-1).title, '이 페이지의 PiP 제한 속성 제거');
});

test('old injection success or failure cannot overwrite navigation reset', async () => {
  for (const fail of [false, true]) {
    const injection = deferred(), env = setup(() => injection.promise);
    const click = env.listeners.click({ id: 1 });
    await env.listeners.update(1, { status: 'loading' });
    if (fail) injection.reject(new Error('Navigation interrupted injection'));
    else injection.resolve([{ result: { removed: 1 } }]);
    await click;
    assert.deepEqual(env.badges.map(b => b.text), ['']);
  }
});

test('navigation reset finishes after an already pending badge write', async () => {
  const writing = deferred(), started = deferred();
  const env = setup(async () => [{ result: { removed: 1 } }], async value => {
    if (value.text === 'ON') { started.resolve(); await writing.promise; }
  });
  const click = env.listeners.click({ id: 1 });
  await started.promise;
  const reset = env.listeners.update(1, { status: 'loading' });
  writing.resolve();
  await Promise.all([click, reset]);
  assert.deepEqual(env.badges.map(b => b.text), ['ON', '']);
  assert.equal(env.titles.at(-1).title, '이 페이지의 PiP 제한 속성 제거');
});

test('latest click wins when injections complete out of order', async () => {
  const old = deferred();
  let count = 0;
  const env = setup(() => ++count === 1 ? old.promise : Promise.resolve([{ result: { removed: 2 } }]));
  const first = env.listeners.click({ id: 1 });
  await env.listeners.click({ id: 1 });
  old.resolve([{ result: { removed: 1 } }]);
  await first;
  assert.equal(env.badges.length, 1);
  assert.match(env.titles.at(-1).title, /2개/);
});

test('closing the tab discards outstanding results', async () => {
  const injection = deferred(), env = setup(() => injection.promise);
  const click = env.listeners.click({ id: 1 });
  env.listeners.remove(1);
  injection.resolve([{ result: { removed: 1 } }]);
  await click;
  assert.equal(env.badges.length, 0);
});
