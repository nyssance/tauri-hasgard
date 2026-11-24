;(() => {
  "use strict"

  if (window.__HASGARD__) return

  const idMap = new Map()
  let refOf = new WeakMap()
  let refCounter = 0

  const _logs = []
  let _logIdCounter = 0
  const MAX_LOGS = 500

  const _networkRequests = []
  let _netIdCounter = 0
  const MAX_REQUESTS = 200

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
    DETAILS: "group"
  }

  const INTERACTIVE_ROLES = new Set(["button", "link", "checkbox", "radio", "switch", "slider", "textbox", "combobox"])

  function serializeArg(arg) {
    if (arg === null) return null
    if (arg === undefined) return null
    if (typeof arg === "string" || typeof arg === "number" || typeof arg === "boolean") return arg
    try {
      JSON.stringify(arg)
      return arg
    } catch {
      return String(arg)
    }
  }

  function extractSource() {
    try {
      const stack = new Error().stack
      if (!stack) return null
      // Skip frames: Error constructor, extractSource, console[level] wrapper
      const lines = stack.split("\n")
      for (let i = 3; i < lines.length; i++) {
        const line = lines[i]
        if (line && !line.includes("__HASGARD__")) return line.trim()
      }
      return null
    } catch {
      return null
    }
  }

  const _originalConsole = {
    log: console.log.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
    info: console.info.bind(console)
  }

  ;["log", "warn", "error", "info"].forEach((level) => {
    console[level] = function (...args) {
      const entry = {
        id: ++_logIdCounter,
        timestamp: Date.now(),
        level,
        args: args.map(serializeArg),
        source: extractSource()
      }
      _logs.push(entry)
      if (_logs.length > MAX_LOGS) _logs.shift()
      _originalConsole[level].call(console, ...args)
    }
  })

  function consoleLogs(options) {
    let result = [..._logs]
    if (options) {
      if (options.level) {
        result = result.filter((e) => e.level === options.level)
      }
      if (options.sinceId) {
        result = result.filter((e) => e.id > options.sinceId)
      } else if (options.since) {
        result = result.filter((e) => e.timestamp > options.since)
      }
      if (options.last) {
        result = result.slice(-options.last)
      }
    }
    return result
  }

  function clearLogs() {
    _logs.length = 0
    return { cleared: true }
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
  const _dialogs = []
  let _dialogIdCounter = 0
  const _dialogPolicy = { action: "dismiss", promptText: null }

  function recordDialog(type, message, defaultValue, accepted, returned) {
    const entry = {
      id: ++_dialogIdCounter,
      timestamp: Date.now(),
      type,
      message: message == null ? "" : String(message),
      accepted
    }
    if (defaultValue !== undefined) entry.defaultValue = String(defaultValue)
    if (returned !== undefined && returned !== null) entry.returned = String(returned)
    _dialogs.push(entry)
    if (_dialogs.length > MAX_LOGS) _dialogs.shift()
    return entry
  }

  window.alert = function (message) {
    // An alert has one button, so "dismiss" and "accept" are the same act; it is
    // recorded as accepted because the page's only possible outcome is that the
    // user acknowledged it.
    recordDialog("alert", message, undefined, true, undefined)
  }

  window.confirm = function (message) {
    const accepted = _dialogPolicy.action === "accept"
    recordDialog("confirm", message, undefined, accepted, undefined)
    return accepted
  }

  window.prompt = function (message, defaultValue) {
    const accepted = _dialogPolicy.action === "accept"
    // Accepting with no configured text submits the page's own default, exactly
    // as pressing OK on an untouched prompt would.
    const returned = accepted ? (_dialogPolicy.promptText ?? defaultValue ?? "") : null
    recordDialog("prompt", message, defaultValue, accepted, returned)
    return returned
  }

  function dialogs() {
    return { dialogs: [..._dialogs], policy: { action: _dialogPolicy.action, promptText: _dialogPolicy.promptText } }
  }

  function clearDialogs() {
    _dialogs.length = 0
    return { cleared: true }
  }

  function handleDialogs(params) {
    const action = params?.action
    if (action !== "accept" && action !== "dismiss") {
      throw new Error(`dialog action must be "accept" or "dismiss", got: ${String(action).slice(0, 64)}`)
    }
    _dialogPolicy.action = action
    // `promptText` is only meaningful for accept; keeping a stale value around
    // after switching to dismiss would resurface it on the next accept.
    _dialogPolicy.promptText = action === "accept" && params.promptText != null ? String(params.promptText) : null
    saveState()
    return { action: _dialogPolicy.action, promptText: _dialogPolicy.promptText }
  }

  // --- Native dialogs ------------------------------------------------------
  //
  // Answered by `native-dialog.js`, which shares the page's own world. Where this
  // bridge runs in an isolated world (CEF) that object is not visible here, and
  // the runtime reaches it in the main world instead.
  function nativeDialogHost() {
    const host = window.__HASGARD_NATIVE_DIALOGS__
    if (!host) throw new Error("native dialogs are not available in this context")
    return host
  }

  function nativeDialogs() {
    return nativeDialogHost().list()
  }

  function clearNativeDialogs() {
    return nativeDialogHost().clear()
  }

  function handleNativeDialogs(params) {
    return nativeDialogHost().handle(params)
  }

  function bodySize(body) {
    if (!body) return 0
    if (typeof body === "string") return body.length
    if (body instanceof URLSearchParams) return body.toString().length
    if (body instanceof Blob) return body.size
    if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) return body.byteLength
    return 0
  }

  // --- Routing -------------------------------------------------------------
  //
  // Rules are declarative rather than Playwright's per-request callback. The
  // bridge cannot call back into the test process and await an answer -- it only
  // ever responds to requests -- so a handler round trip would have to block the
  // page inside `fetch`, which it cannot do. The same constraint shaped the
  // dialog policy above.
  //
  // Rules are checked in registration order; the first match wins, so a narrow
  // rule registered first survives a later catch-all.

  let _routes = []
  let _routeIdCounter = 0
  let _routeLog = []
  const MAX_ROUTE_LOG = 200

  // Glob to RegExp, with `**` crossing path separators and `*` staying within a
  // segment. Anchored at both ends: a pattern that matched a substring would
  // make `**/api` also intercept `/v2/api-docs`.
  function globToRegExp(pattern) {
    let out = ""
    for (let i = 0; i < pattern.length; i++) {
      const ch = pattern.charAt(i)
      if (ch === "*") {
        if (pattern.charAt(i + 1) === "*") {
          out += ".*"
          i++
        } else {
          out += "[^/]*"
        }
      } else if (ch === "?") {
        out += "[^/]"
      } else if (".+^${}()|[]\\".includes(ch)) {
        out += `\\${ch}`
      } else {
        out += ch
      }
    }
    return new RegExp(`^${out}$`)
  }

  // Tauri's own IPC is never routed.
  //
  // Every eval result travels back through `__TAURI_INTERNALS__.invoke`, which
  // on several platforms is an HTTP request to the IPC endpoint. A catch-all
  // rule would therefore swallow the bridge's own replies, and every later call
  // -- including the one that removes the rule -- would die on an eval timeout
  // with nothing to say why. Excluding it here is not a convenience: without it
  // `route({ pattern: "**" })` bricks the session.
  function isTauriIpc(url) {
    return /^ipc:\/\//i.test(url) || /^https?:\/\/ipc\.localhost([:/?#]|$)/i.test(url)
  }

  function matchRoute(url, method) {
    if (isTauriIpc(url)) return null
    for (const route of _routes) {
      if (route.times != null && route.used >= route.times) continue
      if (route.method && route.method !== method.toUpperCase()) continue
      if (!route.regex.test(url)) continue
      route.used += 1
      // A counted rule must stay spent after a navigation.
      if (route.times != null) saveState()
      _routeLog.push({
        id: ++_netIdCounter,
        timestamp: Date.now(),
        route_id: route.id,
        method: method.toUpperCase(),
        url,
        action: route.action,
        status: route.action === "fulfill" ? route.status : 0
      })
      if (_routeLog.length > MAX_ROUTE_LOG) _routeLog.shift()
      return route
    }
    return null
  }

  // --- Standing state across navigation ------------------------------------
  //
  // Routes and dialog policies are set once and meant to hold for a flow, but
  // this bridge is rebuilt with every document. They are kept in the tab's
  // session storage, which is the only place a new document can read at its very
  // start, before its own first request. That makes the hand-over race-free, and
  // limits it to documents of one origin. The entry exists only while a rule or a
  // non-default policy does, and Hasgard's own storage operations do not show it.
  const STATE_KEY = "__hasgard__"
  // Everything Hasgard keeps in session storage, including the native dialog policy.
  const isOwnStateKey = (key) => typeof key === "string" && key.startsWith(STATE_KEY)
  // WebView2 also runs this script in frames, and a same-origin frame shares the tab's
  // session storage. A frame reads the standing state, so rules apply inside it, but only
  // the top document writes it: a frame's copy is as old as the frame.
  const inSubframe = typeof window.parent === "object" && window.parent !== null && window.parent !== window

  function saveState() {
    if (inSubframe) return
    const idle = _routes.length === 0 && _dialogPolicy.action === "dismiss" && _dialogPolicy.promptText === null
    try {
      if (idle) {
        sessionStorage.removeItem(STATE_KEY)
        return
      }
      sessionStorage.setItem(
        STATE_KEY,
        JSON.stringify({
          routes: _routes.map(({ regex: _regex, ...rule }) => rule),
          routeIdCounter: _routeIdCounter,
          dialog: { ..._dialogPolicy }
        })
      )
    } catch {
      // A document without session storage (an opaque origin, storage disabled)
      // keeps its state for its own lifetime; there is nowhere to hand it on.
    }
  }

  function restoreState() {
    let raw
    try {
      raw = sessionStorage.getItem(STATE_KEY)
    } catch {
      return
    }
    if (!raw) return
    const state = JSON.parse(raw)
    _routes = state.routes.map((rule) => ({ ...rule, regex: globToRegExp(rule.pattern) }))
    _routeIdCounter = state.routeIdCounter
    Object.assign(_dialogPolicy, state.dialog)
  }

  // Console and network logs describe a flow, not one document, so they follow
  // it to the next document the same way. They are written once, as the document
  // is left, and taken out again by the one that replaces it.
  const LOGS_KEY = `${STATE_KEY}logs`

  function saveLogs() {
    if (inSubframe) return
    try {
      sessionStorage.setItem(
        LOGS_KEY,
        JSON.stringify({
          logs: _logs,
          logId: _logIdCounter,
          network: _networkRequests,
          netId: _netIdCounter,
          routeLog: _routeLog
        })
      )
    } catch {
      // No session storage, or more than it will hold: the logs end with this document.
    }
  }

  function restoreLogs() {
    // The logs left by the last document belong to the one that replaced it, not to its frames.
    if (inSubframe) return
    let raw
    try {
      raw = sessionStorage.getItem(LOGS_KEY)
      sessionStorage.removeItem(LOGS_KEY)
    } catch {
      return
    }
    if (!raw) return
    const kept = JSON.parse(raw)
    _logs.push(...kept.logs)
    _logIdCounter = kept.logId
    _networkRequests.push(...kept.network)
    _netIdCounter = kept.netId
    _routeLog = kept.routeLog
  }

  // Everything it restores is declared above, and no request has been wrapped yet.
  restoreState()
  restoreLogs()
  // The state is written again as the document is left: the application may have cleared its
  // session storage since the last change, and the next document must still find the rules.
  if (typeof window.addEventListener === "function") {
    window.addEventListener("pagehide", () => {
      saveState()
      saveLogs()
    })
  }

  function recordNetwork(entry) {
    _networkRequests.push(entry)
    if (_networkRequests.length > MAX_REQUESTS) _networkRequests.shift()
  }

  function routeAdd(params) {
    const pattern = params?.pattern
    if (typeof pattern !== "string" || pattern === "") {
      throw new Error("route requires a non-empty 'pattern'")
    }
    const action = params?.action || "fulfill"
    if (action !== "fulfill" && action !== "abort") {
      throw new Error(`route 'action' must be 'fulfill' or 'abort', got: ${String(action).slice(0, 32)}`)
    }
    const status = params?.status ?? 200
    if (typeof status !== "number" || status < 100 || status > 599) {
      throw new Error("route 'status' must be an HTTP status code between 100 and 599")
    }
    const times = params?.times ?? null
    if (times != null && (typeof times !== "number" || times < 1 || times % 1 !== 0)) {
      throw new Error("route 'times' must be a positive integer")
    }
    const method = params?.method ? String(params.method).toUpperCase() : null
    const route = {
      id: ++_routeIdCounter,
      pattern,
      regex: globToRegExp(pattern),
      method,
      action,
      status,
      body: params?.body != null ? String(params.body) : "",
      contentType: params?.contentType || "text/plain",
      times,
      used: 0
    }
    _routes.push(route)
    saveState()
    return { id: route.id, pattern: route.pattern, action: route.action }
  }

  function routeList() {
    return {
      routes: _routes.map((route) => {
        return {
          id: route.id,
          pattern: route.pattern,
          method: route.method,
          action: route.action,
          status: route.status,
          times: route.times,
          used: route.used
        }
      }),
      intercepted: [..._routeLog]
    }
  }

  function routeClear() {
    const removed = _routes.length
    _routes = []
    _routeLog = []
    saveState()
    return { removed }
  }

  function fulfilledResponse(route, url) {
    const headers = { "Content-Type": route.contentType }
    if (typeof Response === "function") {
      const response = new Response(route.body, { status: route.status, headers })
      // `Response.url` is read-only and empty on a constructed response, but
      // application code routinely reads it; make it the URL that was asked for.
      try {
        Object.defineProperty(response, "url", { value: url })
      } catch {
        // A frozen or exotic Response keeps its empty url; the body still delivers.
      }
      return response
    }
    throw new Error("This webview has no Response constructor, so routes cannot be fulfilled")
  }

  const _originalFetch = window.fetch.bind(window)
  window.fetch = function (input, init) {
    const method = init?.method || input?.method || "GET"
    const url = typeof input === "string" ? input : input?.url || String(input)
    const timestamp = Date.now()
    const requestSize = bodySize(init?.body)

    // Routed requests are still logged as network activity: the application did
    // issue them and did receive an answer, and a test asserting "the app called
    // /api/user" must not go blind the moment that call is stubbed.
    const route = matchRoute(url, method)
    if (route) {
      if (route.action === "abort") {
        recordNetwork({
          id: ++_netIdCounter,
          timestamp,
          method,
          url,
          status: 0,
          duration_ms: 0,
          error: "Aborted by route",
          request_size: requestSize,
          response_size: 0
        })
        return Promise.reject(new TypeError("Failed to fetch"))
      }
      recordNetwork({
        id: ++_netIdCounter,
        timestamp,
        method,
        url,
        status: route.status,
        duration_ms: 0,
        error: null,
        request_size: requestSize,
        response_size: route.body.length
      })
      return Promise.resolve(fulfilledResponse(route, url))
    }

    return _originalFetch(input, init).then(
      (response) => {
        const duration_ms = Date.now() - timestamp
        const status = response.status
        const responseSize = Number.parseInt(response.headers.get("Content-Length") || "0", 10) || 0
        const entry = {
          id: ++_netIdCounter,
          timestamp,
          method,
          url,
          status,
          duration_ms,
          error: null,
          request_size: requestSize,
          response_size: responseSize
        }
        _networkRequests.push(entry)
        if (_networkRequests.length > MAX_REQUESTS) _networkRequests.shift()
        return response
      },
      (err) => {
        const duration_ms = Date.now() - timestamp
        const entry = {
          id: ++_netIdCounter,
          timestamp,
          method,
          url,
          status: 0,
          duration_ms,
          error: err ? err.message : "Network error",
          request_size: requestSize,
          response_size: 0
        }
        _networkRequests.push(entry)
        if (_networkRequests.length > MAX_REQUESTS) _networkRequests.shift()
        throw err
      }
    )
  }

  const _origXhrOpen = XMLHttpRequest.prototype.open
  const _origXhrSend = XMLHttpRequest.prototype.send

  XMLHttpRequest.prototype.open = function (...args) {
    const [method, url] = args
    const result = Reflect.apply(_origXhrOpen, this, args)
    this._hasgard = { method: String(method), url: String(url) }
    return result
  }

  // Deliver a routed answer to an XHR without touching the network.
  //
  // The response fields are read-only accessors on the prototype, so they are
  // shadowed with own properties on this instance. That is confined to requests
  // a rule already matched: an unrouted XHR keeps the real object untouched.
  function deliverRoutedXhr(xhr, route, url, requestSize) {
    const timestamp = Date.now()
    const aborted = route.action === "abort"
    const define = function (name, value) {
      try {
        Object.defineProperty(xhr, name, {
          configurable: true,
          get() {
            return value
          }
        })
      } catch {
        // A non-configurable property keeps the webview default.
      }
    }
    define("readyState", 4)
    define("status", aborted ? 0 : route.status)
    define("statusText", aborted ? "" : "OK")
    define("responseURL", url)
    define("responseText", aborted ? "" : route.body)
    define("response", aborted ? "" : route.body)

    recordNetwork({
      id: ++_netIdCounter,
      timestamp,
      method: route.method || "GET",
      url,
      status: aborted ? 0 : route.status,
      duration_ms: 0,
      error: aborted ? "Aborted by route" : null,
      request_size: requestSize,
      response_size: aborted ? 0 : route.body.length
    })

    // Asynchronous, because a synchronous callback would run before the caller
    // had a chance to attach its own listeners -- which is not how any real
    // request behaves.
    const deliver = function () {
      try {
        xhr.dispatchEvent(new Event("readystatechange"))
        xhr.dispatchEvent(new Event(aborted ? "error" : "load"))
        xhr.dispatchEvent(new Event("loadend"))
      } catch {
        // Listener errors must not break delivery of the stubbed response.
      }
    }
    if (typeof setTimeout === "function") setTimeout(deliver, 0)
    else deliver()
  }

  XMLHttpRequest.prototype.send = function (...args) {
    const [body] = args
    if (this._hasgard) {
      const routed = matchRoute(this._hasgard.url, this._hasgard.method)
      if (routed) {
        deliverRoutedXhr(this, routed, this._hasgard.url, bodySize(body))
        return undefined
      }
    }
    if (this._hasgard) {
      const hasgard = this._hasgard
      const timestamp = Date.now()
      const requestSize = bodySize(body)
      let recorded = false
      const cleanup = () => {
        this.removeEventListener("load", onLoad)
        this.removeEventListener("error", onError)
        this.removeEventListener("timeout", onTimeout)
        this.removeEventListener("abort", onAbort)
      }
      const pushEntry = (status, error, responseSize) => {
        if (recorded) return
        recorded = true
        cleanup()
        const entry = {
          id: ++_netIdCounter,
          timestamp,
          method: hasgard.method,
          url: hasgard.url,
          status,
          duration_ms: Date.now() - timestamp,
          error,
          request_size: requestSize,
          response_size: responseSize
        }
        _networkRequests.push(entry)
        if (_networkRequests.length > MAX_REQUESTS) _networkRequests.shift()
      }
      const onLoad = () => {
        const cl = Number.parseInt(this.getResponseHeader("Content-Length") || "0", 10) || 0
        const r = this.response
        const responseSize =
          this.responseType === "" || this.responseType === "text"
            ? r?.length || cl
            : r instanceof ArrayBuffer
              ? r.byteLength
              : r instanceof Blob
                ? r.size
                : cl
        pushEntry(this.status, null, responseSize)
      }
      const onError = () => {
        pushEntry(0, "Network error", 0)
      }
      const onTimeout = () => {
        pushEntry(0, "Timeout", 0)
      }
      const onAbort = () => {
        pushEntry(0, "Aborted", 0)
      }
      this.addEventListener("load", onLoad)
      this.addEventListener("error", onError)
      this.addEventListener("timeout", onTimeout)
      this.addEventListener("abort", onAbort)
      try {
        return Reflect.apply(_origXhrSend, this, args)
      } catch (err) {
        cleanup()
        throw err
      }
    }
    return Reflect.apply(_origXhrSend, this, args)
  }

  function networkRequests(options) {
    let result = [..._networkRequests]
    if (options) {
      if (options.filter) {
        result = result.filter((e) => e.url.includes(options.filter))
      }
      if (options.failedOnly) {
        result = result.filter((e) => e.status >= 400 || e.status === 0 || e.error)
      }
      if (options.sinceId) {
        result = result.filter((e) => e.id > options.sinceId)
      }
      if (options.last) {
        result = result.slice(-options.last)
      }
    }
    return result
  }

  function clearNetwork() {
    _networkRequests.length = 0
    return { cleared: true }
  }

  function inputRole(el) {
    const t = (el.getAttribute("type") || "text").toLowerCase()
    switch (t) {
      case "hidden":
        return null
      case "checkbox":
        return "checkbox"
      case "radio":
        return "radio"
      case "range":
        return "slider"
      case "submit":
      case "reset":
      case "button":
        return "button"
      default:
        return "textbox"
    }
  }

  function getRole(el) {
    const explicit = el.getAttribute("role")
    if (explicit) return explicit
    if (el.tagName === "INPUT") return inputRole(el)
    return ROLE_MAP[el.tagName] || null
  }

  function getName(el) {
    const label = el.getAttribute("aria-label")
    if (label) return label.trim().slice(0, 50)

    const labelledBy = el.getAttribute("aria-labelledby")
    if (labelledBy) {
      const parts = labelledBy
        .split(/\s+/)
        .map((id) => {
          const ref = document.getElementById(id)
          return ref ? ref.textContent : ""
        })
        .filter(Boolean)
      if (parts.length > 0) return parts.join(" ").trim().slice(0, 50)
    }

    if (el.tagName === "IMG") {
      const alt = el.getAttribute("alt")
      if (alt) return alt.trim().slice(0, 50)
    }

    if (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT") {
      if (el.labels && el.labels.length > 0) {
        const labelText = [...el.labels]
          .map((label) => label.textContent || "")
          .join(" ")
          .replaceAll(/\s+/g, " ")
          .trim()
        if (labelText) return labelText.slice(0, 50)
      }
      const placeholder = el.getAttribute("placeholder")
      if (placeholder) return placeholder.trim().slice(0, 50)
    }

    const text = el.textContent || ""
    const trimmed = text.replaceAll(/\s+/g, " ").trim()
    return trimmed.slice(0, 50) || null
  }

  function isInteractiveElement(el) {
    const tag = el.tagName
    if (tag === "INPUT") {
      const t = (el.getAttribute("type") || "text").toLowerCase()
      return t !== "hidden"
    }
    if (tag === "BUTTON" || tag === "SELECT" || tag === "TEXTAREA" || tag === "A") {
      return true
    }
    if (el.hasAttribute("tabindex")) return true
    const role = el.getAttribute("role")
    return role ? INTERACTIVE_ROLES.has(role) : false
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
    // A node keeps one ref for as long as `idMap` holds it. Minting a second
    // ref for a node that already has one would grow `idMap` on every repeated
    // query, and let two refs for one element disagree about staleness.
    let ref = existingRef || refOf.get(node)
    if (!ref) {
      refCounter++
      ref = `e${refCounter}`
      idMap.set(ref, node)
      refOf.set(node, ref)
    }

    const entry = { ref, role, depth }
    const name = getName(node)
    if (name) entry.name = name
    // `value` is an IDL property whose type varies by element: a string for
    // form controls, but a number for `<li>` (ordinal), `<progress>`, and
    // `<meter>`. Coerce to string so the wire format matches the plugin's
    // `SnapshotElement.value: Option<String>` contract (#120).
    if (node.value !== undefined && node.value !== "") entry.value = String(node.value)
    if (node.tagName === "INPUT") {
      const inputType = (node.getAttribute("type") || "text").toLowerCase()
      if (inputType === "checkbox" || inputType === "radio") {
        entry.checked = node.checked
      }
    }
    if (node.disabled) entry.disabled = true
    return entry
  }

  // Inactive application panes must not mint actionable references.
  function isHiddenFromSnapshot(node) {
    return (
      node.getAttribute("inert") !== null ||
      node.getAttribute("hidden") !== null ||
      node.getAttribute("aria-hidden") === "true"
    )
  }

  // An optional number. One of the wrong type is an error, not an absence: a caller
  // who sent "5" or -1 asked for something, and the default is not it.
  function optionalNumber(value, name, fallback) {
    if (value == null) return fallback
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      throw new Error(`'${name}' must be a non-negative number, got: ${String(value).slice(0, 32)}`)
    }
    return value
  }

  function snapshot(options) {
    const interactive = options?.interactive || false
    const selector = options?.selector || null
    const maxDepth = optionalNumber(options?.depth, "depth", 255)

    // Never recycle a ref: another connection may still hold an older snapshot.
    idMap.clear()
    refOf = new WeakMap()
    pruneAt = PRUNE_FLOOR

    const doc = frameDocument(options?.frame)
    let root
    if (selector) {
      try {
        root = doc.querySelector(selector)
      } catch {
        throw new Error(`Invalid selector: ${selector}`)
      }
    } else {
      root = doc.body
    }
    if (!root) return { elements: [] }

    const elements = []

    function walk(node, currentDepth) {
      if (currentDepth > maxDepth) return
      if (node.nodeType !== Node.ELEMENT_NODE) return
      if (isHiddenFromSnapshot(node)) return

      const role = getRole(node)
      const isInteractive = isInteractiveElement(node)

      if (interactive && !isInteractive) {
        for (const child of node.children) {
          walk(child, currentDepth + 1)
        }
        return
      }

      if (role) {
        elements.push(describeElement(node, role, currentDepth))
      }

      for (const child of node.children) {
        walk(child, currentDepth + 1)
      }
    }

    for (let ancestor = root.parentElement; ancestor; ancestor = ancestor.parentElement) {
      if (isHiddenFromSnapshot(ancestor)) return { elements }
    }
    walk(root, 0)
    return { elements }
  }

  // `selector` is a dimension so that every locator kind — CSS, role, or
  // text-ish — can be resolved down to refs by one code path. `filter` then
  // refines any of them uniformly instead of needing a per-kind implementation.
  const QUERY_DIMENSIONS = ["text", "label", "placeholder", "testid", "alt", "title", "selector", "role"]

  function normalizeForMatch(value) {
    return String(value ?? "")
      .replaceAll(/\s+/g, " ")
      .trim()
  }

  // Playwright's rule: non-exact is a case-insensitive substring, exact is a
  // case-sensitive equality. Whitespace is normalized on both sides either way.
  function matchesQuery(actual, wanted, exact) {
    const a = normalizeForMatch(actual)
    const w = normalizeForMatch(wanted)
    if (exact) return a === w
    return a.toLowerCase().includes(w.toLowerCase())
  }

  function elementDepth(node) {
    let depth = 0
    let current = node.parentElement
    while (current && current !== document.body) {
      depth++
      current = current.parentElement
    }
    return depth
  }

  // The accessible label of a form control, from every source Playwright's
  // getByLabel consults. Deliberately *not* getName(): that collapses six
  // sources into one and truncates to 50 characters, so a control carrying both
  // an aria-label and a <label> becomes findable by only one of them.
  function labelTextsOf(el) {
    const texts = []
    const aria = el.getAttribute?.("aria-label")
    if (aria) texts.push(aria)
    const labelledBy = el.getAttribute?.("aria-labelledby")
    if (labelledBy) {
      labelledBy.split(/\s+/).forEach((id) => {
        const ref = document.getElementById(id)
        if (ref) texts.push(ref.textContent || "")
      })
    }
    if (el.labels) {
      for (const label of el.labels) {
        texts.push(label.textContent || "")
      }
    }
    return texts
  }

  function queryCandidates(doc, by, value) {
    if (by === "selector") return doc.querySelectorAll(value)
    if (by === "placeholder") return doc.querySelectorAll("[placeholder]")
    if (by === "testid") return doc.querySelectorAll("[data-testid]")
    if (by === "alt") return doc.querySelectorAll("[alt]")
    if (by === "title") return doc.querySelectorAll("[title]")
    return doc.querySelectorAll("input, textarea, select, button, meter, output, progress")
  }

  function queryMatches(el, by, value, exact) {
    // `querySelectorAll` already applied the predicate for this dimension.
    if (by === "selector") return true
    if (by === "placeholder") return matchesQuery(el.getAttribute("placeholder"), value, exact)
    if (by === "alt") return matchesQuery(el.getAttribute("alt"), value, exact)
    if (by === "title") return matchesQuery(el.getAttribute("title"), value, exact)
    // A test id is an identifier, not prose: substring matching on it invites
    // "save" quietly selecting "save-draft", so this dimension is always exact.
    if (by === "testid") return normalizeForMatch(el.getAttribute("data-testid")) === normalizeForMatch(value)
    return labelTextsOf(el).some((text) => {
      return matchesQuery(text, value, exact)
    })
  }

  // Text matching considers every element, so an ancestor matches whenever its
  // descendant does — <html> and <body> would match everything. Only the
  // innermost matches are kept, which is the element a user would point at.
  //
  // One top-down walk does both jobs. A subtree whose text does not contain the
  // needle cannot hold a match, so it is skipped whole; an element is innermost
  // exactly when none of its children reported a match. Scanning every element
  // and then comparing the matches pairwise was quadratic in the match count.
  function innermostTextMatches(doc, value, exact) {
    const wanted = normalizeForMatch(value)
    const needle = exact ? wanted : wanted.toLowerCase()
    const matched = []

    function visit(el) {
      const text = normalizeForMatch(el.textContent)
      const haystack = exact ? text : text.toLowerCase()
      if (!haystack.includes(needle)) return false
      let inner = false
      for (const child of el.children) {
        if (visit(child)) inner = true
      }
      if (inner) return true
      if (exact && haystack !== needle) return false
      matched.push(el)
      return true
    }

    visit(doc.documentElement)
    return matched
  }

  function roleNameMatcher(params) {
    const name = params.name
    if (name == null) return null
    if (typeof name === "string") {
      // Role names follow the snapshot's own rule: a case-sensitive substring,
      // or equality when exact.
      if (params.exact) {
        return (actual) => {
          return actual === name
        }
      }
      return (actual) => {
        return actual.includes(name)
      }
    }
    if (typeof name === "object" && typeof name.source === "string" && typeof name.flags === "string") {
      const pattern = new RegExp(name.source, name.flags)
      return (actual) => {
        pattern.lastIndex = 0
        return pattern.test(actual)
      }
    }
    throw new Error("query: role 'name' must be a string or a { source, flags } pattern")
  }

  // The elements a snapshot would report under `role`, matched in the page so
  // that only the matches travel. It walks exactly as `snapshot` does — same
  // hidden-subtree rule, same role and name computation — but leaves `idMap`
  // alone, so refs held elsewhere and the `diff` baseline both survive.
  function queryByRole(doc, params) {
    const role = params.value
    if (typeof role !== "string" || role === "") throw new Error("query: role 'value' must be a non-empty string")
    const nameMatches = roleNameMatcher(params)
    const elements = []

    function walk(node, depth) {
      if (node.nodeType !== Node.ELEMENT_NODE) return
      if (isHiddenFromSnapshot(node)) return
      if (getRole(node) === role) {
        if (nameMatches) {
          const name = getName(node)
          if (name && nameMatches(name)) elements.push(describeElement(node, role, depth))
        } else {
          elements.push(describeElement(node, role, depth))
        }
      }
      for (const child of node.children) walk(child, depth + 1)
    }

    const root = doc.body
    if (!root) return { elements }
    for (let ancestor = root.parentElement; ancestor; ancestor = ancestor.parentElement) {
      if (isHiddenFromSnapshot(ancestor)) return { elements }
    }
    walk(root, 0)
    return { elements }
  }

  function query(params) {
    const by = params?.by
    if (!QUERY_DIMENSIONS.includes(by)) {
      throw new Error(`query: 'by' must be one of ${QUERY_DIMENSIONS.join(", ")}, got: ${String(by).slice(0, 64)}`)
    }
    if (params.value == null) throw new Error("query requires a 'value'")
    const exact = !!params.exact
    const doc = frameDocument(params.frame)

    pruneDetachedRefs()
    if (by === "role") return queryByRole(doc, params)

    let matched = []
    if (by === "text") {
      matched = innermostTextMatches(doc, params.value, exact)
    } else {
      for (const candidate of queryCandidates(doc, by, params.value)) {
        if (queryMatches(candidate, by, params.value, exact)) matched.push(candidate)
      }
    }

    return {
      elements: matched.map((el) => {
        return describeElement(el, getRole(el) || "generic", elementDepth(el))
      })
    }
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
    const refs = params?.refs || []
    if (!Array.isArray(refs)) throw new Error("filter requires a 'refs' array")
    const exact = !!params?.exact
    const hasText = params ? params.hasText : null
    const hasNotText = params ? params.hasNotText : null
    if (hasText == null && hasNotText == null) {
      throw new Error("filter requires 'hasText' or 'hasNotText'")
    }

    const kept = []
    for (const ref of refs) {
      // A stale ref means the DOM moved under the caller between resolution and
      // refinement. Dropping it silently would turn that race into a wrong
      // answer, so surface it the same way acting on a stale ref would.
      const el = requireEl(ref)
      const text = el.textContent
      if (hasText != null && !matchesQuery(text, hasText, exact)) continue
      if (hasNotText != null && matchesQuery(text, hasNotText, exact)) continue
      kept.push({ el, ref })
    }

    return {
      elements: kept.map((entry) => {
        return describeElement(entry.el, getRole(entry.el) || "generic", elementDepth(entry.el), entry.ref)
      })
    }
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
    if (frame == null) return document
    const chain = Array.isArray(frame) ? frame : [frame]
    let doc = document
    for (const selector of chain) {
      if (typeof selector !== "string" || selector === "") {
        throw new Error("frame must be a CSS selector, or an array of them for nested frames")
      }
      const host = doc.querySelector(selector)
      if (!host) throw new Error(`No frame matches selector: ${selector}`)
      if (!("contentDocument" in host)) {
        const tag = String(host.tagName || "?").toLowerCase()
        throw new Error(`Selector ${selector} matched a <${tag}>, expected an <iframe> or <frame>`)
      }
      const inner = host.contentDocument
      if (!inner) {
        throw new Error(
          `Frame ${selector} is cross-origin, so its document cannot be reached from page script. ` +
            `Same-origin frames only.`
        )
      }
      doc = inner
    }
    return doc
  }

  function resolve(ref) {
    return idMap.get(ref) || null
  }

  // A ref names a node, not a position: once that node leaves its document —
  // a re-render replaced it, or its frame was removed — the ref is stale.
  // Acting on the detached node would dispatch events nothing listens to and
  // still report success.
  function isDetached(el) {
    return el.isConnected === false || el.ownerDocument?.defaultView === null
  }

  function requireEl(ref) {
    const el = idMap.get(ref)
    if (!el) throw new Error(`Unknown ref: ${ref}`)
    if (isDetached(el)) {
      throw new Error(`Stale ref: ${ref} (its element is no longer in the document; take a new snapshot)`)
    }
    return el
  }

  // `query` appends refs and only `snapshot` resets them, so a session that
  // never snapshots would otherwise keep every node it ever matched alive.
  // Sweep detached nodes once the map has doubled since the last sweep, which
  // keeps the cost amortized instead of paying a full scan per query.
  const PRUNE_FLOOR = 1024
  let pruneAt = PRUNE_FLOOR

  function pruneDetachedRefs() {
    if (idMap.size < pruneAt) return
    for (const [ref, el] of idMap) {
      // Forget the node too: if it returns to the document it must get a ref `idMap` knows.
      if (isDetached(el)) {
        idMap.delete(ref)
        refOf.delete(el)
      }
    }
    pruneAt = Math.max(PRUNE_FLOOR, idMap.size * 2)
  }

  // `index` selects among *all* selector matches, so an ordinal locator
  // (`nth`/`first`/`last`) resolves in the same round trip that acts on the
  // element. Counting first and indexing second would let the DOM change in
  // between and silently act on a different node. A negative index counts back
  // from the end, which is what makes `last()` a single call.
  function selectorAt(doc, selector, index, allowMissing) {
    const matches = doc.querySelectorAll(selector)
    const position = index < 0 ? matches.length + index : index
    const el = matches[position]
    if (!el) {
      if (allowMissing) return null
      throw new Error(`No element at index ${index} for selector: ${selector} (${matches.length} matched)`)
    }
    return el
  }

  function resolveTarget(params, allowMissing) {
    // A ref already identifies one node, whichever document minted it, so the
    // frame chain is not consulted -- re-resolving would only be a chance to
    // disagree with the snapshot that produced the ref.
    if (params.ref) return requireEl(params.ref)
    const doc = frameDocument(params.frame)
    if (params.selector) {
      if (params.index != null) {
        if (typeof params.index !== "number" || !Number.isInteger(params.index)) {
          throw new Error("index must be an integer")
        }
        return selectorAt(doc, params.selector, params.index, allowMissing)
      }
      const el = doc.querySelector(params.selector)
      if (!el && !allowMissing) throw new Error(`No element matches selector: ${params.selector}`)
      return el
    }
    if (params.x != null && params.y != null) {
      // Coordinates are relative to the frame's own viewport, matching how the
      // frame's scripts see them.
      const pointEl = doc.elementFromPoint(params.x, params.y)
      if (!pointEl) throw new Error(`No element at (${params.x},${params.y})`)
      return pointEl
    }
    throw new Error("No ref, selector, or coordinates provided")
  }

  function dispatchPointerEvent(el, type, options) {
    const init = {
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
      ...(options || {})
    }

    if (typeof PointerEvent === "function") {
      return el.dispatchEvent(new PointerEvent(type, init))
    }

    const event = new MouseEvent(type, init)
    try {
      Object.defineProperty(event, "pointerId", { value: init.pointerId })
      Object.defineProperty(event, "pointerType", { value: init.pointerType })
      Object.defineProperty(event, "isPrimary", { value: init.isPrimary })
    } catch {
      // Webviews without a writable pointer shape dispatch the plain event.
    }
    return el.dispatchEvent(event)
  }

  // MouseEvent.button (which one changed state) and MouseEvent.buttons (bitmask
  // of what is held) use different numbering; a right press is button 2 and
  // buttons 2, but a middle press is button 1 and buttons 4.
  const MOUSE_BUTTONS = {
    left: { button: 0, mask: 1 },
    middle: { button: 1, mask: 4 },
    right: { button: 2, mask: 2 }
  }

  const MODIFIER_FLAGS = {
    Alt: "altKey",
    Control: "ctrlKey",
    Meta: "metaKey",
    Shift: "shiftKey"
  }

  function modifierInit(modifiers) {
    const init = { altKey: false, ctrlKey: false, metaKey: false, shiftKey: false }
    if (!modifiers) return init
    if (!Array.isArray(modifiers)) throw new Error("modifiers must be an array")
    for (const modifier of modifiers) {
      const flag = MODIFIER_FLAGS[modifier]
      if (!flag) {
        throw new Error(`Unknown modifier ${JSON.stringify(modifier)}. Expected one of Alt, Control, Meta, Shift`)
      }
      init[flag] = true
    }
    return init
  }

  function mouseButton(name) {
    if (name == null) return MOUSE_BUTTONS.left
    const spec = MOUSE_BUTTONS[name]
    if (!spec) {
      throw new Error(`Unknown button ${JSON.stringify(name)}. Expected left, middle, or right`)
    }
    return spec
  }

  // Where inside the element the pointer lands. `position` is element-relative,
  // matching Playwright; `params.x/y` stay viewport-absolute because they are
  // also the coordinate *target*, resolved before we ever see the element.
  function clickPoint(el, params) {
    const rect = el.getBoundingClientRect()
    if (params.position) {
      const px = params.position.x
      const py = params.position.y
      if (typeof px !== "number" || typeof py !== "number") {
        throw new Error("position must be { x: number, y: number }")
      }
      return { x: rect.left + px, y: rect.top + py }
    }
    return {
      x: params.x ?? rect.left + rect.width / 2,
      y: params.y ?? rect.top + rect.height / 2
    }
  }

  function click(params) {
    const el = resolveTarget(params)
    el.scrollIntoView({ behavior: "instant", block: "center", inline: "center" })
    const point = clickPoint(el, params)
    const x = point.x
    const y = point.y
    const button = mouseButton(params.button)
    const modifiers = modifierInit(params.modifiers)
    const clickCount = params.clickCount ?? 1
    if (typeof clickCount !== "number" || clickCount < 1 || clickCount % 1 !== 0) {
      throw new Error("clickCount must be a positive integer")
    }
    const mouseInit = function (options) {
      return { bubbles: true, cancelable: true, composed: true, ...options }
    }

    // A double click is one gesture, not two: the browser raises detail 1 then
    // detail 2 on the *same* element, then a single dblclick. Replaying click()
    // twice would reset detail to 1 and never produce dblclick, so listeners
    // that distinguish the two would see the wrong thing.
    for (let n = 1; n <= clickCount; n++) {
      const downInit = {
        clientX: x,
        clientY: y,
        button: button.button,
        buttons: button.mask,
        detail: n,
        view: window,
        ...modifiers
      }
      const upInit = { ...downInit, buttons: 0 }

      const pointerDownOk = dispatchPointerEvent(el, "pointerdown", downInit)
      if (pointerDownOk) {
        const mouseDownOk = el.dispatchEvent(new MouseEvent("mousedown", mouseInit(downInit)))
        if (mouseDownOk && typeof el.focus === "function") {
          el.focus()
        }
      }
      dispatchPointerEvent(el, "pointerup", upInit)
      if (pointerDownOk) {
        el.dispatchEvent(new MouseEvent("mouseup", mouseInit(upInit)))
      }
      // Only the primary button produces a `click` event. A right press raises
      // `contextmenu` instead, and a middle press raises `auxclick` -- binding a
      // right-click menu to `click` is exactly the bug this lets tests catch.
      if (button.button === 0) {
        dispatchPointerEvent(el, "click", upInit)
      } else {
        el.dispatchEvent(new MouseEvent("auxclick", mouseInit(upInit)))
        if (button.button === 2) {
          el.dispatchEvent(new MouseEvent("contextmenu", mouseInit(upInit)))
        }
      }
    }

    if (clickCount >= 2) {
      el.dispatchEvent(
        new MouseEvent(
          "dblclick",
          mouseInit({
            clientX: x,
            clientY: y,
            button: button.button,
            buttons: 0,
            detail: 2,
            view: window,
            ...modifiers
          })
        )
      )
    }
    return { ok: true }
  }

  // Resolve the native `value` setter for the element's actual prototype.
  // Frameworks (React, Preact-signals, Vue) sometimes install an instance-level
  // setter that swallows programmatic writes; preferring the prototype setter
  // bypasses that override and keeps WebIDL [LegacyUnforgeable] brand checks
  // happy on <input>, <textarea>, and <select> alike (#85).
  function nativeValueSetter(el) {
    const proto = Object.getPrototypeOf(el)
    const desc = proto && Object.getOwnPropertyDescriptor(proto, "value")
    return desc && typeof desc.set === "function" ? desc.set : null
  }

  function fill(params) {
    const el = resolveTarget(params)
    el.focus()
    const setter = nativeValueSetter(el)
    if (setter) {
      setter.call(el, params.value)
    } else {
      el.value = params.value
    }
    el.dispatchEvent(new Event("input", { bubbles: true }))
    el.dispatchEvent(new Event("change", { bubbles: true }))
    return { ok: true }
  }

  function typeText(params) {
    const el = resolveTarget(params)
    el.focus()
    const setter = nativeValueSetter(el)
    for (const ch of params.text) {
      el.dispatchEvent(new KeyboardEvent("keydown", { key: ch, bubbles: true }))
      if (setter) {
        setter.call(el, el.value + ch)
      } else {
        el.value += ch
      }
      el.dispatchEvent(new InputEvent("input", { data: ch, inputType: "insertText", bubbles: true }))
      el.dispatchEvent(new KeyboardEvent("keyup", { key: ch, bubbles: true }))
    }
    return { ok: true }
  }

  function select(params) {
    const el = resolveTarget(params)
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
    const tag = el?.tagName ? String(el.tagName).toLowerCase() : ""
    if (tag !== "select") {
      const reported = (tag || String(el)).slice(0, 64)
      throw new Error(`select requires a <select> element, got: ${reported}`)
    }
    // Resolve the target option before mutating anything. Setting
    // `HTMLSelectElement.value` to a string that matches no option `value`
    // silently yields `value=""` / `selectedIndex=-1` per the DOM spec, so
    // "set then trust" reports success on a no-op (#113). Match the option
    // first — by `value`, then by visible label — and error if none matches so
    // a reported `ok` always means an option was actually selected.
    const options = [...(el.options || [])]
    const optionFor = (value) => {
      const wanted = String(value)
      const found =
        options.find((o) => o.value === wanted) || options.find((o) => (o.text || "").trim() === wanted.trim())
      if (!found) throw new Error(`select: no option matches ${JSON.stringify(value)}`)
      return found
    }
    // `values` selects exactly that set in a `<select multiple>`; an empty list clears it.
    if (params.values !== undefined) {
      if (!Array.isArray(params.values)) throw new Error("select 'values' must be an array")
      if (!el.multiple && params.values.length !== 1) {
        throw new Error(`select: this <select> takes one value, and ${params.values.length} were given`)
      }
      const chosen = new Set(params.values.map(optionFor))
      for (const option of options) option.selected = chosen.has(option)
      el.dispatchEvent(new Event("input", { bubbles: true }))
      el.dispatchEvent(new Event("change", { bubbles: true }))
      return { ok: true }
    }
    const matched = optionFor(params.value)
    const setter = nativeValueSetter(el)
    if (setter) {
      setter.call(el, matched.value)
    } else {
      el.value = matched.value
    }
    el.dispatchEvent(new Event("change", { bubbles: true }))
    return { ok: true }
  }

  // Without `checked` this toggles, which is the documented CLI contract
  // ("Toggle a checkbox"). With an explicit `checked` it drives the box to that
  // state and is a no-op when it is already there, which is what a Playwright
  // `check()`/`uncheck()` promises. A toggle cannot express either of those:
  // running it twice undoes itself, so a retry silently inverts the result.
  function check(params) {
    const el = resolveTarget(params)
    if (el.tagName !== "INPUT" || (el.type !== "checkbox" && el.type !== "radio")) {
      throw new Error("check: target must be a checkbox or radio input")
    }
    if (params.checked != null && typeof params.checked !== "boolean") {
      throw new Error("check: 'checked' must be a boolean")
    }
    if (el.type === "radio" && params.checked === false) {
      throw new Error("check: cannot uncheck a radio; select another radio in its group")
    }
    const desired = params.checked ?? (el.type === "radio" ? true : !el.checked)
    if (el.checked === desired) return { ok: true }
    el.checked = desired
    el.dispatchEvent(new Event("input", { bubbles: true }))
    el.dispatchEvent(new Event("change", { bubbles: true }))
    return { ok: true }
  }

  function disabled(params) {
    const el = resolveTarget(params)
    const aria = typeof el.getAttribute === "function" ? el.getAttribute("aria-disabled") : null
    return { disabled: !!el.disabled || aria === "true" }
  }

  function boundingBox(params) {
    const rect = resolveTarget(params).getBoundingClientRect()
    return { x: rect.left, y: rect.top, width: rect.width, height: rect.height }
  }

  function focus(params) {
    const el = resolveTarget(params)
    if (typeof el.focus !== "function") throw new Error("focus: element is not focusable")
    el.focus()
    return { ok: true }
  }

  function blur(params) {
    const el = resolveTarget(params)
    if (typeof el.blur !== "function") throw new Error("blur: element cannot be blurred")
    el.blur()
    return { ok: true }
  }

  function hover(params) {
    const el = resolveTarget(params)
    const rect = el.getBoundingClientRect()
    const x = params.x ?? rect.left + rect.width / 2
    const y = params.y ?? rect.top + rect.height / 2
    const init = { clientX: x, clientY: y, button: 0, buttons: 0, view: window }
    const mouseInit = { bubbles: true, cancelable: true, composed: true, ...init }

    dispatchPointerEvent(el, "pointerover", init)
    // `pointerenter`/`mouseenter` do not bubble, matching the real event model.
    dispatchPointerEvent(el, "pointerenter", { ...init, bubbles: false })
    el.dispatchEvent(new MouseEvent("mouseover", mouseInit))
    el.dispatchEvent(new MouseEvent("mouseenter", { ...mouseInit, bubbles: false }))
    dispatchPointerEvent(el, "pointermove", init)
    el.dispatchEvent(new MouseEvent("mousemove", mouseInit))
    return { ok: true }
  }

  // Kept as its own command for the CLI and for callers that predate
  // `click({ clickCount })`; the gesture itself now has one implementation.
  function dblclick(params) {
    return click({ ...params, clickCount: 2 })
  }

  function scroll(options) {
    const dir = options?.direction || "down"
    // An explicit 0 is a scroll of nothing, not the default distance.
    const amount = options?.amount ?? 300
    if (typeof amount !== "number" || !Number.isFinite(amount)) {
      throw new Error(`'amount' must be a number, got: ${String(amount).slice(0, 32)}`)
    }
    // Route through `resolveTarget` rather than `ref` alone so a selector or
    // point locator can scroll its own element; with `ref`-only, every
    // selector-based caller silently scrolled the document instead.
    const hasTarget = options && (options.ref || options.selector || (options.x != null && options.y != null))
    // Without a target the document scrolls: the frame's own when one is named.
    const doc = frameDocument(options?.frame)
    const view = doc.defaultView
    const target = hasTarget ? resolveTarget(options) : view

    if (dir === "top") {
      if (target === view) {
        target.scrollTo(view.scrollX, 0)
      } else {
        target.scrollTop = 0
      }
      return { ok: true }
    }
    if (dir === "bottom") {
      if (target === view) {
        const docEl = doc.documentElement
        const body = doc.body
        const fullHeight = Math.max(docEl ? docEl.scrollHeight : 0, body ? body.scrollHeight : 0)
        const viewportHeight = docEl ? docEl.clientHeight : view.innerHeight
        const max = fullHeight - viewportHeight
        target.scrollTo(view.scrollX, Math.max(0, max))
      } else {
        target.scrollTop = Math.max(0, target.scrollHeight - target.clientHeight)
      }
      return { ok: true }
    }
    if (dir !== "up" && dir !== "down" && dir !== "left" && dir !== "right") {
      const safeDir = String(dir).slice(0, 64)
      throw new Error(`Unknown scroll direction: ${safeDir} (expected up|down|left|right|top|bottom)`)
    }
    const dx = dir === "left" ? -amount : dir === "right" ? amount : 0
    const dy = dir === "up" ? -amount : dir === "down" ? amount : 0
    target.scrollBy(dx, dy)
    return { ok: true }
  }

  function drag(params) {
    // The frame scope arrives beside `source` and `target`, not inside them.
    const scoped = (target) =>
      params.frame != null && target.frame == null ? { ...target, frame: params.frame } : target
    const source = resolveTarget(scoped(params.source || params))
    let sourceRect = source.getBoundingClientRect()
    let startX = sourceRect.left + sourceRect.width / 2
    let startY = sourceRect.top + sourceRect.height / 2

    let endX, endY, dropTarget

    if (params.target) {
      dropTarget = resolveTarget(scoped(params.target))
      const targetRect = dropTarget.getBoundingClientRect()
      endX = targetRect.left + targetRect.width / 2
      endY = targetRect.top + targetRect.height / 2
    } else if (params.offset) {
      // elementFromPoint below is viewport-bound: a start point outside the
      // viewport would make the lookup miss (#130). Scroll the source into
      // view first, like a user would, then recompute the start point.
      // "instant" so a page-level `scroll-behavior: smooth` cannot defer the
      // scroll past the synchronous rect recompute.
      // Points are in the source's own viewport, which inside a frame is the frame's.
      const sourceDocument = source.ownerDocument
      const docEl = sourceDocument.documentElement
      const viewportWidth = docEl.clientWidth
      const viewportHeight = docEl.clientHeight
      if (startX < 0 || startY < 0 || startX >= viewportWidth || startY >= viewportHeight) {
        source.scrollIntoView({ behavior: "instant", block: "center", inline: "center" })
        sourceRect = source.getBoundingClientRect()
        startX = sourceRect.left + sourceRect.width / 2
        startY = sourceRect.top + sourceRect.height / 2
      }
      const offsetX = params.offset.x || 0
      const offsetY = params.offset.y || 0
      endX = startX + offsetX
      endY = startY + offsetY
      dropTarget = sourceDocument.elementFromPoint(endX, endY)
      if (!dropTarget) {
        const pointLabel = `(${Math.round(endX)},${Math.round(endY)})`
        if (endX < 0 || endY < 0 || endX >= viewportWidth || endY >= viewportHeight) {
          throw new Error(
            `Drop point ${pointLabel} is outside the viewport (${viewportWidth}x${viewportHeight}) — reduce the offset`
          )
        }
        throw new Error(`No element at drop point ${pointLabel} for offset (${offsetX},${offsetY})`)
      }
    } else {
      throw new Error("drag requires target or offset")
    }

    const dt = typeof DataTransfer === "function" ? new DataTransfer() : new ClipboardEvent("").clipboardData
    source.dispatchEvent(new MouseEvent("mousedown", { clientX: startX, clientY: startY, bubbles: true }))
    source.dispatchEvent(
      new DragEvent("dragstart", { clientX: startX, clientY: startY, dataTransfer: dt, bubbles: true })
    )
    source.dispatchEvent(new DragEvent("dragleave", { clientX: endX, clientY: endY, dataTransfer: dt, bubbles: true }))
    dropTarget.dispatchEvent(
      new DragEvent("dragenter", { clientX: endX, clientY: endY, dataTransfer: dt, bubbles: true, cancelable: true })
    )
    dropTarget.dispatchEvent(
      new DragEvent("dragover", { clientX: endX, clientY: endY, dataTransfer: dt, bubbles: true, cancelable: true })
    )
    dropTarget.dispatchEvent(
      new DragEvent("drop", { clientX: endX, clientY: endY, dataTransfer: dt, bubbles: true, cancelable: true })
    )
    source.dispatchEvent(new DragEvent("dragend", { clientX: endX, clientY: endY, dataTransfer: dt, bubbles: true }))
    return { ok: true }
  }

  function drop(params) {
    const el = resolveTarget(params)
    const rect = el.getBoundingClientRect()
    const x = rect.left + rect.width / 2
    const y = rect.top + rect.height / 2
    const dt = buildFileList(params.files)

    el.dispatchEvent(
      new DragEvent("dragenter", { clientX: x, clientY: y, dataTransfer: dt, bubbles: true, cancelable: true })
    )
    el.dispatchEvent(
      new DragEvent("dragover", { clientX: x, clientY: y, dataTransfer: dt, bubbles: true, cancelable: true })
    )
    el.dispatchEvent(
      new DragEvent("drop", { clientX: x, clientY: y, dataTransfer: dt, bubbles: true, cancelable: true })
    )
    return { ok: true }
  }

  // Turn `{name, data}` payloads (data is base64) into real `File` objects.
  // Shared by `drop` and `setInputFiles` so both produce identical `FileList`
  // contents for the same input.
  function buildFileList(files) {
    const dt = typeof DataTransfer === "function" ? new DataTransfer() : new ClipboardEvent("").clipboardData
    for (let i = 0; i < (files || []).length; i++) {
      const f = files[i]
      const binary = atob(f.data)
      const bytes = new Uint8Array(binary.length)
      for (let j = 0; j < binary.length; j++) bytes[j] = binary.charCodeAt(j)
      dt.items.add(new File([bytes], f.name, { type: f.type || "application/octet-stream" }))
    }
    return dt
  }

  // Populate an `<input type="file">` without a native file chooser, which a
  // headless-less webview gives no way to drive.
  //
  // `input.files` is settable from a `DataTransfer`'s `FileList` — the same
  // mechanism a real drop uses — so the page sees a genuine `FileList` and its
  // `change` handler cannot tell this from a user's pick. An empty array clears
  // the selection, which is how Playwright spells "deselect everything".
  function setInputFiles(params) {
    const el = resolveTarget(params)
    if (el.tagName !== "INPUT" || String(el.type).toLowerCase() !== "file") {
      // Assigning `.files` to anything else silently no-ops, so the caller would
      // get `ok: true` and an unchanged page.
      throw new Error(
        `setInputFiles requires an <input type="file">, got: ${String(
          el.tagName
        ).toLowerCase()}${el.type ? `[type="${String(el.type).slice(0, 32)}"]` : ""}`
      )
    }
    const files = params?.files || []
    if (!el.multiple && files.length > 1) {
      // The browser would keep only the last file; failing loudly beats
      // silently dropping the caller's other files.
      throw new Error(`setInputFiles got ${files.length} files but the input is not [multiple]`)
    }
    el.files = buildFileList(files).files
    el.dispatchEvent(new Event("input", { bubbles: true }))
    el.dispatchEvent(new Event("change", { bubbles: true }))
    return { ok: true, count: el.files.length }
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
    const hasTarget = params && (params.ref || params.selector || (params.x != null && params.y != null))
    const doc = frameDocument(params?.frame)
    const el = hasTarget ? resolveTarget(params) : doc.scrollingElement || doc.documentElement
    const deltaX = params?.deltaX || 0
    const deltaY = params?.deltaY || 0
    const rect = el.getBoundingClientRect ? el.getBoundingClientRect() : { left: 0, top: 0, width: 0, height: 0 }

    const notCancelled = el.dispatchEvent(
      new WheelEvent("wheel", {
        deltaX,
        deltaY,
        deltaMode: 0,
        clientX: rect.left + rect.width / 2,
        clientY: rect.top + rect.height / 2,
        bubbles: true,
        cancelable: true,
        composed: true,
        view: doc.defaultView
      })
    )

    if (notCancelled) el.scrollBy(deltaX, deltaY)
    return { ok: true, defaultPrevented: !notCancelled }
  }

  function text(params) {
    return resolveTarget(params).textContent || ""
  }

  function html(params) {
    if (params && (params.ref || params.selector)) {
      return resolveTarget(params).innerHTML
    }
    return frameDocument(params?.frame).documentElement.innerHTML
  }

  function value(params) {
    return resolveTarget(params).value || ""
  }

  function attrs(params) {
    const el = resolveTarget(params)
    const result = {}
    for (const attr of el.attributes) {
      result[attr.name] = attr.value
    }
    return result
  }

  function visible(params) {
    const el = resolveTarget(params, true)
    if (!el) return { visible: false }
    const style = getComputedStyle(el)
    const isVisible =
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      style.opacity !== "0" &&
      (el.offsetWidth > 0 || el.offsetHeight > 0)
    return { visible: isVisible }
  }

  function count(params) {
    if (!params?.selector) {
      throw new Error("count requires a selector parameter")
    }
    return { count: frameDocument(params.frame).querySelectorAll(params.selector).length }
  }

  function checked(params) {
    const el = resolveTarget(params)
    return { checked: !!el.checked }
  }

  function navigate(options) {
    const url = options?.url
    if (url) window.location.href = url
    return { ok: true }
  }

  function url() {
    return window.location.href
  }

  function title() {
    return document.title
  }

  // Where this document is, for a `wait` on a URL or a load state. The plugin
  // polls it across navigations, so each new document answers for itself; a wait
  // held inside one document would die with it.
  function locationState(options) {
    const href = window.location.href
    const readyState = document.readyState
    let matched = true
    const wanted = options?.url
    if (wanted != null) {
      if (typeof wanted === "string") matched = globToRegExp(wanted).test(href)
      else if (typeof wanted === "object" && typeof wanted.source === "string" && typeof wanted.flags === "string")
        matched = new RegExp(wanted.source, wanted.flags).test(href)
      else throw new Error("wait: 'url' must be a glob string or a { source, flags } pattern")
    }
    const load = options?.load
    if (load != null) {
      if (load === "load") matched = matched && readyState === "complete"
      else if (load === "domcontentloaded") matched = matched && readyState !== "loading"
      else throw new Error(`wait: 'load' must be "load" or "domcontentloaded"`)
    }
    return { url: href, readyState, matched }
  }

  function state() {
    return {
      url: window.location.href,
      title: document.title,
      readyState: document.readyState,
      viewport: { width: window.innerWidth, height: window.innerHeight },
      scroll: { x: window.scrollX, y: window.scrollY }
    }
  }

  function evalScript(options) {
    const script = options?.script
    if (!script) throw new Error("No script provided")
    // Stage 1 — expression compile.
    // `{a:1}` keeps its object-literal semantics (not a labeled block) and
    // `class C {}` evaluates to the constructor. Keep compilation separate
    // from execution: a runtime SyntaxError from e.g. `JSON.parse('x')` must
    // propagate, not trigger a fallback — otherwise the script would run twice.
    let expr
    try {
      expr = new Function(`return (\n${script}\n)`)
    } catch (e1) {
      if (!(e1 instanceof SyntaxError)) throw e1
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
          const asyncExpr = new Function(`return (async () => (\n${script}\n))()`)
          return asyncExpr()
        } catch (e2) {
          if (!(e2 instanceof SyntaxError)) throw e2
        }
        // Stage 3 — async-statement IIFE (#79).
        // Top-level `await` is not allowed in plain script context, so when
        // the user script does not fit an expression but does contain
        // `await`, we wrap it in an async statement IIFE. The user must use
        // `return` to surface a value; otherwise the result is `null`.
        try {
          const asyncStmt = new Function(`return (async () => {\n${script}\n})()`)
          return asyncStmt()
        } catch (e3) {
          if (!(e3 instanceof SyntaxError)) throw e3
          throw new SyntaxError(
            "top-level await detected but the script could not be auto-wrapped. " +
              "Wrap explicitly: (async () => { /* ...; */ return value; })() — " +
              "see docs/reference/cli.md",
            { cause: e3 }
          )
        }
      }
      // Stage 4 — statement fallback. Indirect eval runs in global script
      // context and returns the completion value of the last expression (#46).
      const indirectEval = eval
      return indirectEval(script)
    }
    return expr()
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
    if (src.length > 100000) return /\bawait\b/.test(src)
    // Strip quoted strings BEFORE comments, otherwise a URL like
    // `"http://example.com"` looks like a `//` line comment and the rest
    // of the line — including any real `await` — gets deleted, producing a
    // false negative. Same for `"/* not a comment */"` block markers
    // embedded in a string.
    let stripped = src
      .replaceAll(/'(?:[^'\\]|\\.)*'/g, "''")
      .replaceAll(/"(?:[^"\\]|\\.)*"/g, '""')
      .replaceAll(/\/\*[\s\S]*?\*\//g, "")
      .replaceAll(/\/\/[^\n]*/g, "")
      .replaceAll(/\.\s*await\b/g, ".__prop")
    // Peel innermost `function`/arrow bodies, both block-bodied
    // (`() => { ... }`) and concise (`() => expr`). Each iteration matches
    // bodies with no nested braces, so doubly-nested functions take two
    // passes. Cap the iteration count so a pathological input cannot loop
    // forever. Concise arrow bodies stop at any of `;,){}\n` to avoid
    // chewing through the rest of the script.
    for (let k = 0; k < 6; k++) {
      const prev = stripped
      stripped = stripped
        .replaceAll(/\bfunction\s*\*?\s*[\w$]*\s*\([^()]*\)\s*\{[^{}]*\}/g, "fn()")
        .replaceAll(/\([^()]*\)\s*=>\s*\{[^{}]*\}/g, "fn()")
        .replaceAll(/\b[\w$]+\s*=>\s*\{[^{}]*\}/g, "fn()")
        .replaceAll(/\([^()]*\)\s*=>\s*[^{};,)\n]+/g, "fn()")
        .replaceAll(/\b[\w$]+\s*=>\s*[^{};,)\n]+/g, "fn()")
      if (stripped === prev) break
    }
    return /\bawait\b/.test(stripped)
  }

  // A predicate can flip without any DOM mutation — a timer firing, a fetch
  // resolving, a store updating — so this polls instead of reusing waitFor's
  // MutationObserver, which would hang on exactly those cases. A throwing
  // predicate rejects rather than being retried: swallowing the error would
  // turn a genuine bug into a timeout with no clue what happened.
  function waitForExpression(expression, timeout, poll) {
    return new Promise((res, rej) => {
      let settled = false
      let poller = null

      function stop() {
        settled = true
        clearTimeout(timer)
        if (poller !== null) clearInterval(poller)
      }

      function finish(value) {
        if (settled) return
        stop()
        res({ found: true, value: serializeArg(value) })
      }

      function fail(err) {
        if (settled) return
        stop()
        rej(new Error(`wait expression threw: ${err?.message || String(err)}`))
      }

      const timer = setTimeout(() => {
        if (settled) return
        stop()
        rej(new Error(`Timeout waiting for expression: ${String(expression).slice(0, 200)}`))
      }, timeout)

      function attempt() {
        let value
        try {
          value = (0, eval)(expression)
        } catch (e) {
          fail(e)
          return
        }
        if (value && typeof value.then === "function") {
          value.then((resolved) => {
            if (resolved) finish(resolved)
          }, fail)
          return
        }
        if (value) finish(value)
      }

      attempt()
      if (!settled) poller = setInterval(attempt, poll)
    })
  }

  function waitFor(options) {
    const selector = options?.selector
    const ref = options?.ref
    const expression = options?.expression
    const gone = options?.gone || false
    // Use nullish coalescing (matching `watch` below) so
    // an explicit `timeout: 0` resolves immediately instead of silently
    // expanding to 10 s — the latter desynchronised the Rust channel padded
    // via `BRIDGE_TIMEOUT_BUFFER_MS` and surfaced the generic "eval timed out"
    // instead of the bridge's own rejection.
    const timeout = options?.timeout ?? 10000

    if (!selector && !ref && !expression) {
      return Promise.reject(
        new Error("waitFor requires 'selector', 'ref', or 'expression' (use --selector for CSS, @id for snapshot ref)")
      )
    }

    if (expression) {
      const poll = optionalNumber(options?.poll, "poll", 50)
      return waitForExpression(expression, timeout, poll)
    }

    return new Promise((res, rej) => {
      function check() {
        if (selector) return frameDocument(options?.frame).querySelector(selector)
        const known = idMap.get(ref)
        return known && !isDetached(known) ? known : null
      }

      const el = check()
      if (!gone && el) return res({ found: true })
      if (gone && !el) return res({ found: true })

      const timer = setTimeout(() => {
        observer.disconnect()
        rej(new Error(`Timeout waiting for ${selector || ref}`))
      }, timeout)

      const observer = new MutationObserver(() => {
        const found = check()
        if (!gone && found) {
          observer.disconnect()
          clearTimeout(timer)
          res({ found: true })
        } else if (gone && !found) {
          observer.disconnect()
          clearTimeout(timer)
          res({ found: true })
        }
      })

      // Mutations do not cross a frame boundary, so the target's own document
      // has to be observed. The top document stays observed as well: removing
      // the frame itself is a mutation only its host document sees.
      const roots = new Set([document.body])
      if (selector) roots.add(frameDocument(options?.frame).body)
      else roots.add(idMap.get(ref)?.ownerDocument?.body)
      for (const root of roots) {
        if (root) observer.observe(root, { childList: true, subtree: true, attributes: true })
      }
    })
  }

  const MAX_WATCH_ENTRIES = 200

  function summarizeNode(node) {
    const entry = { tag: node.tagName.toLowerCase() }
    if (node.id) entry.id = node.id
    if (node.className && typeof node.className === "string" && node.className.trim())
      entry.class = node.className.trim()
    const text = [...node.childNodes]
      .filter((n) => {
        return n.nodeType === Node.TEXT_NODE
      })
      .map((n) => {
        return n.textContent || ""
      })
      .join(" ")
      .replaceAll(/\s+/g, " ")
      .trim()
    if (text) entry.text = text.slice(0, 80)
    return entry
  }

  function watch(options) {
    const selector = options?.selector
    const timeout = options?.timeout ?? 10000
    const stable = optionalNumber(options?.stable, "stable", 300)
    const requireMutation = !!options?.requireMutation

    let root
    if (selector) {
      root = document.querySelector(selector)
      if (!root) throw new Error(`watch: no element matches selector: ${selector}`)
    } else {
      root = document.body
    }

    return new Promise((res, rej) => {
      const changes = { added: [], removed: [], modified: [], truncated: false }
      let stableTimer = null
      let timeoutTimer = null
      let settled = false

      function finish() {
        if (settled) return
        settled = true
        clearTimeout(timeoutTimer)
        observer.disconnect()
        res(changes)
      }

      function resetStableTimer() {
        clearTimeout(stableTimer)
        stableTimer = setTimeout(finish, stable)
      }

      timeoutTimer = setTimeout(() => {
        if (settled) return
        settled = true
        clearTimeout(stableTimer)
        observer.disconnect()
        if (changes.added.length > 0 || changes.removed.length > 0 || changes.modified.length > 0) {
          res(changes)
        } else {
          rej(new Error(`watch timeout: no DOM changes within ${timeout}ms`))
        }
      }, timeout)

      // With requireMutation we skip starting the stable timer until the first
      // mutation is seen; without it we start immediately so stable windows can
      // resolve even when the DOM is idle.
      if (!requireMutation) {
        resetStableTimer()
      }

      function pushCapped(arr, entry) {
        if (arr.length < MAX_WATCH_ENTRIES) {
          arr.push(entry)
        } else {
          changes.truncated = true
        }
      }

      const observer = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
          if (mutation.type === "childList") {
            for (const node of mutation.addedNodes) {
              if (node.nodeType === Node.ELEMENT_NODE) {
                pushCapped(changes.added, summarizeNode(node))
              }
            }
            for (const removedNode of mutation.removedNodes) {
              if (removedNode.nodeType === Node.ELEMENT_NODE) {
                pushCapped(changes.removed, summarizeNode(removedNode))
              }
            }
          } else if (mutation.type === "attributes") {
            const target = mutation.target
            const attrValue = target.getAttribute(mutation.attributeName)
            const entry = {
              tag: target.tagName.toLowerCase(),
              attribute: mutation.attributeName
            }
            if (attrValue === null) {
              entry.removed = true
            } else {
              entry.value = attrValue
            }
            pushCapped(changes.modified, entry)
          } else if (mutation.type === "characterData") {
            const parent = mutation.target.parentElement
            if (parent) {
              pushCapped(changes.modified, {
                tag: parent.tagName.toLowerCase(),
                text: (mutation.target.textContent || "").replaceAll(/\s+/g, " ").trim().slice(0, 80)
              })
            }
          }
        }
        resetStableTimer()
      })

      observer.observe(root, {
        childList: true,
        subtree: true,
        attributes: true,
        characterData: true
      })
    })
  }

  async function screenshot(options) {
    const selector = options?.selector
    const doc = frameDocument(options?.frame)
    const el = selector ? doc.querySelector(selector) : doc.documentElement
    if (!el) throw new Error(`Element not found: ${selector}`)
    if (typeof htmlToImage === "undefined" || !htmlToImage.toPng) {
      throw new Error("html-to-image library not loaded. Bundle it into bridge.js for screenshot support.")
    }
    // An image the page cannot read back (another origin without CORS) is
    // drawn empty; without a handler one such image fails the whole capture.
    const renderOptions = { pixelRatio: 1, onImageErrorHandler() {} }
    if (!selector) {
      // html-to-image sizes the capture from clientWidth/clientHeight, which
      // for documentElement is the viewport — the render always starts at the
      // document origin, so anything below the fold is silently cropped
      // (#129). Pass the full scroll dimensions to capture the whole page.
      const body = doc.body
      renderOptions.width = Math.max(el.scrollWidth || 0, body ? body.scrollWidth || 0 : 0)
      renderOptions.height = Math.max(el.scrollHeight || 0, body ? body.scrollHeight || 0 : 0)
    }
    const dataUrl = await htmlToImage.toPng(el, renderOptions)
    return dataUrl
  }

  // Where `screenshot` would capture, in CSS pixels from the document's
  // origin: a backend that takes the pixels itself asks only for this.
  // The part of `area` inside `box`; none of it there is an error, since nothing would be captured.
  function clipTo(area, box, name) {
    const left = Math.max(area.x, box.x)
    const top = Math.max(area.y, box.y)
    const right = Math.min(area.x + area.width, box.x + box.width)
    const bottom = Math.min(area.y + area.height, box.y + box.height)
    if (right <= left || bottom <= top) {
      throw new Error(`${name} is scrolled out of its frame; scroll it into view first`)
    }
    return { x: left, y: top, width: right - left, height: bottom - top }
  }

  function screenshotArea(options) {
    const selector = options?.selector
    if (options?.frame != null) {
      // Composited pixels exist only for what the frame shows, so the area is the
      // frame's own box, or the element's box inside it, placed in the top document.
      const chain = Array.isArray(options.frame) ? options.frame : [options.frame]
      let doc = document
      let x = window.scrollX
      let y = window.scrollY
      let box = null
      for (let depth = 0; depth < chain.length; depth++) {
        const inner = frameDocument(chain.slice(0, depth + 1))
        const host = doc.querySelector(chain[depth])
        const rect = host.getBoundingClientRect()
        // The frame's document starts inside its border and its padding.
        const style = doc.defaultView.getComputedStyle(host)
        const pad = (side) => Number.parseFloat(style[`padding${side}`]) || 0
        x += rect.x + host.clientLeft + pad("Left")
        y += rect.y + host.clientTop + pad("Top")
        const content = {
          x,
          y,
          width: host.clientWidth - pad("Left") - pad("Right"),
          height: host.clientHeight - pad("Top") - pad("Bottom")
        }
        // A nested frame shows only what the frames around it show of it.
        box = box ? clipTo(content, box, chain[depth]) : content
        doc = inner
      }
      if (!selector) return box
      const el = doc.querySelector(selector)
      if (!el) throw new Error(`Element not found: ${selector}`)
      const rect = el.getBoundingClientRect()
      // What lies outside the frame's box is not shown, and the pixels there belong to the page.
      return clipTo({ x: x + rect.x, y: y + rect.y, width: rect.width, height: rect.height }, box, selector)
    }
    if (!selector) {
      const el = document.documentElement
      const body = document.body
      return {
        x: 0,
        y: 0,
        width: Math.max(el.scrollWidth || 0, body ? body.scrollWidth || 0 : 0),
        height: Math.max(el.scrollHeight || 0, body ? body.scrollHeight || 0 : 0)
      }
    }
    const el = document.querySelector(selector)
    if (!el) throw new Error(`Element not found: ${selector}`)
    const rect = el.getBoundingClientRect()
    return { x: rect.x + window.scrollX, y: rect.y + window.scrollY, width: rect.width, height: rect.height }
  }

  function storageGet(params) {
    if (typeof params.key !== "string") {
      throw new Error("storageGet requires a string key")
    }
    const storage = params.session ? sessionStorage : localStorage
    const val = params.session && isOwnStateKey(params.key) ? null : storage.getItem(params.key)
    if (val === null) {
      return { found: false }
    }
    return { found: true, value: val }
  }

  function storageSet(params) {
    if (typeof params.key !== "string" || typeof params.value !== "string") {
      throw new Error("storageSet requires string key and value")
    }
    if (params.session && isOwnStateKey(params.key)) {
      throw new Error(`storageSet: keys starting with ${STATE_KEY} are Hasgard's own`)
    }
    const storage = params.session ? sessionStorage : localStorage
    storage.setItem(params.key, params.value)
    return { ok: true }
  }

  const MAX_STORAGE_ENTRIES = 500

  function storageList(params) {
    const storage = params.session ? sessionStorage : localStorage
    // Hasgard's own entry is not the application's data.
    const keys = []
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i)
      if (!(params.session && isOwnStateKey(key))) keys.push(key)
    }
    const entries = keys.slice(0, MAX_STORAGE_ENTRIES).map((key) => ({ key, value: storage.getItem(key) }))
    return {
      entries: entries.toSorted((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)),
      truncated: keys.length > MAX_STORAGE_ENTRIES
    }
  }

  function storageClear(params) {
    const storage = params.session ? sessionStorage : localStorage
    // Clearing the application's data must not drop what a test has standing.
    const own = []
    if (params.session) {
      for (let i = 0; i < storage.length; i++) {
        const key = storage.key(i)
        if (isOwnStateKey(key)) own.push([key, storage.getItem(key)])
      }
    }
    storage.clear()
    for (const [key, value] of own) storage.setItem(key, value)
    return { cleared: true }
  }

  const MAX_FORMS = 100
  const MAX_FIELDS_PER_FORM = 500

  function formDump(params) {
    let forms
    let totalForms
    if (params?.selector) {
      const found = document.querySelector(params.selector)
      if (!found) {
        throw new Error(`Form not found: ${params.selector}`)
      }
      if (found.tagName.toLowerCase() !== "form") {
        throw new Error(`Selector matched a <${found.tagName.toLowerCase()}>, expected a <form>`)
      }
      forms = [found]
      totalForms = 1
    } else {
      const all = document.querySelectorAll("form")
      totalForms = all.length
      forms = []
      const formLimit = Math.min(totalForms, MAX_FORMS)
      for (let fi = 0; fi < formLimit; fi++) {
        forms.push(all[fi])
      }
    }

    const result = []
    for (const form of forms) {
      const fields = []
      const elements = form.querySelectorAll("input, select, textarea")
      const fieldLimit = Math.min(elements.length, MAX_FIELDS_PER_FORM)
      for (let j = 0; j < fieldLimit; j++) {
        const el = elements[j]
        const tag = el.tagName.toLowerCase()
        const elType = el.type || null
        let fieldVal
        if (tag === "select" && el.multiple) {
          const selected = []
          for (const option of el.options) {
            if (option.selected) {
              selected.push(option.value)
            }
          }
          fieldVal = selected
        } else {
          fieldVal = el.value
        }
        const field = {
          tag,
          type: elType,
          name: el.name || "",
          value: fieldVal
        }
        if (elType === "checkbox" || elType === "radio") {
          field.checked = el.checked
        }
        fields.push(field)
      }
      const formEntry = {
        id: form.id || "",
        name: form.getAttribute("name") || "",
        action: form.action || "",
        method: form.method || "get",
        fields
      }
      if (elements.length > MAX_FIELDS_PER_FORM) {
        formEntry.fieldsTruncated = true
      }
      result.push(formEntry)
    }
    const truncated = totalForms > MAX_FORMS
    return { forms: result, truncated }
  }

  const pendingPresses = new Map()

  // Passive observation of real keyboard events. These methods never dispatch
  // an event or edit an input; Rust retains the native-input ordering lock.
  function preparePress(options) {
    const token = options.token
    if (pendingPresses.has(token)) throw new Error("Duplicate native press token")
    const documents = []
    function collect(doc) {
      documents.push(doc)
      for (const frame of doc.querySelectorAll("iframe")) {
        try {
          if (frame.contentDocument) collect(frame.contentDocument)
          else if (doc.activeElement === frame)
            throw new Error("Focused frame is not accessible for webview press completion")
        } catch {
          if (doc.activeElement === frame)
            throw new Error("Focused frame is not accessible for webview press completion")
        }
      }
    }
    collect(document)
    const contexts = documents.map((doc) => {
      if (!doc.defaultView) throw new Error("Document detached while preparing native press completion")
      return doc.defaultView
    })
    let resolve
    const promise = new Promise((done) => {
      resolve = done
    })
    const entry = { promise, cleanup: null }
    const pressedCodes = new Set()
    const releasedCodes = new Set()
    let sawMainKey = false
    function removeListeners() {
      for (const context of contexts) {
        context.removeEventListener("keydown", pressed, true)
        context.removeEventListener("keyup", released, true)
      }
    }
    function pressed(event) {
      if (event.isTrusted && event.code) {
        pressedCodes.add(event.code)
        if (!/^(Shift|Control|Alt|Meta)(Left|Right)$/.test(event.code)) sawMainKey = true
        complete()
      }
    }
    function released(event) {
      if (!event.isTrusted || !event.code) return
      releasedCodes.add(event.code)
      complete()
    }
    function complete() {
      // WebKit can deliver keyup before the corresponding keydown while
      // processing native input. Require both trusted events for every code
      // pressed, including modifiers, without assuming their DOM delivery order.
      // A keyup for a key this observation never saw go down belongs to the
      // press before it -- a modifier pressed alone is not awaited, so its
      // release can land here -- and counting it would leave the two sets
      // unequal for good.
      if (!sawMainKey) return
      for (const code of pressedCodes) if (!releasedCodes.has(code)) return
      removeListeners()
      resolve({ ok: true })
    }
    const timer = setTimeout(() => {
      removeListeners()
      pendingPresses.delete(token)
      resolve({ ok: false })
    }, 10000)
    entry.cleanup = function () {
      clearTimeout(timer)
      removeListeners()
      resolve({ ok: false })
    }
    pendingPresses.set(token, entry)
    for (const context of contexts) {
      context.addEventListener("keydown", pressed, true)
      context.addEventListener("keyup", released, true)
    }
    return { ok: true }
  }

  function waitPress(options) {
    const entry = pendingPresses.get(options.token)
    if (!entry) throw new Error("Native press completion observer expired or document changed")
    return entry.promise.then((result) => {
      if (!result.ok)
        throw new Error(
          "Native press timed out waiting for a trusted webview keyup; use completion=native for OS shortcuts or navigation"
        )
      return result
    })
  }

  function cancelPress(options) {
    const entry = pendingPresses.get(options.token)
    if (entry) {
      entry.cleanup()
      pendingPresses.delete(options.token)
    }
  }

  window.__HASGARD__ = {
    _preparePress: preparePress,
    _waitPress: waitPress,
    _cancelPress: cancelPress,
    snapshot,
    query,
    filter: filterElements,
    resolve,
    click,
    fill,
    type: typeText,
    select,
    check,
    scroll,
    text,
    html,
    value,
    attrs,
    navigate,
    url,
    title,
    state,
    locationState,
    eval: evalScript,
    wait: waitFor,
    screenshot,
    screenshotArea,
    consoleLogs,
    clearLogs,
    networkRequests,
    clearNetwork,
    visible,
    count,
    checked,
    disabled,
    boundingBox,
    focus,
    blur,
    hover,
    dblclick,
    watch,
    drag,
    drop,
    setInputFiles,
    wheel,
    dialogs,
    nativeDialogs,
    clearNativeDialogs,
    handleNativeDialogs,
    clearDialogs,
    handleDialogs,
    storageGet,
    storageSet,
    storageList,
    storageClear,
    formDump,
    route: routeAdd,
    routes: routeList,
    clearRoutes: routeClear
  }
})()
