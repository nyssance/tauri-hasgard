// Behavioural tests for the `query` op.
//
// The op exists because snapshot's `name` is lossy: getName collapses
// aria-label, aria-labelledby, alt, <label>, placeholder, and textContent into
// one 50-character field, so a control carrying two of those is findable by
// only the highest-precedence one. These tests pin the cases where matching on
// `name` would give the wrong answer.
//
// Run: node --test crates/tauri-plugin-hasgard/js/bridge.query.test.mjs

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

// Minimal element model: enough DOM surface for query's candidate scan,
// containment check, depth walk, and describeElement.
function el(tag, props = {}, children = []) {
  const node = {
    tagName: tag.toUpperCase(),
    nodeType: 1,
    attributes: props.attrs || {},
    children,
    parentElement: null,
    labels: props.labels || null,
    _text: props.text || "",
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
  };
  if (props.value !== undefined) node.value = props.value;
  if (props.disabled) node.disabled = true;
  for (const child of children) child.parentElement = node;
  return node;
}

function flatten(node, out = []) {
  out.push(node);
  for (const child of node.children) flatten(child, out);
  return out;
}

function loadBridge(body) {
  Object.assign(console, REAL_CONSOLE);

  const all = flatten(body).filter((n) => n !== body);

  globalThis.Node = { ELEMENT_NODE: 1, TEXT_NODE: 3 };
  globalThis.window = { fetch() {} };
  globalThis.document = {
    body,
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
    querySelector() {
      return null;
    },
  };
  function XMLHttpRequestStub() {}
  XMLHttpRequestStub.prototype.open = function () {};
  XMLHttpRequestStub.prototype.send = function () {};
  globalThis.XMLHttpRequest = XMLHttpRequestStub;

  (0, eval)(BRIDGE_SRC);
  return globalThis.window.__HASGARD__;
}

test("text finds a button whose aria-label hides its text from the snapshot name", () => {
  // getName would report "Save" for this button, so a name-based getByText
  // could never reach the visible word "Submit".
  const button = el("button", { attrs: { "aria-label": "Save" }, text: "Submit" });
  const hasgard = loadBridge(el("body", {}, [button]));

  const result = hasgard.query({ by: "text", value: "Submit" });

  assert.equal(result.elements.length, 1);
  assert.equal(result.elements[0].role, "button");
});

test("label finds a control by its <label> even when an aria-label outranks it", () => {
  const label = el("label", { text: "Email address" });
  const input = el("input", { attrs: { "aria-label": "E" }, labels: [label] });
  const hasgard = loadBridge(el("body", {}, [label, input]));

  assert.equal(hasgard.query({ by: "label", value: "Email address" }).elements.length, 1);
  assert.equal(hasgard.query({ by: "label", value: "E", exact: true }).elements.length, 1);
});

test("placeholder is reachable on a control that also has a label", () => {
  // getName prefers the <label>, so the placeholder never reaches the snapshot.
  const label = el("label", { text: "Search" });
  const input = el("input", { attrs: { placeholder: "Type to filter…" }, labels: [label] });
  const hasgard = loadBridge(el("body", {}, [label, input]));

  assert.equal(hasgard.query({ by: "placeholder", value: "filter" }).elements.length, 1);
});

test("testid matches exactly so a prefix cannot select a sibling", () => {
  const save = el("button", { attrs: { "data-testid": "save" } });
  const draft = el("button", { attrs: { "data-testid": "save-draft" } });
  const hasgard = loadBridge(el("body", {}, [save, draft]));

  const result = hasgard.query({ by: "testid", value: "save" });

  assert.equal(result.elements.length, 1, "an identifier must not substring-match");
});

test("text keeps only the innermost match so ancestors do not flood the result", () => {
  const span = el("span", { text: "Save" });
  const button = el("button", {}, [span]);
  const wrapper = el("div", {}, [button]);
  const hasgard = loadBridge(el("body", {}, [wrapper]));

  const result = hasgard.query({ by: "text", value: "Save" });

  assert.equal(result.elements.length, 1);
  assert.equal(result.elements[0].role, "generic", "the <span> is the innermost match");
});

test("non-exact text is case-insensitive and whitespace-normalized", () => {
  const node = el("p", { text: "  Hello   World  " });
  const hasgard = loadBridge(el("body", {}, [node]));

  assert.equal(hasgard.query({ by: "text", value: "hello world" }).elements.length, 1);
  assert.equal(hasgard.query({ by: "text", value: "hello world", exact: true }).elements.length, 0);
  assert.equal(hasgard.query({ by: "text", value: "Hello World", exact: true }).elements.length, 1);
});

test("query text is not truncated at 50 characters the way snapshot names are", () => {
  const long = "x".repeat(80);
  const node = el("p", { text: long });
  const hasgard = loadBridge(el("body", {}, [node]));

  assert.equal(hasgard.query({ by: "text", value: long, exact: true }).elements.length, 1);
});

test("query refs append rather than resetting the map a snapshot handed out", () => {
  const first = el("p", { text: "one" });
  const second = el("p", { text: "two" });
  const hasgard = loadBridge(el("body", {}, [first, second]));

  const snap = hasgard.snapshot({});
  const before = snap.elements.map((e) => e.ref);
  const found = hasgard.query({ by: "text", value: "two" });

  assert.ok(before.length > 0);
  assert.ok(!before.includes(found.elements[0].ref), "a query ref must not collide with a live snapshot ref");
  assert.equal(hasgard.resolve(before[0]), first, "snapshot refs must stay resolvable after a query");
});

test("an unknown dimension is rejected with the supported list", () => {
  const hasgard = loadBridge(el("body", {}, []));

  assert.throws(() => hasgard.query({ by: "role", value: "button" }), /must be one of .*text.*testid/);
});

test("a missing value is rejected rather than matching everything", () => {
  const hasgard = loadBridge(el("body", {}, [el("p", { text: "anything" })]));

  assert.throws(() => hasgard.query({ by: "text" }), /requires a 'value'/);
});
