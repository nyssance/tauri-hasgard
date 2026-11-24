// Behavioural tests for the `query` op.
//
// The op exists because snapshot's `name` is lossy: getName collapses
// aria-label, aria-labelledby, alt, <label>, placeholder, and textContent into
// one 50-character field, so a control carrying two of those is findable by
// only the highest-precedence one. These tests pin the cases where matching on
// `name` would give the wrong answer.
//
// Run: bun test crates/tauri-plugin-hasgard/js/bridge.query.test.mjs

import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { test } from "node:test"

const here = import.meta.dirname
const BRIDGE_SRC = readFileSync(join(here, "bridge.js"), "utf8")

const REAL_CONSOLE = {
  log: console.log.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
  info: console.info.bind(console)
}

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
      return Object.hasOwn(this.attributes, name) ? this.attributes[name] : null
    },
    hasAttribute(name) {
      return this.getAttribute(name) !== null
    },
    get textContent() {
      return this._text + this.children.map((c) => c.textContent).join("")
    },
    contains(other) {
      if (other === this) return true
      return this.children.some((c) => c.contains(other))
    }
  }
  if (props.value !== undefined) node.value = props.value
  if (props.disabled) node.disabled = true
  for (const child of children) child.parentElement = node
  return node
}

function flatten(node, out = []) {
  out.push(node)
  for (const child of node.children) flatten(child, out)
  return out
}

function loadBridge(body) {
  Object.assign(console, REAL_CONSOLE)

  const all = flatten(body).filter((n) => n !== body)

  globalThis.Node = { ELEMENT_NODE: 1, TEXT_NODE: 3 }
  globalThis.window = { fetch() {} }
  globalThis.document = {
    body,
    documentElement: body,
    getElementById(id) {
      return all.find((n) => n.getAttribute("id") === id) || null
    },
    querySelectorAll(selector) {
      if (selector === "*") return all
      const tags = selector.split(",").map((s) => s.trim().toUpperCase())
      if (selector.startsWith("[")) {
        const attr = selector.slice(1, -1)
        return all.filter((n) => n.getAttribute(attr) !== null)
      }
      return all.filter((n) => tags.includes(n.tagName))
    },
    querySelector() {
      return null
    }
  }
  function XMLHttpRequestStub() {}
  XMLHttpRequestStub.prototype.open = function () {}
  XMLHttpRequestStub.prototype.send = function () {}
  globalThis.XMLHttpRequest = XMLHttpRequestStub

  ;(0, eval)(BRIDGE_SRC)
  return globalThis.window.__HASGARD__
}

test("text finds a button whose aria-label hides its text from the snapshot name", () => {
  // getName would report "Save" for this button, so a name-based getByText
  // could never reach the visible word "Submit".
  const button = el("button", { attrs: { "aria-label": "Save" }, text: "Submit" })
  const hasgard = loadBridge(el("body", {}, [button]))

  const result = hasgard.query({ by: "text", value: "Submit" })

  assert.equal(result.elements.length, 1)
  assert.equal(result.elements[0].role, "button")
})

test("label finds a control by its <label> even when an aria-label outranks it", () => {
  const label = el("label", { text: "Email address" })
  const input = el("input", { attrs: { "aria-label": "E" }, labels: [label] })
  const hasgard = loadBridge(el("body", {}, [label, input]))

  assert.equal(hasgard.query({ by: "label", value: "Email address" }).elements.length, 1)
  assert.equal(hasgard.query({ by: "label", value: "E", exact: true }).elements.length, 1)
})

test("placeholder is reachable on a control that also has a label", () => {
  // getName prefers the <label>, so the placeholder never reaches the snapshot.
  const label = el("label", { text: "Search" })
  const input = el("input", { attrs: { placeholder: "Type to filter…" }, labels: [label] })
  const hasgard = loadBridge(el("body", {}, [label, input]))

  assert.equal(hasgard.query({ by: "placeholder", value: "filter" }).elements.length, 1)
})

