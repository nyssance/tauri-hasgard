// Behavioural tests for the parameterized click gesture.
//
// A bare click() could only ever produce an unmodified left press at the
// element centre, which put three ordinary interactions out of reach: a
// Shift-extended multi-select, a right-click context menu, and anything that
// keys off `detail` to tell a single click from a double. These cover the
// event stream each option actually produces, because that stream -- not the
// return value -- is the whole contract.
//
// Run: bun test crates/tauri-plugin-hasgard/js/bridge.click.test.mjs

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

// Element mock recording every dispatched event object, so a test can assert on
// the order of the stream and on each event's init.
function makeElement({ left = 0, top = 0, width = 100, height = 40 } = {}) {
  return {
    tagName: "BUTTON",
    dispatched: [],
    focusCalls: 0,
    getBoundingClientRect() {
      return { left, top, width, height, right: left + width, bottom: top + height };
    },
    scrollIntoView() {},
    focus() {
      this.focusCalls += 1;
    },
    dispatchEvent(event) {
      this.dispatched.push(event);
      return true;
    },
  };
}

// Fresh globals per test: the IIFE early-returns when `window.__HASGARD__`
// already exists, so `window` must be rebuilt for every bridge load.
function loadBridge(el) {
  Object.assign(console, REAL_CONSOLE);

  globalThis.window = { fetch() {} };
  globalThis.document = {
    querySelector() {
      return el;
    },
  };
  function XMLHttpRequestStub() {}
  XMLHttpRequestStub.prototype.open = function () {};
  XMLHttpRequestStub.prototype.send = function () {};
  globalThis.XMLHttpRequest = XMLHttpRequestStub;

  class FakeUIEvent {
    constructor(type, init) {
      this.type = type;
      Object.assign(this, init || {});
    }
  }
  globalThis.MouseEvent = class MouseEvent extends FakeUIEvent {};
  // Deliberately absent, so click() takes the MouseEvent fallback branch in
  // dispatchPointerEvent -- WKWebView has PointerEvent, but the fallback is
  // what runs everywhere else and it must produce the same stream.
  globalThis.PointerEvent = undefined;

  (0, eval)(BRIDGE_SRC);
  return globalThis.window.__HASGARD__;
}

const types = el => el.dispatched.map(e => e.type);
const only = (el, type) => el.dispatched.filter(e => e.type === type);

test("a default click is an unmodified left press at the element centre", () => {
  const el = makeElement({ left: 20, top: 60, width: 100, height: 40 });
  const hasgard = loadBridge(el);

  assert.deepEqual(hasgard.click({ selector: "#save" }), { ok: true });

  assert.deepEqual(types(el), ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]);
  const down = only(el, "mousedown")[0];
  assert.equal(down.clientX, 70, "centre of a 100-wide box at left 20");
  assert.equal(down.clientY, 80, "centre of a 40-tall box at top 60");
  assert.equal(down.button, 0);
  assert.equal(down.buttons, 1);
  assert.equal(down.detail, 1);
  assert.equal(down.shiftKey, false);
  assert.equal(down.ctrlKey, false);
  assert.equal(down.altKey, false);
  assert.equal(down.metaKey, false);
});

test("modifiers ride on every event of the gesture, not just the first", () => {
  const el = makeElement();
  const hasgard = loadBridge(el);

  hasgard.click({ selector: "#row", modifiers: ["Shift", "Meta"] });

  for (const event of el.dispatched) {
    assert.equal(event.shiftKey, true, `${event.type} must carry shiftKey`);
    assert.equal(event.metaKey, true, `${event.type} must carry metaKey`);
    assert.equal(event.ctrlKey, false, `${event.type} must not invent ctrlKey`);
    assert.equal(event.altKey, false, `${event.type} must not invent altKey`);
  }
});

test("a right click raises contextmenu and auxclick, never click", () => {
  const el = makeElement();
  const hasgard = loadBridge(el);

  hasgard.click({ selector: "#row", button: "right" });

  assert.deepEqual(types(el), [
    "pointerdown",
    "mousedown",
    "pointerup",
    "mouseup",
    "auxclick",
    "contextmenu",
  ]);
  const down = only(el, "mousedown")[0];
  assert.equal(down.button, 2);
  assert.equal(down.buttons, 2, "the right-button mask is 2, same as its button number");
});

