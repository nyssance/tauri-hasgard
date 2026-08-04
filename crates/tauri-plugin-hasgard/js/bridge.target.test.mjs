// Behavioural tests for target resolution and element-state ops in the bridge.
//
// Covers the three things Tier B changed about how an op reaches its element:
//   1. `check` drives an explicit state instead of only toggling, so a retry
//      cannot silently invert the box.
//   2. `resolveTarget` honours an ordinal `index`, so `nth`/`first`/`last`
//      resolve and act in one round trip.
//   3. `scroll` routes through `resolveTarget`, so a selector locator scrolls
//      its own element rather than the document.
//
// Run: node --test crates/tauri-plugin-hasgard/js/bridge.target.test.mjs

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

function makeElement(props = {}) {
  return Object.assign(
    {
      tagName: "INPUT",
      events: [],
      attributes: {},
      scrollTop: 0,
      scrollLeft: 0,
      scrollHeight: 1000,
      clientHeight: 200,
      getAttribute(name) {
        return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null;
      },
      getBoundingClientRect() {
        return { left: 0, top: 0, width: 100, height: 20 };
      },
      dispatchEvent(event) {
        this.events.push(event.type);
        return true;
      },
      scrollBy(dx, dy) {
        this.scrollLeft += dx;
        this.scrollTop += dy;
      },
      focus() {},
      blur() {},
    },
    props,
  );
}

// Fresh globals per test: the IIFE early-returns when `window.__HASGARD__`
// already exists, so `window` must be rebuilt for every bridge load.
function loadBridge({ one, all } = {}) {
  Object.assign(console, REAL_CONSOLE);

  globalThis.window = { fetch() {}, scrollX: 0, scrollY: 0, innerWidth: 800, innerHeight: 600 };
  globalThis.document = {
    querySelector(selector) {
      if (one === undefined) throw new Error("unexpected querySelector(" + selector + ")");
      return one;
    },
    querySelectorAll(selector) {
      if (all === undefined) throw new Error("unexpected querySelectorAll(" + selector + ")");
      return all;
    },
  };
  function XMLHttpRequestStub() {}
  XMLHttpRequestStub.prototype.open = function () {};
  XMLHttpRequestStub.prototype.send = function () {};
  globalThis.XMLHttpRequest = XMLHttpRequestStub;

  (0, eval)(BRIDGE_SRC);
  return globalThis.window.__HASGARD__;
}

test("check with an explicit state is idempotent rather than a toggle", () => {
  const el = makeElement({ checked: true });
  const hasgard = loadBridge({ one: el });

  assert.deepEqual(hasgard.check({ selector: "#agree", checked: true }), { ok: true });

  assert.equal(el.checked, true, "an already-checked box must stay checked");
  assert.deepEqual(el.events, [], "a no-op must not fire a change event");
});

test("check with an explicit state drives an unchecked box to checked", () => {
  const el = makeElement({ checked: false });
  const hasgard = loadBridge({ one: el });

  hasgard.check({ selector: "#agree", checked: true });

  assert.equal(el.checked, true);
  assert.deepEqual(el.events, ["change"]);
});

test("check without a state still toggles, keeping the documented CLI contract", () => {
  const el = makeElement({ checked: true });
  const hasgard = loadBridge({ one: el });

  hasgard.check({ selector: "#agree" });

  assert.equal(el.checked, false);
  assert.deepEqual(el.events, ["change"]);
});

test("check rejects a non-boolean state instead of coercing it", () => {
  const el = makeElement({ checked: false });
  const hasgard = loadBridge({ one: el });

  assert.throws(() => hasgard.check({ selector: "#agree", checked: "true" }), /must be a boolean/);
  assert.equal(el.checked, false);
});

test("disabled reports the aria attribute as well as the property", () => {
  const ariaOnly = makeElement({ attributes: { "aria-disabled": "true" } });
  assert.deepEqual(loadBridge({ one: ariaOnly }).disabled({ selector: "#save" }), { disabled: true });

  const propertyOnly = makeElement({ disabled: true });
  assert.deepEqual(loadBridge({ one: propertyOnly }).disabled({ selector: "#save" }), { disabled: true });

  const neither = makeElement({ disabled: false, attributes: { "aria-disabled": "false" } });
  assert.deepEqual(loadBridge({ one: neither }).disabled({ selector: "#save" }), { disabled: false });
});

test("an ordinal index picks the nth selector match", () => {
  const rows = [makeElement({ id: "a" }), makeElement({ id: "b" }), makeElement({ id: "c" })];
  const hasgard = loadBridge({ all: rows });

  assert.deepEqual(hasgard.boundingBox({ selector: ".row", index: 1 }), {
    x: 0,
    y: 0,
    width: 100,
    height: 20,
  });
  hasgard.focus({ selector: ".row", index: 1 });
  hasgard.check({ selector: ".row", index: 1, checked: true });

  assert.equal(rows[1].checked, true);
  assert.equal(rows[0].checked, undefined, "the first row must be untouched");
});

test("a negative index counts back from the end so last() stays one round trip", () => {
  const rows = [makeElement(), makeElement(), makeElement()];
  const hasgard = loadBridge({ all: rows });

  hasgard.check({ selector: ".row", index: -1, checked: true });

  assert.equal(rows[2].checked, true);
  assert.equal(rows[0].checked, undefined);
});

test("an out-of-range index reports the match count instead of acting on nothing", () => {
  const rows = [makeElement(), makeElement()];
  const hasgard = loadBridge({ all: rows });

  assert.throws(() => hasgard.check({ selector: ".row", index: 5, checked: true }), /2 matched/);
});

test("a non-integer index is rejected rather than truncated", () => {
  const hasgard = loadBridge({ all: [makeElement()] });

  assert.throws(() => hasgard.check({ selector: ".row", index: 1.5, checked: true }), /integer/);
});

test("scroll with a selector scrolls that element, not the document", () => {
  const panel = makeElement({ tagName: "DIV" });
  const hasgard = loadBridge({ one: panel });

  hasgard.scroll({ selector: "#panel", direction: "down", amount: 120 });

  assert.equal(panel.scrollTop, 120, "the selector target must receive the scroll");
  assert.equal(globalThis.window.scrollY, 0, "the document must be left alone");
});

test("scroll without a target still scrolls the document", () => {
  let scrolled = null;
  const hasgard = loadBridge({});
  globalThis.window.scrollBy = (dx, dy) => {
    scrolled = { dx, dy };
  };

  hasgard.scroll({ direction: "right", amount: 40 });

  assert.deepEqual(scrolled, { dx: 40, dy: 0 });
});