test("testid matches exactly so a prefix cannot select a sibling", () => {
  const save = el("button", { attrs: { "data-testid": "save" } })
  const draft = el("button", { attrs: { "data-testid": "save-draft" } })
  const hasgard = loadBridge(el("body", {}, [save, draft]))

  const result = hasgard.query({ by: "testid", value: "save" })

  assert.equal(result.elements.length, 1, "an identifier must not substring-match")
})

test("text keeps only the innermost match so ancestors do not flood the result", () => {
  const span = el("span", { text: "Save" })
  const button = el("button", {}, [span])
  const wrapper = el("div", {}, [button])
  const hasgard = loadBridge(el("body", {}, [wrapper]))

  const result = hasgard.query({ by: "text", value: "Save" })

  assert.equal(result.elements.length, 1)
  assert.equal(result.elements[0].role, "generic", "the <span> is the innermost match")
})

test("non-exact text is case-insensitive and whitespace-normalized", () => {
  const node = el("p", { text: "  Hello   World  " })
  const hasgard = loadBridge(el("body", {}, [node]))

  assert.equal(hasgard.query({ by: "text", value: "hello world" }).elements.length, 1)
  assert.equal(hasgard.query({ by: "text", value: "hello world", exact: true }).elements.length, 0)
  assert.equal(hasgard.query({ by: "text", value: "Hello World", exact: true }).elements.length, 1)
})

test("query text is not truncated at 50 characters the way snapshot names are", () => {
  const long = "x".repeat(80)
  const node = el("p", { text: long })
  const hasgard = loadBridge(el("body", {}, [node]))

  assert.equal(hasgard.query({ by: "text", value: long, exact: true }).elements.length, 1)
})

test("query refs append rather than resetting the map a snapshot handed out", () => {
  const first = el("p", { text: "one" })
  const second = el("p", { text: "two" })
  const hasgard = loadBridge(el("body", {}, [first, second]))

  const snap = hasgard.snapshot({})
  const before = snap.elements.map((e) => e.ref)
  const found = hasgard.query({ by: "text", value: "two" })

  assert.ok(before.length > 0)
  assert.equal(hasgard.resolve(found.elements[0].ref), second, "a query ref must name the node it matched")
  assert.equal(hasgard.resolve(before[0]), first, "snapshot refs must stay resolvable after a query")
})

test("a node keeps one ref across repeated queries instead of minting a new one each time", () => {
  const node = el("p", { text: "one" })
  const hasgard = loadBridge(el("body", {}, [node]))

  const first = hasgard.query({ by: "text", value: "one" }).elements[0].ref
  const second = hasgard.query({ by: "text", value: "one" }).elements[0].ref

  assert.equal(second, first)
})

test("exact text finds a nested match whose ancestors only contain it", () => {
  const span = el("span", { text: "Save" })
  const other = el("span", { text: "Save draft" })
  const hasgard = loadBridge(el("body", {}, [el("div", { text: "Actions: " }, [span, other])]))

  const result = hasgard.query({ by: "text", value: "Save", exact: true })

  assert.equal(result.elements.length, 1)
  assert.equal(hasgard.resolve(result.elements[0].ref), span)
})

test("text matches come back in document order across separate subtrees", () => {
  const a = el("li", { text: "apple pie" })
  const b = el("li", { text: "apple tart" })
  const hasgard = loadBridge(el("body", {}, [el("ul", {}, [a]), el("ul", {}, [b])]))

  const result = hasgard.query({ by: "text", value: "apple" })

  assert.deepEqual(
    result.elements.map((e) => hasgard.resolve(e.ref)),
    [a, b]
  )
})

test("role matches what a snapshot reports, without resetting snapshot refs", () => {
  const save = el("button", { text: "Save" })
  const cancel = el("button", { text: "Cancel" })
  const hidden = el("div", { attrs: { "aria-hidden": "true" } }, [el("button", { text: "Save hidden" })])
  const hasgard = loadBridge(el("body", {}, [save, cancel, hidden]))

  const snap = hasgard.snapshot({})
  const all = hasgard.query({ by: "role", value: "button" })
  const named = hasgard.query({ by: "role", value: "button", name: "Save" })

  assert.equal(all.elements.length, 2, "a hidden subtree contributes no role matches")
  assert.equal(named.elements.length, 1)
  assert.equal(hasgard.resolve(named.elements[0].ref), save)
  assert.deepEqual(
    named.elements[0],
    snap.elements.find((e) => e.name === "Save"),
    "a role match has the shape and ref the snapshot gave the same node"
  )
})

