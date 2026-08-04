// Behavioural tests for `wait`'s expression mode.
//
// The point of the mode is that a predicate can flip with no DOM mutation at
// all, so it must poll rather than lean on the MutationObserver path that
// serves selector waits. These tests drive exactly that: a value that changes
// on a timer, with no mutation ever dispatched.
//
// Run: node --test crates/tauri-plugin-hasgard/js/bridge.wait.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const BRIDGE_SRC = readFileSync(join(here, "bridge.js"), "utf8");

const REAL_CONSOLE = {
  log: console.log.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
  info: console.info.bind(console),
};

function loadBridge() {
  Object.assign(console, REAL_CONSOLE);

  globalThis.window = { fetch() {} };
  globalThis.document = {
    body: {},
    querySelector() {
      throw new Error("expression waits must not touch querySelector");
    },
  };
  globalThis.MutationObserver = class {
    observe() {
      throw new Error("expression waits must not install a MutationObserver");
    }
    disconnect() {}
  };
  function XMLHttpRequestStub() {}
  XMLHttpRequestStub.prototype.open = function () {};
  XMLHttpRequestStub.prototype.send = function () {};
  globalThis.XMLHttpRequest = XMLHttpRequestStub;

  (0, eval)(BRIDGE_SRC);
  return globalThis.window.__HASGARD__;
}

test("an already-true expression resolves without polling", async () => {
  const hasgard = loadBridge();
  globalThis.__probe = 7;

  const result = await hasgard.wait({ expression: "globalThis.__probe === 7", timeout: 1000 });

  assert.deepEqual(result, { found: true, value: true });
  delete globalThis.__probe;
});

test("an expression that flips on a timer resolves, with no DOM mutation involved", async () => {
  const hasgard = loadBridge();
  globalThis.__ready = false;
  setTimeout(() => {
    globalThis.__ready = true;
  }, 60);

  const result = await hasgard.wait({ expression: "globalThis.__ready", timeout: 2000, poll: 10 });

  assert.deepEqual(result, { found: true, value: true });
  delete globalThis.__ready;
});

test("the resolved value is returned, not just a boolean", async () => {
  const hasgard = loadBridge();
  globalThis.__count = 0;
  const tick = setInterval(() => {
    globalThis.__count += 1;
  }, 10);

  const result = await hasgard.wait({
    expression: "globalThis.__count >= 3 ? globalThis.__count : 0",
    timeout: 2000,
    poll: 10,
  });

  clearInterval(tick);
  assert.equal(result.found, true);
  assert.ok(result.value >= 3, `expected the predicate's own value, got ${result.value}`);
  delete globalThis.__count;
});

test("a promise-returning expression is awaited", async () => {
  const hasgard = loadBridge();

  const result = await hasgard.wait({
    expression: "Promise.resolve('done')",
    timeout: 1000,
    poll: 10,
  });

  assert.deepEqual(result, { found: true, value: "done" });
});

test("a throwing expression rejects instead of being retried into a timeout", async () => {
  const hasgard = loadBridge();

  await assert.rejects(
    () => hasgard.wait({ expression: "globalThis.__missing.field", timeout: 5000, poll: 10 }),
    /wait expression threw/,
  );
});

test("an expression that never becomes true reports the expression in the timeout", async () => {
  const hasgard = loadBridge();

  await assert.rejects(
    () => hasgard.wait({ expression: "false", timeout: 60, poll: 10 }),
    /Timeout waiting for expression: false/,
  );
});

test("wait still rejects when given no selector, ref, or expression", async () => {
  const hasgard = loadBridge();

  await assert.rejects(() => hasgard.wait({ timeout: 100 }), /requires 'selector', 'ref', or 'expression'/);
});
