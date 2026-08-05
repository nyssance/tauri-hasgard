// Behavioural tests for request routing.
//
// Network activity could be observed but not shaped, so the failure branches an
// app cares most about -- offline, 500, slow-then-empty -- were reachable only
// by breaking the real backend. Routes stub them from the test.
//
// The rules are declarative rather than Playwright's per-request callback: the
// bridge only ever answers requests, so it cannot call out to the test process
// and await a handler while the page sits inside `fetch`.
//
// Run: bun test crates/tauri-plugin-hasgard/js/bridge.route.test.mjs

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

// Fresh globals per test. `realFetch` records what actually reached the network,
// which is how "the route intercepted it" is told from "the route matched but
// the request went out anyway".
function loadBridge() {
  Object.assign(console, REAL_CONSOLE);

  const reachedNetwork = [];
  globalThis.window = {
    fetch(input, init) {
      reachedNetwork.push(typeof input === "string" ? input : input.url);
      return Promise.resolve(new Response("live", { status: 200 }));
    },
  };
  globalThis.document = {
    querySelector() {
      return null;
    },
  };
  function XMLHttpRequestStub() {
    this.listeners = {};
  }
  XMLHttpRequestStub.prototype.open = function () {};
  XMLHttpRequestStub.prototype.send = function () {
    this.sentForReal = true;
  };
  XMLHttpRequestStub.prototype.addEventListener = function (type, fn) {
    (this.listeners[type] ||= []).push(fn);
  };
  XMLHttpRequestStub.prototype.removeEventListener = function () {};
  XMLHttpRequestStub.prototype.dispatchEvent = function (event) {
    for (const fn of this.listeners[event.type] || []) fn.call(this, event);
    return true;
  };
  globalThis.XMLHttpRequest = XMLHttpRequestStub;

  (0, eval)(BRIDGE_SRC);
  return { hasgard: globalThis.window.__HASGARD__, fetch: globalThis.window.fetch, reachedNetwork };
}

test("a fulfilled route answers without the request reaching the network", async () => {
  const { hasgard, fetch, reachedNetwork } = loadBridge();
  hasgard.route({ pattern: "**/api/user", status: 500, body: "boom" });

  const response = await fetch("https://app.test/api/user");

  assert.equal(response.status, 500);
  assert.equal(await response.text(), "boom");
  assert.deepEqual(reachedNetwork, [], "a fulfilled request must not go out");
});

test("an unmatched request still reaches the network untouched", async () => {
  const { hasgard, fetch, reachedNetwork } = loadBridge();
  hasgard.route({ pattern: "**/api/user", status: 500 });

  const response = await fetch("https://app.test/api/orders");

  assert.equal(response.status, 200);
  assert.deepEqual(reachedNetwork, ["https://app.test/api/orders"]);
});

test("an aborted route rejects the way a real network failure does", async () => {
  const { hasgard, fetch, reachedNetwork } = loadBridge();
  hasgard.route({ pattern: "**/analytics/**", action: "abort" });

  await assert.rejects(() => fetch("https://app.test/analytics/collect"), TypeError);
  assert.deepEqual(reachedNetwork, []);
});

test("a routed request is still recorded as network activity", async () => {
  // A test asserting "the app called /api/user" must not go blind the moment
  // that call is stubbed -- the app did issue it and did get an answer.
  const { hasgard, fetch } = loadBridge();
  hasgard.route({ pattern: "**/api/user", status: 503 });

  await fetch("https://app.test/api/user");

  const entries = hasgard.networkRequests();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].url, "https://app.test/api/user");
  assert.equal(entries[0].status, 503);
});

test("an aborted request is recorded with the reason, not silently dropped", async () => {
  const { hasgard, fetch } = loadBridge();
  hasgard.route({ pattern: "**/api/**", action: "abort" });

  await assert.rejects(() => fetch("https://app.test/api/user"));

  const entries = hasgard.networkRequests();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].status, 0);
  assert.match(entries[0].error, /Aborted by route/);
});

test("the first matching rule wins, so a narrow rule survives a later catch-all", async () => {
  const { hasgard, fetch } = loadBridge();
  hasgard.route({ pattern: "**/api/user", status: 201, body: "narrow" });
  hasgard.route({ pattern: "**", status: 500, body: "catch-all" });

  assert.equal(await (await fetch("https://app.test/api/user")).text(), "narrow");
  assert.equal(await (await fetch("https://app.test/api/other")).text(), "catch-all");
});

