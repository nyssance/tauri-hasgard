// Behavioural tests for frame-scoped targeting.
//
// Everything inside an <iframe> used to be unreachable: the bridge only ever
// queried the top document, so an embedded checkout, OAuth callback, or docs
// pane simply had no locator. `frame` names a chain of iframe selectors, and
// every targeting path resolves against that document instead.
//
// The failure mode worth pinning is the quiet one -- falling back to the main
// document when the frame cannot be reached. That reports "no element matches"
// for a page where the element plainly exists, which sends you looking at the
// selector instead of at the origin.
//
// Run: bun test crates/tauri-plugin-hasgard/js/bridge.frame.test.mjs

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

function makeElement(id, props = {}) {
  return {
    id,
    tagName: "BUTTON",
    dispatched: [],
    textContent: "",
    children: [],
    attributes: [],
    getAttribute() {
      return null
    },
    hasAttribute() {
      return false
    },
    getBoundingClientRect() {
      return { left: 0, top: 0, width: 100, height: 40, right: 100, bottom: 40 }
    },
    scrollIntoView() {},
    focus() {},
    dispatchEvent(event) {
      this.dispatched.push(event.type)
      return true
    },
    ...props
  }
}

// A document mock backed by a selector -> element map. `all` lets one selector
// answer several matches, for count and ordinal tests.
function makeDocument(elements = {}, all = {}) {
  return {
    querySelector(selector) {
      return elements[selector] || null
    },
    querySelectorAll(selector) {
      if (all[selector]) return all[selector]
      const one = elements[selector]
      return one ? [one] : []
    },
    elementFromPoint(x, y) {
      return elements[`@${x},${y}`] || null
    }
  }
}

// `frames` maps an iframe selector to the document it hosts, or to null for a
// cross-origin frame, or to a non-frame element to test the wrong-tag path.
function loadBridge({ main = makeDocument(), frames = {}, boxes = {} } = {}) {
  Object.assign(console, REAL_CONSOLE)

  const hosts = {}
  for (const [selector, contentDocument] of Object.entries(frames)) {
    hosts[selector] = contentDocument?.notAFrame
      ? { tagName: "DIV" }
      : { tagName: "IFRAME", contentDocument, ...boxes[selector] }
  }

  const rootQuerySelector = main.querySelector.bind(main)
  main.querySelector = (selector) => hosts[selector] ?? rootQuerySelector(selector)

  globalThis.window = { fetch() {}, scrollX: 0, scrollY: 0 }
  globalThis.document = main
  function XMLHttpRequestStub() {}
  XMLHttpRequestStub.prototype.open = function () {}
  XMLHttpRequestStub.prototype.send = function () {}
  globalThis.XMLHttpRequest = XMLHttpRequestStub

  class FakeUIEvent {
    constructor(type, init) {
      this.type = type
      Object.assign(this, init || {})
    }
  }
  globalThis.MouseEvent = class MouseEvent extends FakeUIEvent {}
  globalThis.PointerEvent = undefined

  ;(0, eval)(BRIDGE_SRC)
  return globalThis.window.__HASGARD__
}

test("a frame-scoped click acts inside the frame, not on the main document", () => {
  const outer = makeElement("outer")
  const inner = makeElement("inner")
  const hasgard = loadBridge({
    main: makeDocument({ "#pay": outer }),
    frames: { "#checkout": makeDocument({ "#pay": inner }) }
  })

  hasgard.click({ selector: "#pay", frame: ["#checkout"] })

  assert.deepEqual(inner.dispatched, ["pointerdown", "mousedown", "pointerup", "mouseup", "click"])
  assert.deepEqual(outer.dispatched, [], "the same selector in the main document must be untouched")
})

test("omitting frame keeps acting on the main document", () => {
  const outer = makeElement("outer")
  const inner = makeElement("inner")
  const hasgard = loadBridge({
    main: makeDocument({ "#pay": outer }),
    frames: { "#checkout": makeDocument({ "#pay": inner }) }
  })

  hasgard.click({ selector: "#pay" })

  assert.equal(outer.dispatched.length, 5)
  assert.deepEqual(inner.dispatched, [])
})