test("role names match as a case-sensitive substring, exactly, or by pattern", () => {
  const hasgard = loadBridge(el("body", {}, [el("button", { text: "Save" }), el("button", { text: "Save draft" })]))

  assert.equal(hasgard.query({ by: "role", value: "button", name: "Save" }).elements.length, 2)
  assert.equal(hasgard.query({ by: "role", value: "button", name: "save" }).elements.length, 0)
  assert.equal(hasgard.query({ by: "role", value: "button", name: "Save", exact: true }).elements.length, 1)
  assert.equal(
    hasgard.query({ by: "role", value: "button", name: { source: "^save draft$", flags: "i" } }).elements.length,
    1
  )
  assert.throws(
    () => hasgard.query({ by: "role", value: "button", name: 7 }),
    /must be a string or a \{ source, flags \} pattern/
  )
})

test("acting on a ref whose element left the document fails as stale", () => {
  const node = el("button", { text: "Save" })
  const hasgard = loadBridge(el("body", {}, [node]))
  const ref = hasgard.query({ by: "role", value: "button" }).elements[0].ref

  node.isConnected = false

  assert.throws(() => hasgard.filter({ refs: [ref], hasText: "Save" }), /Stale ref: e\d+ .*take a new snapshot/)
})

test("an unknown dimension is rejected with the supported list", () => {
  const hasgard = loadBridge(el("body", {}, []))

  assert.throws(() => hasgard.query({ by: "xpath", value: "//button" }), /must be one of .*text.*testid.*role/)
})

test("a missing value is rejected rather than matching everything", () => {
  const hasgard = loadBridge(el("body", {}, [el("p", { text: "anything" })]))

  assert.throws(() => hasgard.query({ by: "text" }), /requires a 'value'/)
})

test("a node swept as detached gets a working ref when it returns to the document", () => {
  const node = el("button", { text: "Returning" })
  const others = Array.from({ length: 1100 }, (_, i) => el("button", { text: `b${i}` }))
  const body = el("body", {}, [node, ...others])
  const hasgard = loadBridge(body)
  hasgard.query({ by: "role", value: "button" })

  // The node leaves the document; the next query sweeps it from the ref table.
  body.children.splice(body.children.indexOf(node), 1)
  node.isConnected = false
  hasgard.query({ by: "role", value: "button" })

  // A framework re-attaches the same node, as tab panels and portals do.
  body.children.unshift(node)
  node.isConnected = true
  const again = hasgard.query({ by: "role", value: "button", name: "Returning" }).elements

  assert.equal(again.length, 1)
  assert.equal(hasgard.resolve(again[0].ref), node, "the ref handed out must resolve to the node")
})

test("locationState reports the document and matches a glob, a pattern and a load state", () => {
  const hasgard = loadBridge(el("body", {}, []))
  globalThis.window.location = { href: "app://localhost/settings/profile" }
  globalThis.document.readyState = "interactive"

  assert.deepEqual(hasgard.locationState({}), {
    url: "app://localhost/settings/profile",
    readyState: "interactive",
    matched: true
  })
  assert.equal(hasgard.locationState({ url: "**/profile" }).matched, true)
  assert.equal(hasgard.locationState({ url: "app://localhost/*" }).matched, false, "* stays within a segment")
  assert.equal(hasgard.locationState({ url: { source: "SETTINGS", flags: "i" } }).matched, true)
  assert.equal(hasgard.locationState({ url: "**/profile", load: "domcontentloaded" }).matched, true)
  assert.equal(hasgard.locationState({ url: "**/profile", load: "load" }).matched, false)
  assert.throws(() => hasgard.locationState({ url: 5 }), /must be a glob string/)
  assert.throws(() => hasgard.locationState({ load: "interactive" }), /must be "load" or "domcontentloaded"/)
})