test("a middle click raises auxclick without contextmenu, and uses mask 4", () => {
  const el = makeElement();
  const hasgard = loadBridge(el);

  hasgard.click({ selector: "#row", button: "middle" });

  assert.deepEqual(types(el), ["pointerdown", "mousedown", "pointerup", "mouseup", "auxclick"]);
  const down = only(el, "mousedown")[0];
  assert.equal(down.button, 1, "middle is button 1");
  assert.equal(down.buttons, 4, "but mask 4 -- the two numberings differ here");
});

test("clickCount 2 escalates detail and ends in a single dblclick", () => {
  const el = makeElement();
  const hasgard = loadBridge(el);

  hasgard.click({ selector: "#cell", clickCount: 2 });

  assert.deepEqual(
    only(el, "mousedown").map(e => e.detail),
    [1, 2],
    "the second press must report detail 2, as a real double click does",
  );
  assert.equal(only(el, "click").length, 2, "both presses still raise click");
  assert.equal(only(el, "dblclick").length, 1, "exactly one dblclick closes the gesture");
  assert.equal(types(el).at(-1), "dblclick", "and it comes last");
});

test("dblclick is the same gesture as clickCount 2", () => {
  const viaOption = makeElement();
  hasgardFor(viaOption).click({ selector: "#cell", clickCount: 2 });
  const viaCommand = makeElement();
  hasgardFor(viaCommand).dblclick({ selector: "#cell" });

  assert.deepEqual(types(viaCommand), types(viaOption));
  assert.deepEqual(
    only(viaCommand, "mousedown").map(e => e.detail),
    only(viaOption, "mousedown").map(e => e.detail),
  );
});

function hasgardFor(el) {
  return loadBridge(el);
}

test("a single click raises no dblclick", () => {
  const el = makeElement();
  const hasgard = loadBridge(el);

  hasgard.click({ selector: "#cell" });

  assert.equal(only(el, "dblclick").length, 0);
});

test("position is element-relative, so the same offset works wherever the element sits", () => {
  const el = makeElement({ left: 200, top: 300, width: 100, height: 40 });
  const hasgard = loadBridge(el);

  hasgard.click({ selector: "#canvas", position: { x: 10, y: 5 } });

  const down = only(el, "mousedown")[0];
  assert.equal(down.clientX, 210, "200 + 10, not 10");
  assert.equal(down.clientY, 305, "300 + 5, not 5");
});

test("position accepts zero, which must not fall back to the centre", () => {
  const el = makeElement({ left: 200, top: 300, width: 100, height: 40 });
  const hasgard = loadBridge(el);

  hasgard.click({ selector: "#canvas", position: { x: 0, y: 0 } });

  const down = only(el, "mousedown")[0];
  assert.equal(down.clientX, 200, "the top-left corner, not the centre");
  assert.equal(down.clientY, 300);
});

test("an unknown modifier is rejected rather than silently dropped", () => {
  const el = makeElement();
  const hasgard = loadBridge(el);

  assert.throws(() => hasgard.click({ selector: "#row", modifiers: ["Cmd"] }), /Unknown modifier/);
  assert.deepEqual(el.dispatched, [], "nothing may be dispatched once validation fails");
});

test("an unknown button is rejected rather than falling back to left", () => {
  const el = makeElement();
  const hasgard = loadBridge(el);

  assert.throws(() => hasgard.click({ selector: "#row", button: "primary" }), /Unknown button/);
  assert.deepEqual(el.dispatched, []);
});

test("a non-array modifiers value is rejected", () => {
  const el = makeElement();
  const hasgard = loadBridge(el);

  assert.throws(() => hasgard.click({ selector: "#row", modifiers: "Shift" }), /must be an array/);
});

test("a fractional or zero clickCount is rejected", () => {
  const el = makeElement();
  const hasgard = loadBridge(el);

  assert.throws(() => hasgard.click({ selector: "#row", clickCount: 1.5 }), /positive integer/);
  assert.throws(() => hasgard.click({ selector: "#row", clickCount: 0 }), /positive integer/);
  assert.deepEqual(el.dispatched, []);
});

test("a malformed position is rejected rather than producing NaN coordinates", () => {
  const el = makeElement();
  const hasgard = loadBridge(el);

  assert.throws(() => hasgard.click({ selector: "#row", position: { x: 10 } }), /position must be/);
  assert.deepEqual(el.dispatched, []);
});

test("focus still follows a left press, so click-then-type keeps working", () => {
  const el = makeElement();
  const hasgard = loadBridge(el);

  hasgard.click({ selector: "#name" });

  assert.equal(el.focusCalls, 1);
});