test("a nested frame chain descends one level per selector", () => {
  // Three documents with the same selector at every level, so a chain that
  // stops short or skips a level lands on a different element and is caught.
  const deep = makeElement("deep")
  const middle = makeElement("middle")
  const top = makeElement("top")

  const innerDoc = makeDocument({ "#field": deep })
  const outerDoc = makeDocument({ "#field": middle })
  const outerQuery = outerDoc.querySelector.bind(outerDoc)
  outerDoc.querySelector = (selector) =>
    selector === "#inner" ? { tagName: "IFRAME", contentDocument: innerDoc } : outerQuery(selector)

  const hasgard = loadBridge({
    main: makeDocument({ "#field": top }),
    frames: { "#outer": outerDoc }
  })

  hasgard.click({ selector: "#field", frame: ["#outer", "#inner"] })

  assert.equal(deep.dispatched.length, 5, "two levels down")
  assert.deepEqual(middle.dispatched, [], "one level down must be untouched")
  assert.deepEqual(top.dispatched, [], "the main document must be untouched")
})

test("a chain stopping one level short lands in the intermediate document", () => {
  const deep = makeElement("deep")
  const middle = makeElement("middle")
  const innerDoc = makeDocument({ "#field": deep })
  const outerDoc = makeDocument({ "#field": middle })
  const outerQuery = outerDoc.querySelector.bind(outerDoc)
  outerDoc.querySelector = (selector) =>
    selector === "#inner" ? { tagName: "IFRAME", contentDocument: innerDoc } : outerQuery(selector)

  const hasgard = loadBridge({ main: makeDocument(), frames: { "#outer": outerDoc } })

  hasgard.click({ selector: "#field", frame: ["#outer"] })

  assert.equal(middle.dispatched.length, 5)
  assert.deepEqual(deep.dispatched, [])
})

test("count counts inside the frame", () => {
  const rows = [makeElement("a"), makeElement("b"), makeElement("c")]
  const hasgard = loadBridge({
    main: makeDocument({}, { ".row": [makeElement("only")] }),
    frames: { "#list": makeDocument({}, { ".row": rows }) }
  })

  assert.deepEqual(hasgard.count({ selector: ".row", frame: ["#list"] }), { count: 3 })
  assert.deepEqual(hasgard.count({ selector: ".row" }), { count: 1 })
})

test("an ordinal index applies within the frame", () => {
  const rows = [makeElement("a"), makeElement("b"), makeElement("c")]
  const hasgard = loadBridge({
    main: makeDocument(),
    frames: { "#list": makeDocument({}, { ".row": rows }) }
  })

  hasgard.click({ selector: ".row", index: -1, frame: ["#list"] })

  assert.equal(rows[2].dispatched.length, 5, "last() must resolve inside the frame")
  assert.deepEqual(rows[0].dispatched, [])
})

test("coordinates resolve against the frame's own viewport", () => {
  const inner = makeElement("hit")
  const hasgard = loadBridge({
    main: makeDocument({ "@10,20": makeElement("outer") }),
    frames: { "#pane": makeDocument({ "@10,20": inner }) }
  })

  hasgard.click({ x: 10, y: 20, frame: ["#pane"] })

  assert.equal(inner.dispatched.length, 5)
})

test("a cross-origin frame says so instead of reporting a missing element", () => {
  // The quiet failure this replaces: falling back to the main document and
  // answering "No element matches selector", which blames the selector for what
  // is actually the same-origin policy.
  const hasgard = loadBridge({
    main: makeDocument(),
    frames: { "#stripe": null }
  })

  assert.throws(() => hasgard.click({ selector: "#pay", frame: ["#stripe"] }), /cross-origin/)
})

