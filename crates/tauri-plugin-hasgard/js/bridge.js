(() => {
  "use strict";

  if (window.__HASGARD__) return;

  const idMap = new Map();
  let refCounter = 0;

  const _logs = [];
  let _logIdCounter = 0;
  const MAX_LOGS = 500;

  const _networkRequests = [];
  let _netIdCounter = 0;
  const MAX_REQUESTS = 200;

  const ROLE_MAP = {
    A: "link",
    BUTTON: "button",
    SELECT: "combobox",
    TEXTAREA: "textbox",
    IMG: "img",
    H1: "heading",
    H2: "heading",
    H3: "heading",
    H4: "heading",
    H5: "heading",
    H6: "heading",
    P: "paragraph",
    UL: "list",
    OL: "list",
    LI: "listitem",
    TABLE: "table",
    TR: "row",
    TH: "columnheader",
    TD: "cell",
    NAV: "navigation",
    MAIN: "main",
    ASIDE: "complementary",
    FORM: "form",
    DIALOG: "dialog",
    DETAILS: "group",
  };

  const INTERACTIVE_ROLES = new Set([
    "button",
    "link",
    "checkbox",
    "radio",
    "switch",
    "slider",
    "textbox",
    "combobox",
  ]);

  function serializeArg(arg) {
    if (arg === null) return null;
    if (arg === undefined) return null;
    if (typeof arg === 'string' || typeof arg === 'number' || typeof arg === 'boolean') return arg;
    try {
      JSON.stringify(arg);
      return arg;
    } catch (_) {
      return String(arg);
    }
  }

  function extractSource() {
    try {
      const stack = new Error().stack;
      if (!stack) return null;
      // Skip frames: Error constructor, extractSource, console[level] wrapper
      const lines = stack.split('\n');
      for (let i = 3; i < lines.length; i++) {
        const line = lines[i];
        if (line && !line.includes('__HASGARD__')) return line.trim();
      }
      return null;
    } catch (_) { return null; }
  }

  const _originalConsole = {
    log: console.log.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
    info: console.info.bind(console),
  };

  ['log', 'warn', 'error', 'info'].forEach(level => {
    console[level] = function(...args) {
      const entry = {
        id: ++_logIdCounter,
        timestamp: Date.now(),
        level: level,
        args: args.map(serializeArg),
        source: extractSource(),
      };
      _logs.push(entry);
      if (_logs.length > MAX_LOGS) _logs.shift();
      _originalConsole[level].apply(console, args);
    };
  });

  function consoleLogs(options) {
    let result = _logs.slice();
    if (options) {
      if (options.level) {
        result = result.filter(e => e.level === options.level);
      }
      if (options.sinceId) {
        result = result.filter(e => e.id > options.sinceId);
      } else if (options.since) {
        result = result.filter(e => e.timestamp > options.since);
      }
      if (options.last) {
        result = result.slice(-options.last);
      }
    }
    return result;
  }

  function clearLogs() {
    _logs.length = 0;
    return { cleared: true };
  }

  // --- Modal dialogs -------------------------------------------------------
  //
  // `alert`/`confirm`/`prompt` block the webview's main thread until a human
  // clicks. Under automation nobody does, so the app freezes, the bridge stops
  // answering, and every in-flight call dies on a timeout that names the wrong
  // cause. Intercepting them is what makes an app that calls `confirm()`
  // testable at all.
  //
  // The default is to dismiss, matching Playwright: a test that never mentions
  // dialogs should not be silently agreeing to things. Every dialog is recorded
  // either way, so a test can assert on what the app tried to ask.
  const _dialogs = [];
  let _dialogIdCounter = 0;
  const _dialogPolicy = { action: "dismiss", promptText: null };

  function recordDialog(type, message, defaultValue, accepted, returned) {
    const entry = {
      id: ++_dialogIdCounter,
      timestamp: Date.now(),
      type: type,
      message: message == null ? "" : String(message),
      accepted: accepted,
    };
    if (defaultValue !== undefined) entry.defaultValue = String(defaultValue);
    if (returned !== undefined && returned !== null) entry.returned = String(returned);
    _dialogs.push(entry);
    if (_dialogs.length > MAX_LOGS) _dialogs.shift();
    return entry;
  }

  window.alert = function (message) {
    // An alert has one button, so "dismiss" and "accept" are the same act; it is
    // recorded as accepted because the page's only possible outcome is that the
    // user acknowledged it.
    recordDialog("alert", message, undefined, true, undefined);
  };

  window.confirm = function (message) {
    const accepted = _dialogPolicy.action === "accept";
    recordDialog("confirm", message, undefined, accepted, undefined);
    return accepted;
  };

  window.prompt = function (message, defaultValue) {
    const accepted = _dialogPolicy.action === "accept";
    // Accepting with no configured text submits the page's own default, exactly
    // as pressing OK on an untouched prompt would.
    const returned = accepted
      ? (_dialogPolicy.promptText != null ? _dialogPolicy.promptText : (defaultValue == null ? "" : defaultValue))
      : null;
    recordDialog("prompt", message, defaultValue, accepted, returned);
    return returned;
  };

  function dialogs() {
    return { dialogs: _dialogs.slice(), policy: { action: _dialogPolicy.action, promptText: _dialogPolicy.promptText } };
  }

  function clearDialogs() {
    _dialogs.length = 0;
    return { cleared: true };
  }

  function handleDialogs(params) {
    const action = params && params.action;
    if (action !== "accept" && action !== "dismiss") {
      throw new Error('dialog action must be "accept" or "dismiss", got: ' + String(action).slice(0, 64));
    }
    _dialogPolicy.action = action;
    // `promptText` is only meaningful for accept; keeping a stale value around
    // after switching to dismiss would resurface it on the next accept.
    _dialogPolicy.promptText =
      action === "accept" && params.promptText != null ? String(params.promptText) : null;
    return { action: _dialogPolicy.action, promptText: _dialogPolicy.promptText };
  }

  function bodySize(body) {
    if (!body) return 0;
    if (typeof body === "string") return body.length;
    if (body instanceof URLSearchParams) return body.toString().length;
    if (body instanceof Blob) return body.size;
    if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) return body.byteLength;
    return 0;
  }

  const _originalFetch = window.fetch.bind(window);
  window.fetch = function(input, init) {
    const method = (init && init.method) || (input && input.method) || "GET";
    const url = (typeof input === "string") ? input : (input && input.url) || String(input);
    const timestamp = Date.now();
    const requestSize = bodySize(init && init.body);
    return _originalFetch(input, init).then(function(response) {
      const duration_ms = Date.now() - timestamp;
      const status = response.status;
      const responseSize = parseInt(response.headers.get("Content-Length") || "0", 10) || 0;
      const entry = {
        id: ++_netIdCounter,
        timestamp: timestamp,
        method: method,
        url: url,
        status: status,
        duration_ms: duration_ms,
        error: null,
        request_size: requestSize,
        response_size: responseSize,
      };
      _networkRequests.push(entry);
      if (_networkRequests.length > MAX_REQUESTS) _networkRequests.shift();
      return response;
    }, function(err) {
      const duration_ms = Date.now() - timestamp;
      const entry = {
        id: ++_netIdCounter,
        timestamp: timestamp,
        method: method,
        url: url,
        status: 0,
        duration_ms: duration_ms,
        error: err ? err.message : "Network error",
        request_size: requestSize,
        response_size: 0,
      };
      _networkRequests.push(entry);
      if (_networkRequests.length > MAX_REQUESTS) _networkRequests.shift();
      throw err;
    });
  };

  const _origXhrOpen = XMLHttpRequest.prototype.open;
  const _origXhrSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function(method, url) {
    const result = _origXhrOpen.apply(this, arguments);
    this._hasgard = { method: String(method), url: String(url) };
    return result;
  };

  XMLHttpRequest.prototype.send = function(body) {
    if (this._hasgard) {
      const hasgard = this._hasgard;
      const timestamp = Date.now();
      const requestSize = bodySize(body);
      let recorded = false;
      let onLoad, onError, onTimeout, onAbort;
      const cleanup = () => {
        this.removeEventListener("load", onLoad);
        this.removeEventListener("error", onError);
        this.removeEventListener("timeout", onTimeout);
        this.removeEventListener("abort", onAbort);
      };
      const pushEntry = (status, error, responseSize) => {
        if (recorded) return;
        recorded = true;
        cleanup();
        const entry = {
          id: ++_netIdCounter,
          timestamp: timestamp,
          method: hasgard.method,
          url: hasgard.url,
          status: status,
          duration_ms: Date.now() - timestamp,
          error: error,
          request_size: requestSize,
          response_size: responseSize,
        };
        _networkRequests.push(entry);
        if (_networkRequests.length > MAX_REQUESTS) _networkRequests.shift();
      };
      onLoad = () => {
        const cl = parseInt(this.getResponseHeader("Content-Length") || "0", 10) || 0;
        const r = this.response;
        const responseSize = (this.responseType === "" || this.responseType === "text")
          ? ((r && r.length) || cl)
          : (r instanceof ArrayBuffer ? r.byteLength : (r instanceof Blob ? r.size : cl));
        pushEntry(this.status, null, responseSize);
      };
      onError = () => { pushEntry(0, "Network error", 0); };
      onTimeout = () => { pushEntry(0, "Timeout", 0); };
      onAbort = () => { pushEntry(0, "Aborted", 0); };
      this.addEventListener("load", onLoad);
      this.addEventListener("error", onError);
      this.addEventListener("timeout", onTimeout);
      this.addEventListener("abort", onAbort);
      try {
        return _origXhrSend.apply(this, arguments);
      } catch (err) {
        cleanup();
        throw err;
      }
    }
    return _origXhrSend.apply(this, arguments);
  };

  function networkRequests(options) {
    let result = _networkRequests.slice();
    if (options) {
      if (options.filter) {
        result = result.filter(e => e.url.includes(options.filter));
      }
      if (options.failedOnly) {
        result = result.filter(e => e.status >= 400 || e.status === 0 || e.error);
      }
      if (options.sinceId) {
        result = result.filter(e => e.id > options.sinceId);
      }
      if (options.last) {
        result = result.slice(-options.last);
      }
    }
    return result;
  }

  function clearNetwork() {
    _networkRequests.length = 0;
    return { cleared: true };
  }

  function inputRole(el) {
    const t = (el.getAttribute("type") || "text").toLowerCase();
    switch (t) {
      case "hidden":
        return null;
      case "checkbox":
        return "checkbox";
      case "radio":
        return "radio";
      case "range":
        return "slider";
      case "submit":
      case "reset":
      case "button":
        return "button";
      default:
        return "textbox";
    }
  }

  function getRole(el) {
    const explicit = el.getAttribute("role");
    if (explicit) return explicit;
    if (el.tagName === "INPUT") return inputRole(el);
    return ROLE_MAP[el.tagName] || null;
  }

  function getName(el) {
    const label = el.getAttribute("aria-label");
    if (label) return label.trim().slice(0, 50);

    const labelledBy = el.getAttribute("aria-labelledby");
    if (labelledBy) {
      const parts = labelledBy
        .split(/\s+/)
        .map((id) => {
          const ref = document.getElementById(id);
          return ref ? ref.textContent : "";
        })
        .filter(Boolean);
      if (parts.length > 0) return parts.join(" ").trim().slice(0, 50);
    }

    if (el.tagName === "IMG") {
      const alt = el.getAttribute("alt");
      if (alt) return alt.trim().slice(0, 50);
    }

    if (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT") {
      if (el.labels && el.labels.length > 0) {
        const labelText = Array.from(el.labels)
          .map((label) => label.textContent || "")
          .join(" ")
          .replace(/\s+/g, " ")
          .trim();
        if (labelText) return labelText.slice(0, 50);
      }
      const placeholder = el.getAttribute("placeholder");
      if (placeholder) return placeholder.trim().slice(0, 50);
    }

    const text = el.textContent || "";
    const trimmed = text.replace(/\s+/g, " ").trim();
    return trimmed.slice(0, 50) || null;
  }

  function isInteractiveElement(el) {
    const tag = el.tagName;
    if (tag === "INPUT") {
      const t = (el.getAttribute("type") || "text").toLowerCase();
      return t !== "hidden";
    }
    if (
      tag === "BUTTON" ||
      tag === "SELECT" ||
      tag === "TEXTAREA" ||
      tag === "A"
    ) {
      return true;
    }
    if (el.hasAttribute("tabindex")) return true;
    const role = el.getAttribute("role");
    return role ? INTERACTIVE_ROLES.has(role) : false;
  }

  // Build one wire element and register its ref. `snapshot` and `query` both go
  // through here so the two can never drift into reporting different shapes for
  // the same node. Registration appends to `idMap`: only `snapshot` resets it,
  // which keeps the documented "refs are valid until the next snapshot"
  // contract true for query-issued refs as well.
  //
  // `existingRef` re-describes a node under the ref it already holds. `filter`
  // uses it because its input refs are registered by definition: minting new
  // ones would grow `idMap` on every link of a filter chain and make the same
  // element answer to a different name after each refinement.
  function describeElement(node, role, depth, existingRef) {
    let ref = existingRef;
    if (!ref) {
      refCounter++;
      ref = "e" + refCounter;
      idMap.set(ref, node);
    }

    const entry = { ref: ref, role: role, depth: depth };
    const name = getName(node);
    if (name) entry.name = name;
    // `value` is an IDL property whose type varies by element: a string for
    // form controls, but a number for `<li>` (ordinal), `<progress>`, and
    // `<meter>`. Coerce to string so the wire format matches the plugin's
    // `SnapshotElement.value: Option<String>` contract (#120).
    if (node.value !== undefined && node.value !== "") entry.value = String(node.value);
    if (node.tagName === "INPUT") {
      var inputType = (node.getAttribute("type") || "text").toLowerCase();
      if (inputType === "checkbox" || inputType === "radio") {
        entry.checked = node.checked;
      }
    }
    if (node.disabled) entry.disabled = true;
    return entry;
  }

  function snapshot(options) {
    const interactive = (options && options.interactive) || false;
    const selector = (options && options.selector) || null;
    const maxDepth = (options && options.depth != null) ? options.depth : 255;

    refCounter = 0;
    idMap.clear();

    const doc = frameDocument(options && options.frame);
    var root;
    if (selector) {
      try {
        root = doc.querySelector(selector);
      } catch (e) {
        throw new Error("Invalid selector: " + selector);
      }
    } else {
      root = doc.body;
    }
    if (!root) return { elements: [] };

    const elements = [];

    function walk(node, currentDepth) {
      if (currentDepth > maxDepth) return;
      if (node.nodeType !== Node.ELEMENT_NODE) return;

      const role = getRole(node);
      const isInteractive = isInteractiveElement(node);

      if (interactive && !isInteractive) {
        for (const child of node.children) {
          walk(child, currentDepth + 1);
        }
        return;
      }

      if (role) {
        elements.push(describeElement(node, role, currentDepth));
      }

      for (const child of node.children) {
        walk(child, currentDepth + 1);
      }
    }

    walk(root, 0);
    return { elements: elements };
  }

  // `selector` is a dimension so that every locator kind — CSS, role, or
  // text-ish — can be resolved down to refs by one code path. `filter` then
  // refines any of them uniformly instead of needing a per-kind implementation.
  var QUERY_DIMENSIONS = ["text", "label", "placeholder", "testid", "alt", "title", "selector"];

  function normalizeForMatch(value) {
    return String(value == null ? "" : value).replace(/\s+/g, " ").trim();
  }

  // Playwright's rule: non-exact is a case-insensitive substring, exact is a
  // case-sensitive equality. Whitespace is normalized on both sides either way.
  function matchesQuery(actual, wanted, exact) {
    var a = normalizeForMatch(actual);
    var w = normalizeForMatch(wanted);
    if (exact) return a === w;
    return a.toLowerCase().indexOf(w.toLowerCase()) !== -1;
  }

  function elementDepth(node) {
    var depth = 0;
    var current = node.parentElement;
    while (current && current !== document.body) {
      depth++;
      current = current.parentElement;
    }
    return depth;
  }

  // The accessible label of a form control, from every source Playwright's
  // getByLabel consults. Deliberately *not* getName(): that collapses six
  // sources into one and truncates to 50 characters, so a control carrying both
  // an aria-label and a <label> becomes findable by only one of them.
  function labelTextsOf(el) {
    var texts = [];
    var aria = el.getAttribute && el.getAttribute("aria-label");
    if (aria) texts.push(aria);
    var labelledBy = el.getAttribute && el.getAttribute("aria-labelledby");
    if (labelledBy) {
      labelledBy.split(/\s+/).forEach(function (id) {
        var ref = document.getElementById(id);
        if (ref) texts.push(ref.textContent || "");
      });
    }
    if (el.labels) {
      for (var i = 0; i < el.labels.length; i++) {
        texts.push(el.labels[i].textContent || "");
      }
    }
    return texts;
  }

  function queryCandidates(doc, by, value) {
    if (by === "selector") return doc.querySelectorAll(value);
    if (by === "placeholder") return doc.querySelectorAll("[placeholder]");
    if (by === "testid") return doc.querySelectorAll("[data-testid]");
    if (by === "alt") return doc.querySelectorAll("[alt]");
    if (by === "title") return doc.querySelectorAll("[title]");
    if (by === "label") return doc.querySelectorAll("input, textarea, select, button, meter, output, progress");
    return doc.querySelectorAll("*");
  }

  function queryMatches(el, by, value, exact) {
    // `querySelectorAll` already applied the predicate for this dimension.
    if (by === "selector") return true;
    if (by === "placeholder") return matchesQuery(el.getAttribute("placeholder"), value, exact);
    if (by === "alt") return matchesQuery(el.getAttribute("alt"), value, exact);
    if (by === "title") return matchesQuery(el.getAttribute("title"), value, exact);
    // A test id is an identifier, not prose: substring matching on it invites
    // "save" quietly selecting "save-draft", so this dimension is always exact.
    if (by === "testid") return normalizeForMatch(el.getAttribute("data-testid")) === normalizeForMatch(value);
    if (by === "label") {
      return labelTextsOf(el).some(function (text) {
        return matchesQuery(text, value, exact);
      });
    }
    return matchesQuery(el.textContent, value, exact);
  }

  function query(params) {
    var by = params && params.by;
    if (QUERY_DIMENSIONS.indexOf(by) === -1) {
      throw new Error("query: 'by' must be one of " + QUERY_DIMENSIONS.join(", ") + ", got: " + String(by).slice(0, 64));
    }
    if (params.value == null) throw new Error("query requires a 'value'");
    var exact = !!params.exact;

    var matched = [];
    var candidates = queryCandidates(frameDocument(params.frame), by, params.value);
    for (var i = 0; i < candidates.length; i++) {
      if (queryMatches(candidates[i], by, params.value, exact)) matched.push(candidates[i]);
    }

    // Text matching walks every element, so an ancestor matches whenever its
    // descendant does — <html> and <body> would match everything. Keep only the
    // innermost matches, which is the element a user would point at.
    if (by === "text" && matched.length > 1) {
      matched = matched.filter(function (el) {
        return !matched.some(function (other) {
          return other !== el && el.contains(other);
        });
      });
    }

    return {
      elements: matched.map(function (el) {
        return describeElement(el, getRole(el) || "generic", elementDepth(el));
      })
    };
  }

  // Refine an already-resolved set of refs by their rendered text.
  //
  // Filtering by ref rather than re-running the original locator keeps this one
  // implementation valid for every locator kind, and keeps `snapshot` free of a
  // per-element text field that would bloat every unrelated call.
  //
  // `hasText` keeps an element whose subtree text matches; `hasNotText` drops
  // it. Both may be supplied — an element must satisfy each to survive, which
  // is what makes `filter({hasText}).filter({hasNotText})` compose.
  function filterElements(params) {
    var refs = (params && params.refs) || [];
    if (!Array.isArray(refs)) throw new Error("filter requires a 'refs' array");
    var exact = !!(params && params.exact);
    var hasText = params ? params.hasText : null;
    var hasNotText = params ? params.hasNotText : null;
    if (hasText == null && hasNotText == null) {
      throw new Error("filter requires 'hasText' or 'hasNotText'");
    }

    var kept = [];
    for (var i = 0; i < refs.length; i++) {
      // A stale ref means the DOM moved under the caller between resolution and
      // refinement. Dropping it silently would turn that race into a wrong
      // answer, so surface it the same way acting on a stale ref would.
      var el = requireEl(refs[i]);
      var text = el.textContent;
      if (hasText != null && !matchesQuery(text, hasText, exact)) continue;
      if (hasNotText != null && matchesQuery(text, hasNotText, exact)) continue;
      kept.push({ el: el, ref: refs[i] });
    }

    return {
      elements: kept.map(function (entry) {
        return describeElement(entry.el, getRole(entry.el) || "generic", elementDepth(entry.el), entry.ref);
      })
    };
  }

  // Resolve the document a frame-scoped operation should query.
  //
  // `frame` is a chain of CSS selectors, one per nesting level, so an element
  // two iframes deep names both hosts. Omitting it keeps the main document, so
  // every existing caller is unaffected.
  //
  // A cross-origin frame exposes a null `contentDocument`. The same-origin
  // policy binds injected script exactly as it binds the page's own, so this is
  // a wall rather than a gap -- say so, instead of reporting the empty result
  // that a silent fallback to the main document would produce.
  function frameDocument(frame) {
    if (frame == null) return document;
    var chain = Array.isArray(frame) ? frame : [frame];
    var doc = document;
    for (var i = 0; i < chain.length; i++) {
      var selector = chain[i];
      if (typeof selector !== "string" || selector === "") {
        throw new Error("frame must be a CSS selector, or an array of them for nested frames");
      }
      var host = doc.querySelector(selector);
      if (!host) throw new Error("No frame matches selector: " + selector);
      if (!("contentDocument" in host)) {
        var tag = String(host.tagName || "?").toLowerCase();
        throw new Error("Selector " + selector + " matched a <" + tag + ">, expected an <iframe> or <frame>");
      }
      var inner = host.contentDocument;
      if (!inner) {
        throw new Error(
          "Frame " + selector + " is cross-origin, so its document cannot be reached from page script. " +
          "Same-origin frames only."
        );
      }
      doc = inner;
    }
    return doc;
  }

  function resolve(ref) {
    return idMap.get(ref) || null;
  }

  function requireEl(ref) {
    const el = idMap.get(ref);
    if (!el) throw new Error("Unknown ref: " + ref);
    return el;
  }

  // `index` selects among *all* selector matches, so an ordinal locator
  // (`nth`/`first`/`last`) resolves in the same round trip that acts on the
  // element. Counting first and indexing second would let the DOM change in
  // between and silently act on a different node. A negative index counts back
  // from the end, which is what makes `last()` a single call.
  function selectorAt(doc, selector, index) {
    var matches = doc.querySelectorAll(selector);
    var position = index < 0 ? matches.length + index : index;
    var el = matches[position];
    if (!el) {
      throw new Error(
        "No element at index " + index + " for selector: " + selector + " (" + matches.length + " matched)"
      );
    }
    return el;
  }

  function resolveTarget(params) {
    // A ref already identifies one node, whichever document minted it, so the
    // frame chain is not consulted -- re-resolving would only be a chance to
    // disagree with the snapshot that produced the ref.
    if (params.ref) return requireEl(params.ref);
    var doc = frameDocument(params.frame);
    if (params.selector) {
      if (params.index != null) {
        if (typeof params.index !== "number" || !Number.isInteger(params.index)) {
          throw new Error("index must be an integer");
        }
        return selectorAt(doc, params.selector, params.index);
      }
      var el = doc.querySelector(params.selector);
      if (!el) throw new Error("No element matches selector: " + params.selector);
      return el;
    }
    if (params.x != null && params.y != null) {
      // Coordinates are relative to the frame's own viewport, matching how the
      // frame's scripts see them.
      var pointEl = doc.elementFromPoint(params.x, params.y);
      if (!pointEl) throw new Error("No element at (" + params.x + "," + params.y + ")");
      return pointEl;
    }
    throw new Error("No ref, selector, or coordinates provided");
  }

  function dispatchPointerEvent(el, type, options) {
    const init = Object.assign({
      bubbles: true,
      cancelable: true,
      composed: true,
      pointerId: 1,
      pointerType: "mouse",
      isPrimary: true,
      button: 0,
      buttons: type === "pointerdown" ? 1 : 0,
      view: window,
      clientX: 0,
      clientY: 0,
    }, options || {});

    if (typeof PointerEvent === "function") {
      return el.dispatchEvent(new PointerEvent(type, init));
    }

    const event = new MouseEvent(type, init);
    try {
      Object.defineProperty(event, "pointerId", { value: init.pointerId });
      Object.defineProperty(event, "pointerType", { value: init.pointerType });
      Object.defineProperty(event, "isPrimary", { value: init.isPrimary });
    } catch (_) {}
    return el.dispatchEvent(event);
  }

  // MouseEvent.button (which one changed state) and MouseEvent.buttons (bitmask
  // of what is held) use different numbering; a right press is button 2 and
  // buttons 2, but a middle press is button 1 and buttons 4.
  const MOUSE_BUTTONS = {
    left: { button: 0, mask: 1 },
    middle: { button: 1, mask: 4 },
    right: { button: 2, mask: 2 },
  };

  const MODIFIER_FLAGS = {
    Alt: "altKey",
    Control: "ctrlKey",
    Meta: "metaKey",
    Shift: "shiftKey",
  };

  function modifierInit(modifiers) {
    const init = { altKey: false, ctrlKey: false, metaKey: false, shiftKey: false };
    if (!modifiers) return init;
    if (!Array.isArray(modifiers)) throw new Error("modifiers must be an array");
    for (var i = 0; i < modifiers.length; i++) {
      const flag = MODIFIER_FLAGS[modifiers[i]];
      if (!flag) {
        throw new Error(
          "Unknown modifier " + JSON.stringify(modifiers[i]) +
          ". Expected one of Alt, Control, Meta, Shift"
        );
      }
      init[flag] = true;
    }
    return init;
  }

  function mouseButton(name) {
    if (name == null) return MOUSE_BUTTONS.left;
    const spec = MOUSE_BUTTONS[name];
    if (!spec) {
      throw new Error(
        "Unknown button " + JSON.stringify(name) + ". Expected left, middle, or right"
      );
    }
    return spec;
  }

  // Where inside the element the pointer lands. `position` is element-relative,
  // matching Playwright; `params.x/y` stay viewport-absolute because they are
  // also the coordinate *target*, resolved before we ever see the element.
  function clickPoint(el, params) {
    const rect = el.getBoundingClientRect();
    if (params.position) {
      const px = params.position.x;
      const py = params.position.y;
      if (typeof px !== "number" || typeof py !== "number") {
        throw new Error("position must be { x: number, y: number }");
      }
      return { x: rect.left + px, y: rect.top + py };
    }
    return {
      x: params.x != null ? params.x : rect.left + rect.width / 2,
      y: params.y != null ? params.y : rect.top + rect.height / 2,
    };
  }

  function click(params) {
    const el = resolveTarget(params);
    el.scrollIntoView({ behavior: "instant", block: "center", inline: "center" });
    const point = clickPoint(el, params);
    const x = point.x;
    const y = point.y;
    const button = mouseButton(params.button);
    const modifiers = modifierInit(params.modifiers);
    const clickCount = params.clickCount != null ? params.clickCount : 1;
    if (typeof clickCount !== "number" || clickCount < 1 || clickCount % 1 !== 0) {
      throw new Error("clickCount must be a positive integer");
    }
    const mouseInit = function(options) {
      return Object.assign({
        bubbles: true,
        cancelable: true,
        composed: true,
      }, options);
    };

    // A double click is one gesture, not two: the browser raises detail 1 then
    // detail 2 on the *same* element, then a single dblclick. Replaying click()
    // twice would reset detail to 1 and never produce dblclick, so listeners
    // that distinguish the two would see the wrong thing.
    for (var n = 1; n <= clickCount; n++) {
      const downInit = Object.assign({
        clientX: x,
        clientY: y,
        button: button.button,
        buttons: button.mask,
        detail: n,
        view: window,
      }, modifiers);
      const upInit = Object.assign({}, downInit, { buttons: 0 });

      const pointerDownOk = dispatchPointerEvent(el, "pointerdown", downInit);
      if (pointerDownOk) {
        const mouseDownOk = el.dispatchEvent(new MouseEvent("mousedown", mouseInit(downInit)));
        if (mouseDownOk && typeof el.focus === "function") {
          el.focus();
        }
      }
      dispatchPointerEvent(el, "pointerup", upInit);
      if (pointerDownOk) {
        el.dispatchEvent(new MouseEvent("mouseup", mouseInit(upInit)));
      }
      // Only the primary button produces a `click` event. A right press raises
      // `contextmenu` instead, and a middle press raises `auxclick` -- binding a
      // right-click menu to `click` is exactly the bug this lets tests catch.
      if (button.button === 0) {
        dispatchPointerEvent(el, "click", upInit);
      } else {
        el.dispatchEvent(new MouseEvent("auxclick", mouseInit(upInit)));
        if (button.button === 2) {
          el.dispatchEvent(new MouseEvent("contextmenu", mouseInit(upInit)));
        }
      }
    }

    if (clickCount >= 2) {
      el.dispatchEvent(new MouseEvent("dblclick", mouseInit(Object.assign({
        clientX: x,
        clientY: y,
        button: button.button,
        buttons: 0,
        detail: 2,
        view: window,
      }, modifiers))));
    }
    return { ok: true };
  }

  // Resolve the native `value` setter for the element's actual prototype.
  // Frameworks (React, Preact-signals, Vue) sometimes install an instance-level
  // setter that swallows programmatic writes; preferring the prototype setter
  // bypasses that override and keeps WebIDL [LegacyUnforgeable] brand checks
  // happy on <input>, <textarea>, and <select> alike (#85).
  function nativeValueSetter(el) {
    const proto = Object.getPrototypeOf(el);
    const desc = proto && Object.getOwnPropertyDescriptor(proto, "value");
    return desc && typeof desc.set === "function" ? desc.set : null;
  }

  function fill(params) {
    const el = resolveTarget(params);
    el.focus();
    const setter = nativeValueSetter(el);
    if (setter) {
      setter.call(el, params.value);
    } else {
      el.value = params.value;
    }
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return { ok: true };
  }

  function typeText(params) {
    const el = resolveTarget(params);
    el.focus();
    const setter = nativeValueSetter(el);
    for (const ch of params.text) {
      el.dispatchEvent(new KeyboardEvent("keydown", { key: ch, bubbles: true }));
      if (setter) {
        setter.call(el, el.value + ch);
      } else {
        el.value += ch;
      }
      el.dispatchEvent(new InputEvent("input", { data: ch, inputType: "insertText", bubbles: true }));
      el.dispatchEvent(new KeyboardEvent("keyup", { key: ch, bubbles: true }));
    }
    return { ok: true };
  }

  function select(params) {
    const el = resolveTarget(params);
    // The CLI/tool contract is "select acts on <select>". Before the
    // nativeValueSetter refactor, this guarantee fell out of the WebIDL brand
    // check on `HTMLSelectElement.prototype.value` (calling that setter on an
    // <input>/<textarea> threw). The new helper picks the setter from the
    // element's own prototype, so a misrouted selector would now silently
    // succeed against a non-<select> and report ok while no option was
    // actually selected. Re-introduce the type guard with a tag-based check
    // (realm-safe): an `instanceof` constructor check would be tied to the
    // host realm and would reject valid <select> elements coming from another
    // window/iframe realm, which is exactly the case nativeValueSetter was
    // built to support.
    const tag = el && el.tagName ? String(el.tagName).toLowerCase() : "";
    if (tag !== "select") {
      const reported = (tag || String(el)).slice(0, 64);
      throw new Error("select requires a <select> element, got: " + reported);
    }
    // Resolve the target option before mutating anything. Setting
    // `HTMLSelectElement.value` to a string that matches no option `value`
    // silently yields `value=""` / `selectedIndex=-1` per the DOM spec, so
    // "set then trust" reports success on a no-op (#113). Match the option
    // first — by `value`, then by visible label — and error if none matches so
    // a reported `ok` always means an option was actually selected.
    const wanted = String(params.value);
    const options = Array.from(el.options || []);
    const matched =
      options.find((o) => o.value === wanted) ||
      options.find((o) => (o.text || "").trim() === wanted.trim());
    if (!matched) {
      throw new Error("select: no option matches " + JSON.stringify(params.value));
    }
    const setter = nativeValueSetter(el);
    if (setter) {
      setter.call(el, matched.value);
    } else {
      el.value = matched.value;
    }
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return { ok: true };
  }

  // Without `checked` this toggles, which is the documented CLI contract
  // ("Toggle a checkbox"). With an explicit `checked` it drives the box to that
  // state and is a no-op when it is already there, which is what a Playwright
  // `check()`/`uncheck()` promises. A toggle cannot express either of those:
  // running it twice undoes itself, so a retry silently inverts the result.
  function check(params) {
    const el = resolveTarget(params);
    if (params.checked != null) {
      if (typeof params.checked !== "boolean") {
        throw new Error("check: 'checked' must be a boolean");
      }
      if (el.checked === params.checked) return { ok: true };
      el.checked = params.checked;
    } else {
      el.checked = !el.checked;
    }
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return { ok: true };
  }

  function disabled(params) {
    const el = resolveTarget(params);
    const aria = typeof el.getAttribute === "function" ? el.getAttribute("aria-disabled") : null;
    return { disabled: !!el.disabled || aria === "true" };
  }

  function boundingBox(params) {
    const rect = resolveTarget(params).getBoundingClientRect();
    return { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
  }

  function focus(params) {
    const el = resolveTarget(params);
    if (typeof el.focus !== "function") throw new Error("focus: element is not focusable");
    el.focus();
    return { ok: true };
  }

  function blur(params) {
    const el = resolveTarget(params);
    if (typeof el.blur !== "function") throw new Error("blur: element cannot be blurred");
    el.blur();
    return { ok: true };
  }

  function hover(params) {
    const el = resolveTarget(params);
    const rect = el.getBoundingClientRect();
    const x = params.x != null ? params.x : rect.left + rect.width / 2;
    const y = params.y != null ? params.y : rect.top + rect.height / 2;
    const init = { clientX: x, clientY: y, button: 0, buttons: 0, view: window };
    const mouseInit = Object.assign({ bubbles: true, cancelable: true, composed: true }, init);

    dispatchPointerEvent(el, "pointerover", init);
    // `pointerenter`/`mouseenter` do not bubble, matching the real event model.
    dispatchPointerEvent(el, "pointerenter", Object.assign({}, init, { bubbles: false }));
    el.dispatchEvent(new MouseEvent("mouseover", mouseInit));
    el.dispatchEvent(new MouseEvent("mouseenter", Object.assign({}, mouseInit, { bubbles: false })));
    dispatchPointerEvent(el, "pointermove", init);
    el.dispatchEvent(new MouseEvent("mousemove", mouseInit));
    return { ok: true };
  }

  // Kept as its own command for the CLI and for callers that predate
  // `click({ clickCount })`; the gesture itself now has one implementation.
  function dblclick(params) {
    return click(Object.assign({}, params, { clickCount: 2 }));
  }

  function scroll(options) {
    const dir = (options && options.direction) || "down";
    const amount = (options && options.amount) || 300;
    // Route through `resolveTarget` rather than `ref` alone so a selector or
    // point locator can scroll its own element; with `ref`-only, every
    // selector-based caller silently scrolled the document instead.
    const hasTarget =
      options && (options.ref || options.selector || (options.x != null && options.y != null));
    const target = hasTarget ? resolveTarget(options) : window;

    if (dir === "top") {
      if (target === window) {
        target.scrollTo(window.scrollX, 0);
      } else {
        target.scrollTop = 0;
      }
      return { ok: true };
    }
    if (dir === "bottom") {
      if (target === window) {
        const docEl = document.documentElement;
        const body = document.body;
        const fullHeight = Math.max(
          docEl ? docEl.scrollHeight : 0,
          body ? body.scrollHeight : 0
        );
        const viewportHeight = docEl ? docEl.clientHeight : window.innerHeight;
        const max = fullHeight - viewportHeight;
        target.scrollTo(window.scrollX, Math.max(0, max));
      } else {
        target.scrollTop = Math.max(0, target.scrollHeight - target.clientHeight);
      }
      return { ok: true };
    }
    if (dir !== "up" && dir !== "down" && dir !== "left" && dir !== "right") {
      const safeDir = String(dir).slice(0, 64);
      throw new Error("Unknown scroll direction: " + safeDir + " (expected up|down|left|right|top|bottom)");
    }
    const dx = (dir === "left" ? -amount : dir === "right" ? amount : 0);
    const dy = (dir === "up" ? -amount : dir === "down" ? amount : 0);
    target.scrollBy(dx, dy);
    return { ok: true };
  }

  function drag(params) {
    var source = resolveTarget(params.source || params);
    var sourceRect = source.getBoundingClientRect();
    var startX = sourceRect.left + sourceRect.width / 2;
    var startY = sourceRect.top + sourceRect.height / 2;

    var endX, endY, dropTarget;

    if (params.target) {
      dropTarget = resolveTarget(params.target);
      var targetRect = dropTarget.getBoundingClientRect();
      endX = targetRect.left + targetRect.width / 2;
      endY = targetRect.top + targetRect.height / 2;
    } else if (params.offset) {
      // elementFromPoint below is viewport-bound: a start point outside the
      // viewport would make the lookup miss (#130). Scroll the source into
      // view first, like a user would, then recompute the start point.
      // "instant" so a page-level `scroll-behavior: smooth` cannot defer the
      // scroll past the synchronous rect recompute.
      var docEl = document.documentElement;
      var viewportWidth = docEl.clientWidth;
      var viewportHeight = docEl.clientHeight;
      if (startX < 0 || startY < 0 || startX >= viewportWidth || startY >= viewportHeight) {
        source.scrollIntoView({ behavior: "instant", block: "center", inline: "center" });
        sourceRect = source.getBoundingClientRect();
        startX = sourceRect.left + sourceRect.width / 2;
        startY = sourceRect.top + sourceRect.height / 2;
      }
      var offsetX = params.offset.x || 0;
      var offsetY = params.offset.y || 0;
      endX = startX + offsetX;
      endY = startY + offsetY;
      dropTarget = document.elementFromPoint(endX, endY);
      if (!dropTarget) {
        var pointLabel = "(" + Math.round(endX) + "," + Math.round(endY) + ")";
        if (endX < 0 || endY < 0 || endX >= viewportWidth || endY >= viewportHeight) {
          throw new Error("Drop point " + pointLabel + " is outside the viewport (" +
            viewportWidth + "x" + viewportHeight + ") — reduce the offset");
        }
        throw new Error("No element at drop point " + pointLabel +
          " for offset (" + offsetX + "," + offsetY + ")");
      }
    } else {
      throw new Error("drag requires target or offset");
    }

    var dt = typeof DataTransfer === "function" ? new DataTransfer() : new ClipboardEvent("").clipboardData;
    source.dispatchEvent(new MouseEvent("mousedown", { clientX: startX, clientY: startY, bubbles: true }));
    source.dispatchEvent(new DragEvent("dragstart", { clientX: startX, clientY: startY, dataTransfer: dt, bubbles: true }));
    source.dispatchEvent(new DragEvent("dragleave", { clientX: endX, clientY: endY, dataTransfer: dt, bubbles: true }));
    dropTarget.dispatchEvent(new DragEvent("dragenter", { clientX: endX, clientY: endY, dataTransfer: dt, bubbles: true, cancelable: true }));
    dropTarget.dispatchEvent(new DragEvent("dragover", { clientX: endX, clientY: endY, dataTransfer: dt, bubbles: true, cancelable: true }));
    dropTarget.dispatchEvent(new DragEvent("drop", { clientX: endX, clientY: endY, dataTransfer: dt, bubbles: true, cancelable: true }));
    source.dispatchEvent(new DragEvent("dragend", { clientX: endX, clientY: endY, dataTransfer: dt, bubbles: true }));
    return { ok: true };
  }

  function drop(params) {
    var el = resolveTarget(params);
    var rect = el.getBoundingClientRect();
    var x = rect.left + rect.width / 2;
    var y = rect.top + rect.height / 2;
    var dt = buildFileList(params.files);

    el.dispatchEvent(new DragEvent("dragenter", { clientX: x, clientY: y, dataTransfer: dt, bubbles: true, cancelable: true }));
    el.dispatchEvent(new DragEvent("dragover", { clientX: x, clientY: y, dataTransfer: dt, bubbles: true, cancelable: true }));
    el.dispatchEvent(new DragEvent("drop", { clientX: x, clientY: y, dataTransfer: dt, bubbles: true, cancelable: true }));
    return { ok: true };
  }

  // Turn `{name, data}` payloads (data is base64) into real `File` objects.
  // Shared by `drop` and `setInputFiles` so both produce identical `FileList`
  // contents for the same input.
  function buildFileList(files) {
    var dt = typeof DataTransfer === "function" ? new DataTransfer() : new ClipboardEvent("").clipboardData;
    for (var i = 0; i < (files || []).length; i++) {
      var f = files[i];
      var binary = atob(f.data);
      var bytes = new Uint8Array(binary.length);
      for (var j = 0; j < binary.length; j++) bytes[j] = binary.charCodeAt(j);
      dt.items.add(new File([bytes], f.name, { type: f.type || "application/octet-stream" }));
    }
    return dt;
  }

  // Populate an `<input type="file">` without a native file chooser, which a
  // headless-less webview gives no way to drive.
  //
  // `input.files` is settable from a `DataTransfer`'s `FileList` — the same
  // mechanism a real drop uses — so the page sees a genuine `FileList` and its
  // `change` handler cannot tell this from a user's pick. An empty array clears
  // the selection, which is how Playwright spells "deselect everything".
  function setInputFiles(params) {
    var el = resolveTarget(params);
    if (el.tagName !== "INPUT" || String(el.type).toLowerCase() !== "file") {
      // Assigning `.files` to anything else silently no-ops, so the caller would
      // get `ok: true` and an unchanged page.
      throw new Error(
        "setInputFiles requires an <input type=\"file\">, got: " +
          String(el.tagName).toLowerCase() +
          (el.type ? '[type="' + String(el.type).slice(0, 32) + '"]' : "")
      );
    }
    var files = (params && params.files) || [];
    if (!el.multiple && files.length > 1) {
      // The browser would keep only the last file; failing loudly beats
      // silently dropping the caller's other files.
      throw new Error("setInputFiles got " + files.length + " files but the input is not [multiple]");
    }
    el.files = buildFileList(files).files;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return { ok: true, count: el.files.length };
  }

  // Scroll by wheel, reproducing the browser's own two-step: the page sees a
  // `wheel` event first and may cancel it; only if it does not does the scroll
  // actually happen.
  //
  // A synthetic `WheelEvent` alone would fire listeners but never move the
  // scrollport (untrusted events do not drive default actions), so a caller
  // testing an infinite-scroll list would see handlers run and nothing load.
  // Applying the scroll ourselves — and only when the event was not
  // `preventDefault`ed — keeps both halves of the contract.
  function wheel(params) {
    var hasTarget =
      params && (params.ref || params.selector || (params.x != null && params.y != null));
    var el = hasTarget ? resolveTarget(params) : document.scrollingElement || document.documentElement;
    var deltaX = (params && params.deltaX) || 0;
    var deltaY = (params && params.deltaY) || 0;
    var rect = el.getBoundingClientRect ? el.getBoundingClientRect() : { left: 0, top: 0, width: 0, height: 0 };

    var notCancelled = el.dispatchEvent(
      new WheelEvent("wheel", {
        deltaX: deltaX,
        deltaY: deltaY,
        deltaMode: 0,
        clientX: rect.left + rect.width / 2,
        clientY: rect.top + rect.height / 2,
        bubbles: true,
        cancelable: true,
        composed: true,
        view: window
      })
    );

    if (notCancelled) el.scrollBy(deltaX, deltaY);
    return { ok: true, defaultPrevented: !notCancelled };
  }

  function text(params) {
    return resolveTarget(params).textContent || "";
  }

  function html(params) {
    if (params && (params.ref || params.selector)) {
      return resolveTarget(params).innerHTML;
    }
    return document.documentElement.innerHTML;
  }

  function value(params) {
    return resolveTarget(params).value || "";
  }

  function attrs(params) {
    const el = resolveTarget(params);
    const result = {};
    for (const attr of el.attributes) {
      result[attr.name] = attr.value;
    }
    return result;
  }

  function visible(params) {
    const el = resolveTarget(params);
    const style = getComputedStyle(el);
    const isVisible =
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      style.opacity !== "0" &&
      (el.offsetWidth > 0 || el.offsetHeight > 0);
    return { visible: isVisible };
  }

  function count(params) {
    if (!params || !params.selector) {
      throw new Error("count requires a selector parameter");
    }
    return { count: frameDocument(params.frame).querySelectorAll(params.selector).length };
  }

  function checked(params) {
    const el = resolveTarget(params);
    return { checked: !!el.checked };
  }

  function navigate(options) {
    const url = options && options.url;
    if (url) window.location.href = url;
    return { ok: true };
  }

  function url() {
    return window.location.href;
  }

  function title() {
    return document.title;
  }

  function state() {
    return {
      url: window.location.href,
      title: document.title,
      readyState: document.readyState,
      viewport: { width: window.innerWidth, height: window.innerHeight },
      scroll: { x: window.scrollX, y: window.scrollY },
    };
  }

  function evalScript(options) {
    var script = options && options.script;
    if (!script) throw new Error("No script provided");
    // Stage 1 — expression compile.
    // `{a:1}` keeps its object-literal semantics (not a labeled block) and
    // `class C {}` evaluates to the constructor. Keep compilation separate
    // from execution: a runtime SyntaxError from e.g. `JSON.parse('x')` must
    // propagate, not trigger a fallback — otherwise the script would run twice.
    var expr;
    try {
      expr = new Function("return (\n" + script + "\n)");
    } catch (e1) {
      if (!(e1 instanceof SyntaxError)) throw e1;
      // The newlines around `script` in every wrapper below isolate user
      // tokens from generated closing punctuation. Without them, a trailing
      // `// comment` on the last line of the user script swallows `))()` or
      // `})()` and the wrapper fails to compile.
      if (hasTopLevelAwait(script)) {
        // Stage 2 — async-expression compile (#79).
        // Handles top-level `await` in expression position, e.g.
        // `await Promise.resolve("hi")` or `await fetch(...).then(r => r.json())`.
        // Returns a Promise; the Rust wrapper already awaits it.
        try {
          var asyncExpr = new Function(
            "return (async () => (\n" + script + "\n))()"
          );
          return asyncExpr();
        } catch (e2) {
          if (!(e2 instanceof SyntaxError)) throw e2;
        }
        // Stage 3 — async-statement IIFE (#79).
        // Top-level `await` is not allowed in plain script context, so when
        // the user script does not fit an expression but does contain
        // `await`, we wrap it in an async statement IIFE. The user must use
        // `return` to surface a value; otherwise the result is `null`.
        try {
          var asyncStmt = new Function(
            "return (async () => {\n" + script + "\n})()"
          );
          return asyncStmt();
        } catch (e3) {
          if (!(e3 instanceof SyntaxError)) throw e3;
          throw new SyntaxError(
            "top-level await detected but the script could not be auto-wrapped. " +
              "Wrap explicitly: (async () => { /* ...; */ return value; })() — " +
              "see docs/reference/cli.md"
          );
        }
      }
      // Stage 4 — statement fallback. Indirect eval runs in global script
      // context and returns the completion value of the last expression (#46).
      var indirectEval = eval;
      return indirectEval(script);
    }
    return expr();
  }

  // Heuristic top-level `await` detector. Strips comments and single/double
  // quoted strings, masks property accesses (`obj.await`), then peels
  // nested `function`/arrow-with-block bodies so an `await` buried in a
  // nested function does not trigger top-level detection — otherwise a
  // statement script like `async function f(){ await 1; } f(); 1+1`
  // would be mis-routed to the async-statement wrapper and lose its
  // completion value.
  //
  // Three deliberate non-strips, each documented because the alternative
  // is worse:
  //
  //   * Template literals are NOT stripped. Stripping them with a single-pass
  //     regex cannot balance nested `${...}` braces, and it also drops a real
  //     `` `${await x}` ``. Leaving them in only causes false positives on a
  //     literal like `` `await` ``, which is harmless: the script still runs
  //     wrapped in an async IIFE, only the completion-value contract changes
  //     (the user must use an explicit `return` to surface a value, which is
  //     documented in cli.md).
  //   * Regex literals (`/await/`) are NOT stripped either. A naive
  //     `\/.../[flags]*` match also swallows division expressions like
  //     `a / await foo / c`, which would silently hide a real top-level
  //     `await` and break the auto-wrap fallback. False positives from a
  //     literal `/await/` regex are again harmless wraps.
  //   * Methods inside `class` bodies are NOT recognised — the function-body
  //     strip only matches `function`/arrow blocks. A class with an `await`
  //     inside an `async` method would be flagged. Niche enough that
  //     dragging in keyword-aware parsing isn't worth it.
  //
  // For scripts larger than 100 KB the strip pass is skipped to bound
  // worst-case scan time; the raw `await` test is used instead.
  function hasTopLevelAwait(src) {
    if (src.length > 100000) return /\bawait\b/.test(src);
    // Strip quoted strings BEFORE comments, otherwise a URL like
    // `"http://example.com"` looks like a `//` line comment and the rest
    // of the line — including any real `await` — gets deleted, producing a
    // false negative. Same for `"/* not a comment */"` block markers
    // embedded in a string.
    var stripped = src
      .replace(/'(?:[^'\\]|\\.)*'/g, "''")
      .replace(/"(?:[^"\\]|\\.)*"/g, '""')
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "")
      .replace(/\.\s*await\b/g, ".__prop");
    // Peel innermost `function`/arrow bodies, both block-bodied
    // (`() => { ... }`) and concise (`() => expr`). Each iteration matches
    // bodies with no nested braces, so doubly-nested functions take two
    // passes. Cap the iteration count so a pathological input cannot loop
    // forever. Concise arrow bodies stop at any of `;,){}\n` to avoid
    // chewing through the rest of the script.
    for (var k = 0; k < 6; k++) {
      var prev = stripped;
      stripped = stripped
        .replace(/\bfunction\s*\*?\s*[\w$]*\s*\([^()]*\)\s*\{[^{}]*\}/g, "fn()")
        .replace(/\([^()]*\)\s*=>\s*\{[^{}]*\}/g, "fn()")
        .replace(/\b[\w$]+\s*=>\s*\{[^{}]*\}/g, "fn()")
        .replace(/\([^()]*\)\s*=>\s*[^{};,)\n]+/g, "fn()")
        .replace(/\b[\w$]+\s*=>\s*[^{};,)\n]+/g, "fn()");
      if (stripped === prev) break;
    }
    return /\bawait\b/.test(stripped);
  }

  // A predicate can flip without any DOM mutation — a timer firing, a fetch
  // resolving, a store updating — so this polls instead of reusing waitFor's
  // MutationObserver, which would hang on exactly those cases. A throwing
  // predicate rejects rather than being retried: swallowing the error would
  // turn a genuine bug into a timeout with no clue what happened.
  function waitForExpression(expression, timeout, poll) {
    return new Promise(function (res, rej) {
      var settled = false;
      var poller = null;

      function stop() {
        settled = true;
        clearTimeout(timer);
        if (poller !== null) clearInterval(poller);
      }

      function finish(value) {
        if (settled) return;
        stop();
        res({ found: true, value: serializeArg(value) });
      }

      function fail(err) {
        if (settled) return;
        stop();
        rej(new Error("wait expression threw: " + (err && err.message ? err.message : String(err))));
      }

      var timer = setTimeout(function () {
        if (settled) return;
        stop();
        rej(new Error("Timeout waiting for expression: " + String(expression).slice(0, 200)));
      }, timeout);

      function attempt() {
        var value;
        try {
          value = (0, eval)(expression);
        } catch (e) {
          fail(e);
          return;
        }
        if (value && typeof value.then === "function") {
          value.then(function (resolved) {
            if (resolved) finish(resolved);
          }, fail);
          return;
        }
        if (value) finish(value);
      }

      attempt();
      if (!settled) poller = setInterval(attempt, poll);
    });
  }

  function waitFor(options) {
    var selector = options && options.selector;
    var ref = options && options.ref;
    var expression = options && options.expression;
    var gone = (options && options.gone) || false;
    // Use a `!= null` check (matching `watch` below) rather than `|| 10000` so
    // an explicit `timeout: 0` resolves immediately instead of silently
    // expanding to 10 s — the latter desynchronised the Rust channel padded
    // via `BRIDGE_TIMEOUT_BUFFER_MS` and surfaced the generic "eval timed out"
    // instead of the bridge's own rejection.
    var timeout = (options && options.timeout != null) ? options.timeout : 10000;

    if (!selector && !ref && !expression) {
      return Promise.reject(
        new Error(
          "waitFor requires 'selector', 'ref', or 'expression' (use --selector for CSS, @id for snapshot ref)"
        )
      );
    }

    if (expression) {
      var poll = (options && options.poll != null) ? options.poll : 50;
      return waitForExpression(expression, timeout, poll);
    }

    return new Promise(function (res, rej) {
      function check() {
        if (selector) return frameDocument(options && options.frame).querySelector(selector);
        if (ref) return idMap.get(ref) || null;
        return null;
      }

      var el = check();
      if (!gone && el) return res({ found: true });
      if (gone && !el) return res({ found: true });

      var timer = setTimeout(function () {
        observer.disconnect();
        rej(new Error("Timeout waiting for " + (selector || ref)));
      }, timeout);

      var observer = new MutationObserver(function () {
        var found = check();
        if (!gone && found) {
          observer.disconnect();
          clearTimeout(timer);
          res({ found: true });
        } else if (gone && !found) {
          observer.disconnect();
          clearTimeout(timer);
          res({ found: true });
        }
      });

      observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
      });
    });
  }

  var MAX_WATCH_ENTRIES = 200;

  function summarizeNode(node) {
    var entry = { tag: node.tagName.toLowerCase() };
    if (node.id) entry.id = node.id;
    if (node.className && typeof node.className === 'string' && node.className.trim()) entry.class = node.className.trim();
    var text = Array.from(node.childNodes)
      .filter(function(n) { return n.nodeType === Node.TEXT_NODE; })
      .map(function(n) { return n.textContent || ''; })
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (text) entry.text = text.substring(0, 80);
    return entry;
  }

  function watch(options) {
    var selector = options && options.selector;
    var timeout = (options && options.timeout != null) ? options.timeout : 10000;
    var stable = (options && options.stable != null) ? options.stable : 300;
    var requireMutation = !!(options && options.requireMutation);

    var root;
    if (selector) {
      root = document.querySelector(selector);
      if (!root) throw new Error("watch: no element matches selector: " + selector);
    } else {
      root = document.body;
    }

    return new Promise(function (res, rej) {
      var changes = { added: [], removed: [], modified: [], truncated: false };
      var stableTimer = null;
      var timeoutTimer = null;
      var settled = false;

      function finish() {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutTimer);
        observer.disconnect();
        res(changes);
      }

      function resetStableTimer() {
        clearTimeout(stableTimer);
        stableTimer = setTimeout(finish, stable);
      }

      timeoutTimer = setTimeout(function () {
        if (settled) return;
        settled = true;
        clearTimeout(stableTimer);
        observer.disconnect();
        if (changes.added.length > 0 || changes.removed.length > 0 || changes.modified.length > 0) {
          res(changes);
        } else {
          rej(new Error("watch timeout: no DOM changes within " + timeout + "ms"));
        }
      }, timeout);

      // With requireMutation we skip starting the stable timer until the first
      // mutation is seen; without it we start immediately so stable windows can
      // resolve even when the DOM is idle.
      if (!requireMutation) {
        resetStableTimer();
      }

      function pushCapped(arr, entry) {
        if (arr.length < MAX_WATCH_ENTRIES) {
          arr.push(entry);
        } else {
          changes.truncated = true;
        }
      }

      var observer = new MutationObserver(function (mutations) {
        for (var i = 0; i < mutations.length; i++) {
          var mutation = mutations[i];
          if (mutation.type === 'childList') {
            for (var j = 0; j < mutation.addedNodes.length; j++) {
              var node = mutation.addedNodes[j];
              if (node.nodeType === Node.ELEMENT_NODE) {
                pushCapped(changes.added, summarizeNode(node));
              }
            }
            for (var k = 0; k < mutation.removedNodes.length; k++) {
              var removedNode = mutation.removedNodes[k];
              if (removedNode.nodeType === Node.ELEMENT_NODE) {
                pushCapped(changes.removed, summarizeNode(removedNode));
              }
            }
          } else if (mutation.type === 'attributes') {
            var target = mutation.target;
            var attrValue = target.getAttribute(mutation.attributeName);
            var entry = {
              tag: target.tagName.toLowerCase(),
              attribute: mutation.attributeName,
            };
            if (attrValue === null) {
              entry.removed = true;
            } else {
              entry.value = attrValue;
            }
            pushCapped(changes.modified, entry);
          } else if (mutation.type === 'characterData') {
            var parent = mutation.target.parentElement;
            if (parent) {
              pushCapped(changes.modified, {
                tag: parent.tagName.toLowerCase(),
                text: (mutation.target.textContent || '').replace(/\s+/g, ' ').trim().substring(0, 80),
              });
            }
          }
        }
        resetStableTimer();
      });

      observer.observe(root, {
        childList: true,
        subtree: true,
        attributes: true,
        characterData: true,
      });
    });
  }

  async function screenshot(options) {
    var selector = options && options.selector;
    var el = selector ? document.querySelector(selector) : document.documentElement;
    if (!el) throw new Error("Element not found: " + selector);
    if (typeof htmlToImage === "undefined" || !htmlToImage.toPng) {
      throw new Error("html-to-image library not loaded. Bundle it into bridge.js for screenshot support.");
    }
    var renderOptions = { pixelRatio: 1 };
    if (!selector) {
      // html-to-image sizes the capture from clientWidth/clientHeight, which
      // for documentElement is the viewport — the render always starts at the
      // document origin, so anything below the fold is silently cropped
      // (#129). Pass the full scroll dimensions to capture the whole page.
      var body = document.body;
      renderOptions.width = Math.max(el.scrollWidth || 0, body ? body.scrollWidth || 0 : 0);
      renderOptions.height = Math.max(el.scrollHeight || 0, body ? body.scrollHeight || 0 : 0);
    }
    var dataUrl = await htmlToImage.toPng(el, renderOptions);
    return dataUrl;
  }

  function storageGet(params) {
    if (typeof params.key !== "string") {
      throw new Error("storageGet requires a string key");
    }
    var storage = params.session ? sessionStorage : localStorage;
    var val = storage.getItem(params.key);
    if (val === null) {
      return { found: false };
    }
    return { found: true, value: val };
  }

  function storageSet(params) {
    if (typeof params.key !== "string" || typeof params.value !== "string") {
      throw new Error("storageSet requires string key and value");
    }
    var storage = params.session ? sessionStorage : localStorage;
    storage.setItem(params.key, params.value);
    return { ok: true };
  }

  var MAX_STORAGE_ENTRIES = 500;

  function storageList(params) {
    var storage = params.session ? sessionStorage : localStorage;
    var total = storage.length;
    var len = Math.min(total, MAX_STORAGE_ENTRIES);
    var entries = [];
    for (var i = 0; i < len; i++) {
      var key = storage.key(i);
      entries.push({ key: key, value: storage.getItem(key) });
    }
    entries.sort(function (a, b) {
      return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
    });
    return { entries: entries, truncated: total > MAX_STORAGE_ENTRIES };
  }

  function storageClear(params) {
    var storage = params.session ? sessionStorage : localStorage;
    storage.clear();
    return { cleared: true };
  }

  var MAX_FORMS = 100;
  var MAX_FIELDS_PER_FORM = 500;

  function formDump(params) {
    var forms;
    var totalForms;
    if (params && params.selector) {
      var found = document.querySelector(params.selector);
      if (!found) {
        throw new Error("Form not found: " + params.selector);
      }
      if (found.tagName.toLowerCase() !== "form") {
        throw new Error("Selector matched a <" + found.tagName.toLowerCase() + ">, expected a <form>");
      }
      forms = [found];
      totalForms = 1;
    } else {
      var all = document.querySelectorAll("form");
      totalForms = all.length;
      forms = [];
      var formLimit = Math.min(totalForms, MAX_FORMS);
      for (var fi = 0; fi < formLimit; fi++) {
        forms.push(all[fi]);
      }
    }

    var result = [];
    for (var i = 0; i < forms.length; i++) {
      var form = forms[i];
      var fields = [];
      var elements = form.querySelectorAll("input, select, textarea");
      var fieldLimit = Math.min(elements.length, MAX_FIELDS_PER_FORM);
      for (var j = 0; j < fieldLimit; j++) {
        var el = elements[j];
        var tag = el.tagName.toLowerCase();
        var elType = el.type || null;
        var fieldVal;
        if (tag === "select" && el.multiple) {
          var selected = [];
          for (var k = 0; k < el.options.length; k++) {
            if (el.options[k].selected) {
              selected.push(el.options[k].value);
            }
          }
          fieldVal = selected;
        } else {
          fieldVal = el.value;
        }
        var field = {
          tag: tag,
          type: elType,
          name: el.name || "",
          value: fieldVal,
        };
        if (elType === "checkbox" || elType === "radio") {
          field.checked = el.checked;
        }
        fields.push(field);
      }
      var formEntry = {
        id: form.id || "",
        name: form.getAttribute("name") || "",
        action: form.action || "",
        method: form.method || "get",
        fields: fields,
      };
      if (elements.length > MAX_FIELDS_PER_FORM) {
        formEntry.fieldsTruncated = true;
      }
      result.push(formEntry);
    }
    var truncated = totalForms > MAX_FORMS;
    return { forms: result, truncated: truncated };
  }

  window.__HASGARD__ = {
    snapshot: snapshot,
    query: query,
    filter: filterElements,
    resolve: resolve,
    click: click,
    fill: fill,
    type: typeText,
    select: select,
    check: check,
    scroll: scroll,
    text: text,
    html: html,
    value: value,
    attrs: attrs,
    navigate: navigate,
    url: url,
    title: title,
    state: state,
    eval: evalScript,
    wait: waitFor,
    screenshot: screenshot,
    consoleLogs: consoleLogs,
    clearLogs: clearLogs,
    networkRequests: networkRequests,
    clearNetwork: clearNetwork,
    visible: visible,
    count: count,
    checked: checked,
    disabled: disabled,
    boundingBox: boundingBox,
    focus: focus,
    blur: blur,
    hover: hover,
    dblclick: dblclick,
    watch: watch,
    drag: drag,
    drop: drop,
    setInputFiles: setInputFiles,
    wheel: wheel,
    dialogs: dialogs,
    clearDialogs: clearDialogs,
    handleDialogs: handleDialogs,
    storageGet: storageGet,
    storageSet: storageSet,
    storageList: storageList,
    storageClear: storageClear,
    formDump: formDump,
  };
})();
