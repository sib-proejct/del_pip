const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const source = fs.readFileSync(require('node:path').join(__dirname, '../content.js'), 'utf8');

function setup() {
  const observers = [], timers = [], timeouts = [];
  let now = 0;
  function element(name = 'div', children = []) {
    return { nodeType: 1, localName: name, children, isConnected: true,
      restricted: name === 'video',
      hasAttribute() { return this.restricted; },
      removeAttribute() { this.restricted = false; },
      querySelectorAll() { return this.children.flatMap(child => [child, ...child.querySelectorAll('*')]); }
    };
  }
  const document = element('document');
  document.hidden = false;
  document.addEventListener = () => {};
  const context = vm.createContext({ document, Date: { now: () => now },
    MutationObserver: class {
      constructor(callback) { this.callback = callback; observers.push(this); }
      observe(root) { this.root = root; }
      disconnect() { this.disconnected = true; }
    },
    setInterval(callback) { timers.push(callback); },
    setTimeout(callback, delay) { timeouts.push({ callback, delay }); return timeouts.length; }
  });
  return { document, element, observers, timers, timeouts,
    advance(ms) { now += ms; },
    flush() {
      const task = timeouts.shift();
      if (task) { now += task.delay; task.callback(); }
    },
    run: () => vm.runInContext(source, context)
  };
}

test('removes multiple videos, catches attribute resets and dynamic additions, stays idempotent', () => {
  const env = setup();
  const a = env.element('video'), b = env.element('video');
  env.document.children.push(a, b);
  assert.equal(env.run().removed, 2);
  assert.equal(a.restricted, false);
  a.restricted = true;
  env.observers[0].callback([{ type: 'attributes', target: a }]);
  assert.equal(a.restricted, true, 'mutation callback must defer changes');
  env.flush();
  assert.equal(a.restricted, false);
  const added = env.element('div', [env.element('video')]);
  env.observers[0].callback([{ type: 'childList', addedNodes: [added] }]);
  env.flush();
  assert.equal(added.children[0].restricted, false);
  assert.equal(env.run().removed, 0);
  assert.equal(env.observers.length, 1);
  assert.equal(env.timers.length, 1);
});

test('discovers late shadow roots and disconnects detached roots', () => {
  const env = setup(), host = env.element();
  env.document.children.push(host);
  env.run();
  const root = env.element('shadow', [env.element('video')]);
  root.host = host;
  host.shadowRoot = root;
  env.timers[0]();
  assert.equal(root.children[0].restricted, false);
  assert.equal(env.observers.length, 2);
  host.isConnected = false;
  env.document.children = [];
  env.timers[0]();
  assert.equal(env.observers[1].disconnected, true);
});

test('empty page starts monitoring for later videos', () => {
  const env = setup();
  assert.equal(env.run().removed, 0);
  assert.equal(env.observers.length, 1);
});

test('discovers roots attached inside an already observed shadow tree', () => {
  for (const rescan of ['timer', 'click']) {
    const env = setup(), outerHost = env.element(), innerHost = env.element();
    const outerRoot = env.element('shadow', [innerHost]);
    outerRoot.host = outerHost;
    outerHost.shadowRoot = outerRoot;
    env.document.children.push(outerHost);
    env.run();
    const innerRoot = env.element('shadow', [env.element('video')]);
    innerRoot.host = innerHost;
    innerHost.shadowRoot = innerRoot;
    if (rescan === 'timer') env.timers[0]();
    else env.run();
    assert.equal(innerRoot.children[0].restricted, false);
    assert.equal(env.observers.length, 3);
    env.run();
    assert.equal(env.observers.length, 3);
  }
});

test('bounds repeated restoration, preserves cooldown across clicks, and resumes later', () => {
  const env = setup(), video = env.element('video');
  env.document.children.push(video);
  env.run();
  for (let attempt = 0; attempt < 4; attempt++) {
    video.restricted = true;
    // Duplicate records must share one scheduled task.
    env.observers[0].callback(Array(3).fill({ type: 'attributes', target: video }));
    assert.equal(env.timeouts.length, 1);
    assert.equal(video.restricted, true);
    env.flush();
    assert.equal(video.restricted, false);
  }
  video.restricted = true;
  env.observers[0].callback([{ type: 'attributes', target: video }]);
  env.flush();
  assert.equal(video.restricted, true, 'sixth attempt is held back');
  env.run();
  env.timers[0]();
  assert.equal(video.restricted, true, 'scanning cannot bypass cooldown');
  // Other videos must still work while this one is in cooldown.
  const other = env.element('video');
  env.document.children.push(other);
  env.run();
  assert.equal(other.restricted, false);
  env.advance(30000);
  env.timers[0]();
  assert.equal(video.restricted, false);
});

test('own removals do not schedule retries; detached additions are ignored', () => {
  const env = setup(), video = env.element('video');
  env.document.children.push(video);
  env.run();
  env.observers[0].callback([{ type: 'attributes', target: video }]);
  assert.equal(env.timeouts.length, 0);
  const detached = env.element('video');
  detached.isConnected = false;
  env.observers[0].callback([{ type: 'childList', addedNodes: [detached] }]);
  env.flush();
  assert.equal(detached.restricted, true);
});
