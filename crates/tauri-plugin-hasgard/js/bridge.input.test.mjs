// Behavioural tests for the input-side ops added alongside `filter`:
// `setInputFiles`, `wheel`, and the modal-dialog interception.
//
// Each pins a case where the obvious implementation is silently wrong:
// assigning `.files` to a non-file input no-ops, a synthetic wheel event never
// scrolls, and an unanswered `confirm()` freezes the webview outright.
//
// Run: bun test crates/tauri-plugin-hasgard/js/bridge.input.test.mjs

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

function el(tag, props = {}, children = []) {
  const node = {
    tagName: tag.toUpperCase(),
    nodeType: 1,
    attributes: props.attrs || {},
    children,
    parentElement: null,
    labels: props.labels || null,
    _text: props.text || "",
    events: [],
    scrolled: [],
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null;
    },
    hasAttribute(name) {
      return this.getAttribute(name) !== null;
    },
    get textContent() {
      return this._text + this.children.map((c) => c.textContent).join("");
    },
    contains(other) {
      if (other === this) return true;
      return this.children.some((c) => c.contains(other));
    },
    getBoundingClientRect() {
      return { left: 0, top: 0, width: 100, height: 50 };
    },
    dispatchEvent(event) {
      this.events.push(event);
      // A handler that calls preventDefault is modelled as a per-node predicate
      // so the wheel test can exercise both branches of the default action.
      if (props.cancels && props.cancels(event)) return false;
      return true;
    },
    scrollBy(dx, dy) {
      this.scrolled.push([dx, dy]);
    },
  };
  if (props.type !== undefined) node.type = props.type;
  if (props.multiple) node.multiple = true;
  if (props.value !== undefined) node.value = props.value;
  for (const child of children) child.parentElement = node;
  return node;
}

function flatten(node, out = []) {
  out.push(node);
  for (const child of node.children) flatten(child, out);
  return out;
}

function loadBridge(body, extraGlobals = {}) {
  Object.assign(console, REAL_CONSOLE);
  const all = flatten(body).filter((n) => n !== body);

  globalThis.Node = { ELEMENT_NODE: 1, TEXT_NODE: 3 };
  globalThis.window = { fetch() {} };
  globalThis.Event = class Event {
    constructor(type, init) {
      this.type = type;
      Object.assign(this, init || {});
    }
  };
  globalThis.WheelEvent = class WheelEvent extends globalThis.Event {};
  globalThis.File = class File {
    constructor(parts, name, options) {
      this.parts = parts;
      this.name = name;
      this.type = (options || {}).type;
    }
  };
  globalThis.DataTransfer = class DataTransfer {
    constructor() {
      const files = [];
      this.files = files;
      this.items = { add: (file) => files.push(file) };
    }
  };
  globalThis.atob = (b64) => Buffer.from(b64, "base64").toString("binary");
  globalThis.document = {
    body,
    scrollingElement: body,
    documentElement: body,
    getElementById(id) {
      return all.find((n) => n.getAttribute("id") === id) || null;
    },
    querySelectorAll(selector) {
      if (selector === "*") return all;
      const tags = selector.split(",").map((s) => s.trim().toUpperCase());
      if (selector.startsWith("[")) {
        const attr = selector.slice(1, -1);
        return all.filter((n) => n.getAttribute(attr) !== null);
      }
      return all.filter((n) => tags.includes(n.tagName));
    },
    querySelector(selector) {
      return this.querySelectorAll(selector)[0] || null;
    },
  };
  Object.assign(globalThis, extraGlobals);

  function XMLHttpRequestStub() {}
  XMLHttpRequestStub.prototype.open = function () {};
  XMLHttpRequestStub.prototype.send = function () {};
  globalThis.XMLHttpRequest = XMLHttpRequestStub;

  (0, eval)(BRIDGE_SRC);
  return globalThis.window.__HASGARD__;
}

// base64 for "hello"
const HELLO = Buffer.from("hello").toString("base64");

test("filter narrows a resolved set to the elements whose text matches", () => {
  const keep = el("button", { text: "Delete account" });
  const drop = el("button", { text: "Delete draft" });
  const hasgard = loadBridge(el("body", {}, [keep, drop]));

  const all = hasgard.query({ by: "selector", value: "button" });
  assert.equal(all.elements.length, 2);

  const narrowed = hasgard.filter({
    refs: all.elements.map((e) => e.ref),
    hasText: "account",
  });
  assert.equal(narrowed.elements.length, 1);
  assert.equal(narrowed.elements[0].ref, all.elements[0].ref);
});