test("a single star stays inside one path segment", async () => {
  const { hasgard, fetch, reachedNetwork } = loadBridge();
  hasgard.route({ pattern: "https://app.test/api/*", status: 204 });

  assert.equal((await fetch("https://app.test/api/user")).status, 204);
  // Two segments deep: `*` must not cross the separator.
  assert.equal((await fetch("https://app.test/api/user/settings")).status, 200);
  assert.deepEqual(reachedNetwork, ["https://app.test/api/user/settings"]);
});

test("a double star crosses path separators", async () => {
  const { hasgard, fetch } = loadBridge();
  hasgard.route({ pattern: "https://app.test/api/**", status: 204 });

  assert.equal((await fetch("https://app.test/api/user/settings")).status, 204);
});

test("the pattern is anchored, so a prefix match does not intercept a longer path", async () => {
  // Unanchored, `**/api` would also swallow `/v2/api-docs`.
  const { hasgard, fetch, reachedNetwork } = loadBridge();
  hasgard.route({ pattern: "**/api", status: 204 });

  assert.equal((await fetch("https://app.test/v2/api-docs")).status, 200);
  assert.deepEqual(reachedNetwork, ["https://app.test/v2/api-docs"]);
});

test("regex metacharacters in a pattern are literal", async () => {
  const { hasgard, fetch, reachedNetwork } = loadBridge();
  hasgard.route({ pattern: "https://app.test/a+b.json", status: 204 });

  assert.equal((await fetch("https://app.test/a+b.json")).status, 204);
  // `.` must not match `X`, and `a+` must not mean "one or more a".
  assert.equal((await fetch("https://app.test/a+bXjson")).status, 200);
  assert.deepEqual(reachedNetwork, ["https://app.test/a+bXjson"]);
});

test("a method-scoped rule ignores other verbs", async () => {
  const { hasgard, fetch, reachedNetwork } = loadBridge();
  hasgard.route({ pattern: "**/api/user", method: "post", status: 201 });

  assert.equal((await fetch("https://app.test/api/user", { method: "POST" })).status, 201);
  assert.equal((await fetch("https://app.test/api/user")).status, 200);
  assert.deepEqual(reachedNetwork, ["https://app.test/api/user"]);
});

test("times limits how many requests a rule answers", async () => {
  // The shape a retry test needs: fail once, then let the real call through.
  const { hasgard, fetch, reachedNetwork } = loadBridge();
  hasgard.route({ pattern: "**/api/user", status: 500, times: 1 });

  assert.equal((await fetch("https://app.test/api/user")).status, 500);
  assert.equal((await fetch("https://app.test/api/user")).status, 200);
  assert.deepEqual(reachedNetwork, ["https://app.test/api/user"]);
});

test("routes lists the rules with their use counts and what they intercepted", async () => {
  const { hasgard, fetch } = loadBridge();
  hasgard.route({ pattern: "**/api/user", status: 500 });
  await fetch("https://app.test/api/user");

  const listing = hasgard.routes();
  assert.equal(listing.routes.length, 1);
  assert.equal(listing.routes[0].used, 1);
  assert.equal(listing.intercepted.length, 1);
  assert.equal(listing.intercepted[0].url, "https://app.test/api/user");
  assert.equal(listing.intercepted[0].action, "fulfill");
});

test("clearRoutes removes the rules and lets traffic through again", async () => {
  const { hasgard, fetch, reachedNetwork } = loadBridge();
  hasgard.route({ pattern: "**", status: 500 });

  assert.deepEqual(hasgard.clearRoutes(), { removed: 1 });

  assert.equal((await fetch("https://app.test/api/user")).status, 200);
  assert.deepEqual(reachedNetwork, ["https://app.test/api/user"]);
  assert.deepEqual(hasgard.routes().routes, []);
});

test("the fulfilled response carries the requested url and content type", async () => {
  const { hasgard, fetch } = loadBridge();
  hasgard.route({ pattern: "**/api/user", body: '{"id":1}', contentType: "application/json" });

  const response = await fetch("https://app.test/api/user");

  assert.equal(response.headers.get("Content-Type"), "application/json");
  assert.equal(response.url, "https://app.test/api/user");
  assert.deepEqual(await response.json(), { id: 1 });
});