test("a missing frame names the frame selector, not the element selector", () => {
  const hasgard = loadBridge({ main: makeDocument() })

  assert.throws(() => hasgard.click({ selector: "#pay", frame: ["#absent"] }), /No frame matches selector: #absent/)
})

test("a selector matching a non-frame element is rejected with its tag", () => {
  const hasgard = loadBridge({
    main: makeDocument(),
    frames: { "#panel": { notAFrame: true } }
  })

  assert.throws(() => hasgard.click({ selector: "#pay", frame: ["#panel"] }), /expected an <iframe>/)
})

test("a non-string frame entry is rejected rather than coerced", () => {
  const hasgard = loadBridge({ main: makeDocument() })

  assert.throws(() => hasgard.click({ selector: "#pay", frame: [42] }), /CSS selector/)
  assert.throws(() => hasgard.click({ selector: "#pay", frame: [""] }), /CSS selector/)
})

test("a bare string frame is accepted as a one-level chain", () => {
  const inner = makeElement("inner")
  const hasgard = loadBridge({
    main: makeDocument(),
    frames: { "#checkout": makeDocument({ "#pay": inner }) }
  })

  hasgard.click({ selector: "#pay", frame: "#checkout" })

  assert.equal(inner.dispatched.length, 5)
})

test("a ref ignores the frame chain, since it already names one node", () => {
  // Re-resolving a ref against a frame would only create a chance for the two to
  // disagree with the snapshot that minted it.
  const inner = makeElement("inner")
  const frameDoc = makeDocument({ "#pay": inner })
  const hasgard = loadBridge({ main: makeDocument(), frames: { "#checkout": frameDoc } })

  const found = hasgard.query({ by: "selector", value: "#pay", frame: ["#checkout"] })
  const ref = found.elements[0].ref

  hasgard.click({ ref })

  assert.equal(inner.dispatched.length, 5)
})

test("query searches the frame document", () => {
  const inner = makeElement("inner", { getAttribute: (name) => (name === "data-testid" ? "pay" : null) })
  const outer = makeElement("outer", { getAttribute: (name) => (name === "data-testid" ? "pay" : null) })
  const hasgard = loadBridge({
    main: makeDocument({}, { "[data-testid]": [outer] }),
    frames: { "#checkout": makeDocument({}, { "[data-testid]": [inner] }) }
  })

  const scoped = hasgard.query({ by: "testid", value: "pay", frame: ["#checkout"] })
  const unscoped = hasgard.query({ by: "testid", value: "pay" })

  assert.equal(scoped.elements.length, 1)
  assert.equal(unscoped.elements.length, 1)
  assert.notEqual(scoped.elements[0].ref, unscoped.elements[0].ref, "different nodes, different refs")
})

test("html, an untargeted scroll and an untargeted wheel act on the frame's own document", () => {
  const scrolls = { outer: [], inner: [] }
  const wheeled = makeElement("inner-root", {
    scrollBy(x, y) {
      scrolls.inner.push(["wheel", x, y])
    }
  })
  const documentWith = (name, html, root) => ({
    ...makeDocument(),
    documentElement: { innerHTML: html, scrollHeight: 2000, clientHeight: 500 },
    body: { scrollHeight: 2000 },
    scrollingElement: root,
    defaultView: {
      scrollX: 0,
      scrollBy(x, y) {
        scrolls[name].push(["scroll", x, y])
      }
    }
  })
  globalThis.WheelEvent = class WheelEvent {
    constructor(type, init) {
      this.type = type
      Object.assign(this, init || {})
    }
  }
  const hasgard = loadBridge({
    main: documentWith("outer", "<p>outer</p>", makeElement("outer-root")),
    frames: { "#checkout": documentWith("inner", "<p>inner</p>", wheeled) }
  })

  assert.equal(hasgard.html({ frame: ["#checkout"] }), "<p>inner</p>")
  assert.equal(hasgard.html({}), "<p>outer</p>")

  hasgard.scroll({ direction: "down", amount: 120, frame: ["#checkout"] })
  hasgard.wheel({ deltaY: 40, frame: ["#checkout"] })
  assert.deepEqual(scrolls.inner, [
    ["scroll", 0, 120],
    ["wheel", 0, 40]
  ])
  assert.deepEqual(scrolls.outer, [], "the main document must not move")
})

test("a drag resolves its source and target inside the frame", () => {
  const outer = { card: makeElement("outer-card"), lane: makeElement("outer-lane") }
  const inner = { card: makeElement("inner-card"), lane: makeElement("inner-lane") }
  globalThis.DragEvent = class DragEvent {
    constructor(type, init) {
      this.type = type
      Object.assign(this, init || {})
    }
  }
  globalThis.DataTransfer = class DataTransfer {}
  const hasgard = loadBridge({
    main: makeDocument({ "#card": outer.card, "#lane": outer.lane }),
    frames: { "#board": makeDocument({ "#card": inner.card, "#lane": inner.lane }) }
  })

  hasgard.drag({ source: { selector: "#card" }, target: { selector: "#lane" }, frame: ["#board"] })

  assert.ok(inner.card.dispatched.includes("dragstart"))
  assert.ok(inner.lane.dispatched.includes("drop"))
  assert.deepEqual(outer.card.dispatched, [])
  assert.deepEqual(outer.lane.dispatched, [])
})

test("a frame's screenshot area is the frame's content box, and an element's is clipped to it", () => {
  const at = (x, y, width, height) => ({
    getBoundingClientRect() {
      return { x, y, width, height }
    }
  })
  const main = makeDocument()
  const hasgard = loadBridge({
    main,
    frames: {
      "#pane": makeDocument({
        "#pay": makeElement("pay", at(12, 30, 80, 24)),
        "#edge": makeElement("edge", at(250, 120, 100, 60)),
        "#below": makeElement("below", at(0, 400, 50, 50))
      })
    },
    boxes: {
      "#pane": {
        clientLeft: 2,
        clientTop: 2,
        // The client box includes the padding: 300x150 of content inside 10px on every side.
        clientWidth: 320,
        clientHeight: 170,
        getBoundingClientRect() {
          return { x: 40, y: 500, width: 324, height: 174 }
        }
      }
    }
  })
  globalThis.window.scrollY = 100
  main.defaultView = {
    getComputedStyle: () => ({ paddingLeft: "10px", paddingTop: "10px", paddingRight: "10px", paddingBottom: "10px" })
  }

  assert.deepEqual(hasgard.screenshotArea({ frame: ["#pane"] }), { x: 52, y: 612, width: 300, height: 150 })
  assert.deepEqual(hasgard.screenshotArea({ frame: "#pane", selector: "#pay" }), {
    x: 64,
    y: 642,
    width: 80,
    height: 24
  })
  // Half out of the frame on both axes: only the part the frame shows.
  assert.deepEqual(hasgard.screenshotArea({ frame: ["#pane"], selector: "#edge" }), {
    x: 302,
    y: 732,
    width: 50,
    height: 30
  })
  assert.throws(() => hasgard.screenshotArea({ frame: ["#pane"], selector: "#below" }), /scrolled out of its frame/)
  assert.throws(() => hasgard.screenshotArea({ frame: ["#pane"], selector: "#absent" }), /Element not found/)
  assert.throws(() => hasgard.screenshotArea({ frame: ["#nowhere"] }), /No frame matches/)
})

test("forms and watch look in the frame's document, not the page's", () => {
  // The page has the form and the list; the frame has neither. Answering for the page would find them.
  const page = makeDocument({ "#signup": makeElement("signup", { tagName: "FORM" }), "#list": makeElement("list") })
  const hasgard = loadBridge({ main: page, frames: { "#pane": makeDocument() } })

  assert.throws(() => hasgard.formDump({ frame: ["#pane"], selector: "#signup" }), /Form not found: #signup/)
  assert.throws(() => hasgard.watch({ frame: ["#pane"], selector: "#list" }), /no element matches selector: #list/)
  assert.throws(() => hasgard.formDump({ frame: ["#absent"] }), /No frame matches/)
})