test("hasNotText removes matches rather than keeping them", () => {
  const a = el("li", { text: "apple" });
  const b = el("li", { text: "banana" });
  const hasgard = loadBridge(el("body", {}, [a, b]));

  const all = hasgard.query({ by: "selector", value: "li" });
  const narrowed = hasgard.filter({ refs: all.elements.map((e) => e.ref), hasNotText: "apple" });

  assert.equal(narrowed.elements.length, 1);
  assert.equal(narrowed.elements[0].ref, all.elements[1].ref);
});

test("hasText and hasNotText compose so chained filters both apply", () => {
  const first = el("li", { text: "red apple" });
  const second = el("li", { text: "green apple" });
  const hasgard = loadBridge(el("body", {}, [first, second]));

  const all = hasgard.query({ by: "selector", value: "li" });
  const narrowed = hasgard.filter({
    refs: all.elements.map((e) => e.ref),
    hasText: "apple",
    hasNotText: "green",
  });

  assert.equal(narrowed.elements.length, 1);
  assert.equal(narrowed.elements[0].ref, all.elements[0].ref);
});

test("filter rejects a stale ref instead of silently dropping it", () => {
  // Silently skipping would turn "the DOM moved under you" into a wrong count.
  const hasgard = loadBridge(el("body", {}, [el("li", { text: "x" })]));
  assert.throws(() => hasgard.filter({ refs: ["e999"], hasText: "x" }), /Unknown ref/);
});

test("filter requires a predicate rather than quietly passing everything through", () => {
  const hasgard = loadBridge(el("body", {}, [el("li", { text: "x" })]));
  const all = hasgard.query({ by: "selector", value: "li" });
  assert.throws(
    () => hasgard.filter({ refs: all.elements.map((e) => e.ref) }),
    /requires 'hasText' or 'hasNotText'/
  );
});

test("the selector dimension resolves a CSS locator to refs like any other", () => {
  // This is what lets `filter` work on a plain CSS locator without a separate
  // per-kind implementation.
  const hasgard = loadBridge(el("body", {}, [el("li", { text: "a" }), el("li", { text: "b" })]));
  assert.equal(hasgard.query({ by: "selector", value: "li" }).elements.length, 2);
});

test("setInputFiles puts a real FileList on the input and fires change", () => {
  const input = el("input", { type: "file", attrs: { id: "up" } });
  const hasgard = loadBridge(el("body", {}, [input]));

  const result = hasgard.setInputFiles({ selector: "input", files: [{ name: "a.txt", data: HELLO }] });

  assert.equal(result.count, 1);
  assert.equal(input.files[0].name, "a.txt");
  assert.deepEqual(
    input.events.map((e) => e.type),
    ["input", "change"]
  );
});

test("setInputFiles on a non-file input throws instead of no-opping", () => {
  // Assigning `.files` to a text input is silently ignored by the browser, so
  // without this guard the caller gets ok:true and an unchanged page.
  const input = el("input", { type: "text" });
  const hasgard = loadBridge(el("body", {}, [input]));

  assert.throws(() => hasgard.setInputFiles({ selector: "input", files: [] }), /requires an <input type="file">/);
});

test("setInputFiles refuses multiple files on a single-file input", () => {
  // The browser would keep only the last one.
  const input = el("input", { type: "file" });
  const hasgard = loadBridge(el("body", {}, [input]));

  assert.throws(
    () =>
      hasgard.setInputFiles({
        selector: "input",
        files: [
          { name: "a.txt", data: HELLO },
          { name: "b.txt", data: HELLO },
        ],
      }),
    /not \[multiple\]/
  );
});

test("setInputFiles accepts several files when the input is [multiple]", () => {
  const input = el("input", { type: "file", multiple: true });
  const hasgard = loadBridge(el("body", {}, [input]));

  const result = hasgard.setInputFiles({
    selector: "input",
    files: [
      { name: "a.txt", data: HELLO },
      { name: "b.txt", data: HELLO },
    ],
  });

  assert.equal(result.count, 2);
});

test("setInputFiles with an empty list clears the selection", () => {
  const input = el("input", { type: "file" });
  const hasgard = loadBridge(el("body", {}, [input]));

  assert.equal(hasgard.setInputFiles({ selector: "input", files: [] }).count, 0);
});