test("an XHR is routed too, and never reaches the network", async () => {
  const { hasgard } = loadBridge();
  hasgard.route({ pattern: "**/api/user", status: 418, body: "teapot" });

  const xhr = new XMLHttpRequest();
  xhr.open("GET", "https://app.test/api/user");
  const seen = [];
  xhr.addEventListener("load", () => seen.push(`load:${xhr.status}:${xhr.responseText}`));
  xhr.send();

  await new Promise(resolve => setTimeout(resolve, 5));

  assert.deepEqual(seen, ["load:418:teapot"]);
  assert.notEqual(xhr.sentForReal, true, "the real send must not run");
});

test("a routed XHR delivers asynchronously, after listeners can be attached", async () => {
  // A synchronous delivery would fire before the caller's own addEventListener
  // line ran, which no real request does.
  const { hasgard } = loadBridge();
  hasgard.route({ pattern: "**", status: 200, body: "ok" });

  const xhr = new XMLHttpRequest();
  xhr.open("GET", "https://app.test/thing");
  xhr.send();
  const seen = [];
  xhr.addEventListener("load", () => seen.push("load"));

  assert.deepEqual(seen, [], "nothing may have fired yet");
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.deepEqual(seen, ["load"]);
});

test("an aborted XHR raises error rather than load", async () => {
  const { hasgard } = loadBridge();
  hasgard.route({ pattern: "**", action: "abort" });

  const xhr = new XMLHttpRequest();
  xhr.open("GET", "https://app.test/thing");
  const seen = [];
  xhr.addEventListener("load", () => seen.push("load"));
  xhr.addEventListener("error", () => seen.push(`error:${xhr.status}`));
  xhr.send();

  await new Promise(resolve => setTimeout(resolve, 5));

  assert.deepEqual(seen, ["error:0"]);
});

test("an empty pattern is rejected rather than matching everything", async () => {
  const { hasgard } = loadBridge();

  assert.throws(() => hasgard.route({ pattern: "" }), /non-empty 'pattern'/);
  assert.throws(() => hasgard.route({}), /non-empty 'pattern'/);
});

test("an unknown action is rejected rather than defaulting to fulfil", () => {
  const { hasgard } = loadBridge();

  assert.throws(() => hasgard.route({ pattern: "**", action: "continue" }), /must be 'fulfill' or 'abort'/);
});

test("an out-of-range status is rejected", () => {
  const { hasgard } = loadBridge();

  assert.throws(() => hasgard.route({ pattern: "**", status: 99 }), /between 100 and 599/);
  assert.throws(() => hasgard.route({ pattern: "**", status: 600 }), /between 100 and 599/);
});

test("a non-positive times is rejected", () => {
  const { hasgard } = loadBridge();

  assert.throws(() => hasgard.route({ pattern: "**", times: 0 }), /positive integer/);
  assert.throws(() => hasgard.route({ pattern: "**", times: 1.5 }), /positive integer/);
});

test("Tauri's own IPC is never routed, even by a catch-all", async () => {
  // Every eval result rides `__TAURI_INTERNALS__.invoke`, which is an HTTP
  // request to the IPC endpoint on several platforms. Without this exclusion a
  // `**` rule swallows the bridge's own replies and the session bricks: the
  // very call that would remove the rule can no longer return.
  const { hasgard, fetch, reachedNetwork } = loadBridge();
  hasgard.route({ pattern: "**", status: 500, body: "blocked" });

  assert.equal((await fetch("ipc://localhost")).status, 200, "the ipc:// scheme must pass through");
  assert.equal((await fetch("http://ipc.localhost/x")).status, 200, "the Windows IPC host must pass through");

  assert.deepEqual(reachedNetwork, ["ipc://localhost", "http://ipc.localhost/x"]);
  // Ordinary traffic is still routed, so the exclusion is narrow.
  assert.equal((await fetch("https://app.test/api/user")).status, 500);
});

test("the IPC exclusion does not swallow a host that merely starts with ipc", async () => {
  const { hasgard, fetch, reachedNetwork } = loadBridge();
  hasgard.route({ pattern: "**", status: 500 });

  assert.equal((await fetch("https://ipc.localhost.evil.test/x")).status, 500);
  assert.deepEqual(reachedNetwork, []);
});
