// The dialog plugin's native dialogs, answered in advance.
//
// The plugin's open, save and message commands end in an operating-system window
// that nothing can click reliably. A test answers them here instead, at the one
// point where the answer enters the application; everything else stays real.
//
// This runs in the page's own world, because that is where the application's
// requests are made: with the bridge on Wry, and injected into the main world on
// CEF, whose bridge lives in an isolated one. It is self-contained for that reason.
//
// The default leaves the dialogs alone, so the system window appears exactly as it
// does for a person. Only these three commands are ever answered: the rest of the
// application's IPC is never touched.
;(() => {
  "use strict"

  if (window.__HASGARD_NATIVE_DIALOGS__) return

  const NATIVE_DIALOG_PREFIX = "plugin:dialog|"
  const NATIVE_DIALOG_KINDS = ["open", "save", "message"]
  // Kept with the tab so the policy holds across a navigation within one origin.
  // The bridge hides and preserves every session key that starts with `__hasgard__`.
  const STATE_KEY = "__hasgard__native_dialogs"
  const MAX_LOGS = 500
  const _nativeDialogs = []
  let _nativeDialogIdCounter = 0
  const _nativeDialogPolicy = { action: "manual", paths: [], button: null }

  function isTauriIpc(url) {
    return /^ipc:\/\//i.test(url) || /^https?:\/\/ipc\.localhost([:/?#]|$)/i.test(url)
  }

  // The labels a message dialog offers, first the affirmative one and last the
  // one that closing the dialog gives.
  function messageButtons(buttons) {
    if (buttons == null || buttons === "Ok") return ["Ok"]
    if (buttons === "OkCancel") return ["Ok", "Cancel"]
    if (buttons === "YesNo") return ["Yes", "No"]
    if (buttons === "YesNoCancel") return ["Yes", "No", "Cancel"]
    if (typeof buttons === "object") {
      if (typeof buttons.OkCustom === "string") return [buttons.OkCustom]
      if (Array.isArray(buttons.OkCancelCustom)) return buttons.OkCancelCustom.map(String)
      if (Array.isArray(buttons.YesNoCancelCustom)) return buttons.YesNoCancelCustom.map(String)
    }
    throw new Error(`native dialog: unknown message buttons ${JSON.stringify(buttons)}`)
  }

  function answerNativeDialog(kind, args) {
    const accepted = _nativeDialogPolicy.action === "accept"
    const options = args?.options ?? {}
    const entry = { id: ++_nativeDialogIdCounter, timestamp: Date.now(), kind, accepted }
    let result
    if (kind === "message") {
      const offered = messageButtons(args?.buttons)
      entry.message = args?.message == null ? "" : String(args.message)
      if (args?.title != null) entry.title = String(args.title)
      entry.buttons = offered
      if (accepted && _nativeDialogPolicy.button !== null) {
        if (!offered.includes(_nativeDialogPolicy.button)) {
          throw new Error(
            `native dialog: button "${_nativeDialogPolicy.button}" is not one of ${JSON.stringify(offered)}`
          )
        }
        result = _nativeDialogPolicy.button
      } else {
        result = accepted ? offered[0] : offered[offered.length - 1]
      }
    } else {
      if (options.title != null) entry.title = String(options.title)
      if (options.defaultPath != null) entry.defaultPath = String(options.defaultPath)
      if (kind === "open") {
        entry.multiple = options.multiple === true
        entry.directory = options.directory === true
      }
      if (!accepted) {
        result = null
      } else {
        const paths = _nativeDialogPolicy.paths
        if (paths.length === 0) throw new Error(`native dialog: accepting a ${kind} dialog needs 'paths'`)
        if (kind === "open" && options.multiple === true) result = [...paths]
        else if (paths.length === 1) result = paths[0]
        else throw new Error(`native dialog: this ${kind} dialog takes one path, and ${paths.length} are set`)
      }
    }
    entry.result = result
    _nativeDialogs.push(entry)
    if (_nativeDialogs.length > MAX_LOGS) _nativeDialogs.shift()
    return result
  }

  // Tauri fixes `invoke` in place, but it sends each command as a request to its
  // IPC endpoint through the page's `fetch`. A dialog command is answered there
  // with the response Tauri's own transport expects, so the application's `invoke`
  // resolves exactly as it would have.
  function respond(url, init) {
    if (_nativeDialogPolicy.action === "manual" || !isTauriIpc(url)) return null
    let command
    try {
      command = decodeURIComponent(url.replace(/^[a-z]+:\/\/[^/]*\//i, "").split(/[?#]/)[0])
    } catch {
      return null
    }
    if (!command.startsWith(NATIVE_DIALOG_PREFIX)) return null
    const kind = command.slice(NATIVE_DIALOG_PREFIX.length)
    if (!NATIVE_DIALOG_KINDS.includes(kind)) return null
    if (typeof Response !== "function") {
      throw new Error("This webview has no Response constructor, so native dialogs cannot be answered")
    }
    try {
      if (typeof init?.body !== "string") throw new Error("native dialog: the command's arguments are not JSON")
      const result = answerNativeDialog(kind, JSON.parse(init.body))
      return new Response(JSON.stringify(result), {
        status: 200,
        headers: { "Content-Type": "application/json", "Tauri-Response": "ok" }
      })
    } catch (error) {
      // The application's `invoke` rejects with this message, as it would for a failed command.
      return new Response(String(error?.message || error), {
        status: 200,
        headers: { "Content-Type": "text/plain", "Tauri-Response": "error" }
      })
    }
  }

  function policy() {
    return {
      action: _nativeDialogPolicy.action,
      paths: [..._nativeDialogPolicy.paths],
      button: _nativeDialogPolicy.button
    }
  }

  function save() {
    try {
      if (_nativeDialogPolicy.action === "manual") sessionStorage.removeItem(STATE_KEY)
      else sessionStorage.setItem(STATE_KEY, JSON.stringify(policy()))
    } catch {
      // A document without session storage keeps its policy for its own lifetime.
    }
  }

  function list() {
    return { dialogs: [..._nativeDialogs], policy: policy() }
  }

  function clear() {
    _nativeDialogs.length = 0
    return { cleared: true }
  }

  function handle(params) {
    const action = params?.action
    if (action !== "accept" && action !== "dismiss" && action !== "manual") {
      throw new Error(
        `native dialog action must be "accept", "dismiss" or "manual", got: ${String(action).slice(0, 64)}`
      )
    }
    const paths = params.paths ?? []
    if (!Array.isArray(paths) || paths.some((path) => typeof path !== "string" || path === "")) {
      throw new Error("native dialog 'paths' must be an array of non-empty strings")
    }
    if (params.button != null && typeof params.button !== "string") {
      throw new Error("native dialog 'button' must be a string")
    }
    _nativeDialogPolicy.action = action
    // Paths and a button belong to an accept; a stale one must not resurface later.
    _nativeDialogPolicy.paths = action === "accept" ? [...paths] : []
    _nativeDialogPolicy.button = action === "accept" && params.button != null ? params.button : null
    save()
    return policy()
  }

  try {
    const stored = sessionStorage.getItem(STATE_KEY)
    if (stored) Object.assign(_nativeDialogPolicy, JSON.parse(stored))
  } catch {
    // No session storage: the policy starts at its default.
  }

  const fetchBefore = window.fetch
  window.fetch = function (input, init) {
    const url = typeof input === "string" ? input : input?.url || String(input)
    const answered = respond(url, init)
    if (answered) return Promise.resolve(answered)
    return fetchBefore.call(this, input, init)
  }

  Object.defineProperty(window, "__HASGARD_NATIVE_DIALOGS__", { value: { handle, list, clear } })
})()