test("wheel dispatches the event and then performs the scroll", () => {
  // A synthetic WheelEvent alone fires listeners but never moves the
  // scrollport, so an infinite-scroll test would see handlers run and no load.
  const scroller = el("div", { attrs: { id: "s" } });
  const hasgard = loadBridge(el("body", {}, [scroller]));

  const result = hasgard.wheel({ selector: "div", deltaX: 0, deltaY: 120 });

  assert.equal(result.defaultPrevented, false);
  assert.equal(scroller.events[0].type, "wheel");
  assert.equal(scroller.events[0].deltaY, 120);
  assert.deepEqual(scroller.scrolled, [[0, 120]]);
});

test("wheel honours preventDefault by not scrolling", () => {
  const scroller = el("div", { cancels: (e) => e.type === "wheel" });
  const hasgard = loadBridge(el("body", {}, [scroller]));

  const result = hasgard.wheel({ selector: "div", deltaY: 120 });

  assert.equal(result.defaultPrevented, true);
  assert.deepEqual(scroller.scrolled, []);
});

test("confirm is answered rather than left to block the webview", () => {
  // Unintercepted, this call never returns and every later bridge call dies on
  // a timeout naming the wrong cause.
  const hasgard = loadBridge(el("body", {}, []));

  assert.equal(globalThis.window.confirm("Delete everything?"), false);

  const listing = hasgard.dialogs();
  assert.equal(listing.dialogs.length, 1);
  assert.equal(listing.dialogs[0].type, "confirm");
  assert.equal(listing.dialogs[0].message, "Delete everything?");
  assert.equal(listing.dialogs[0].accepted, false);
});

test("the default policy dismisses, so an untouched test never silently agrees", () => {
  const hasgard = loadBridge(el("body", {}, []));
  assert.equal(hasgard.dialogs().policy.action, "dismiss");
});

test("accept flips confirm and submits the prompt's own default", () => {
  const hasgard = loadBridge(el("body", {}, []));
  hasgard.handleDialogs({ action: "accept" });

  assert.equal(globalThis.window.confirm("ok?"), true);
  assert.equal(globalThis.window.prompt("name?", "untitled"), "untitled");
});

test("accept with promptText overrides the page's default answer", () => {
  const hasgard = loadBridge(el("body", {}, []));
  hasgard.handleDialogs({ action: "accept", promptText: "Nyssance" });

  assert.equal(globalThis.window.prompt("name?", "untitled"), "Nyssance");
  const entry = hasgard.dialogs().dialogs[0];
  assert.equal(entry.defaultValue, "untitled");
  assert.equal(entry.returned, "Nyssance");
});

test("a dismissed prompt returns null, as a cancelled prompt does", () => {
  const hasgard = loadBridge(el("body", {}, []));
  assert.equal(globalThis.window.prompt("name?", "untitled"), null);
});

test("switching back to dismiss drops a promptText left from an earlier accept", () => {
  // Otherwise the stale text resurfaces on the next accept, answering a
  // different question than the one it was written for.
  const hasgard = loadBridge(el("body", {}, []));
  hasgard.handleDialogs({ action: "accept", promptText: "stale" });
  hasgard.handleDialogs({ action: "dismiss" });
  assert.equal(hasgard.dialogs().policy.promptText, null);

  hasgard.handleDialogs({ action: "accept" });
  assert.equal(globalThis.window.prompt("name?", "fresh"), "fresh");
});

test("an unknown dialog action is rejected rather than treated as dismiss", () => {
  const hasgard = loadBridge(el("body", {}, []));
  assert.throws(() => hasgard.handleDialogs({ action: "maybe" }), /must be "accept" or "dismiss"/);
});

test("alert is recorded and returns, so a page that alerts stays testable", () => {
  const hasgard = loadBridge(el("body", {}, []));
  globalThis.window.alert("saved");

  const entry = hasgard.dialogs().dialogs[0];
  assert.equal(entry.type, "alert");
  assert.equal(entry.message, "saved");
  // One button means the only possible outcome is acknowledgement.
  assert.equal(entry.accepted, true);
});

test("clearDialogs forgets the log but keeps the policy", () => {
  const hasgard = loadBridge(el("body", {}, []));
  hasgard.handleDialogs({ action: "accept" });
  globalThis.window.alert("x");

  hasgard.clearDialogs();

  assert.equal(hasgard.dialogs().dialogs.length, 0);
  assert.equal(hasgard.dialogs().policy.action, "accept");
});
