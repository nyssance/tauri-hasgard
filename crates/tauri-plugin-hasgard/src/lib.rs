pub mod diff;
mod error;
#[cfg(any(unix, windows))]
pub(crate) mod eval;
#[cfg(any(unix, windows))]
mod handler;
#[cfg(feature = "press")]
pub(crate) mod key;
pub(crate) mod protocol;
pub(crate) mod recorder;
// Native screenshot capture for the `screenshot_native` JSON-RPC method.
// macOS-only today; non-macOS callers receive `PERMISSION_DENIED`.
pub(crate) mod screenshot;
#[cfg(any(unix, windows))]
pub(crate) mod server;

pub use error::Error;

#[cfg(any(unix, windows))]
use eval::EvalEngine;
#[cfg(any(unix, windows))]
use recorder::Recorder;
#[cfg(any(unix, windows))]
use server::{EvalFn, ListWindowsFn, PressHooksRef};
#[cfg(any(unix, windows))]
use std::sync::Arc;
#[cfg(any(unix, windows))]
use tauri::Manager;

#[cfg(all(any(unix, windows), debug_assertions))]
pub(crate) const BRIDGE_JS: &str =
    concat!(include_str!("../js/vendor/html-to-image.iife.js"), "\n", include_str!("../js/bridge.js"));

/// Initialize the tauri-hasgard plugin.
///
/// On non-Unix, non-Windows platforms or in release builds, returns a no-op plugin.
/// In debug builds on Unix, injects the JS bridge, stores an `EvalEngine`,
/// and starts a Unix socket server at `TAURI_HASGARD_SOCKET` when set, otherwise
/// at `$XDG_RUNTIME_DIR/tauri-hasgard-{identifier}.sock`.
/// In debug builds on Windows, starts a Named Pipe server at
/// `\\.\pipe\tauri-hasgard-{identifier}` and registers the instance under `%LOCALAPPDATA%\tauri-hasgard\instances\`.
#[must_use]
pub fn init<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    #[cfg(not(all(any(unix, windows), debug_assertions)))]
    {
        return tauri::plugin::Builder::new("hasgard").build();
    }

    #[cfg(all(any(unix, windows), debug_assertions))]
    {
        tauri::plugin::Builder::new("hasgard")
            .js_init_script(BRIDGE_JS.to_owned())
            .setup(|app, _api| {
                let engine = EvalEngine::new();
                app.manage(engine.clone());

                let identifier = sanitize_identifier(&app.config().identifier);
                let socket_path = match std::env::var_os("TAURI_HASGARD_SOCKET") {
                    Some(path) => std::path::PathBuf::from(path),
                    None => server::socket_path(&identifier),
                };

                let eval_fn = make_eval_fn(app);
                let list_fn = make_list_fn(app);
                let press_hooks = make_press_hooks(app);

                let recorder = Recorder::new();

                // Unix binds with the std (sync) `UnixListener`, which needs no
                // tokio runtime, so binding stays here in `setup` where a failure
                // surfaces as a hard plugin error. `run` only upgrades the
                // listener to tokio once it is already on the runtime.
                #[cfg(unix)]
                {
                    let (listener, guard) = server::bind(&socket_path).map_err(|e| {
                        tracing::error!(path = %socket_path.display(), "failed to bind socket: {e}");
                        e
                    })?;
                    tauri::async_runtime::spawn(server::run(
                        listener,
                        guard,
                        engine,
                        Some(eval_fn),
                        Some(list_fn),
                        Some(press_hooks),
                        recorder,
                    ));
                }

                // Windows' tokio `NamedPipeServer` registers with the reactor the
                // instant it is created, so the bind must run inside the spawned
                // task (which lives on the tokio runtime). Binding here in `setup`
                // panics with "there is no reactor running, must be called from
                // the context of a Tokio 1.x runtime" (#115).
                #[cfg(windows)]
                tauri::async_runtime::spawn(server::run(
                    socket_path,
                    engine,
                    Some(eval_fn),
                    Some(list_fn),
                    Some(press_hooks),
                    recorder,
                ));

                Ok(())
            })
            .invoke_handler(tauri::generate_handler![handler::callback, handler::__callback])
            .build()
    }
}

/// Strip path separators and unsafe characters from the app identifier
/// so it can be safely used in a socket filename.
#[cfg(all(any(unix, windows), debug_assertions))]
fn sanitize_identifier(raw: &str) -> String {
    let sanitized: String = raw
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.' { c } else { '_' })
        .collect();
    if sanitized.is_empty() { "default".to_owned() } else { sanitized }
}

/// Create an eval function from the app handle that evaluates JS in a webview.
///
/// If `window` is `Some(label)`, targets that specific window (error if not found).
/// If `window` is `None`, targets the conventional `main` window.
#[cfg(all(any(unix, windows), debug_assertions))]
fn make_eval_fn<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> EvalFn {
    let handle = app.clone();
    Arc::new(move |window: Option<&str>, script: String| {
        let target = if let Some(label) = window {
            handle.get_webview_window(label).ok_or_else(|| format!("Window '{label}' not found"))?
        } else {
            handle.get_webview_window("main").ok_or_else(|| "Window 'main' not found".to_owned())?
        };
        // Results come back via the `__callback` IPC command (see
        // EvalEngine::wrap_script). This eval is fire-and-forget; the IPC handler
        // resolves the pending request, not this closure.
        target.eval(&script).map_err(|e| e.to_string())
    })
}

/// Create the host hooks the `press` path needs: window focus, plus a runner
/// that executes a closure on the application's main thread.
///
/// Resolution mirrors `make_eval_fn`: explicit label first, otherwise `main`.
#[cfg(all(any(unix, windows), debug_assertions))]
fn make_press_hooks<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> PressHooksRef {
    let focus_handle = app.clone();
    let main_handle = app.clone();
    Arc::new(crate::server::PressHooks {
        focus: Box::new(move |window: Option<&str>| {
            let target = if let Some(label) = window {
                focus_handle.get_webview_window(label).ok_or_else(|| format!("Window '{label}' not found"))?
            } else {
                focus_handle.get_webview_window("main").ok_or_else(|| "Window 'main' not found".to_owned())?
            };
            target.set_focus().map_err(|e| e.to_string())?;

            #[cfg(windows)]
            {
                use std::sync::mpsc;
                use webview2_com::Microsoft::Web::WebView2::Win32::COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC;

                let (sender, receiver) = mpsc::sync_channel(1);
                target
                    .with_webview(move |webview| {
                        let result =
                            unsafe { webview.controller().MoveFocus(COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC) }
                                .map_err(|error| error.to_string());
                        sender.send(result).expect("focus result receiver must exist");
                    })
                    .map_err(|error| error.to_string())?;
                receiver
                    .recv_timeout(std::time::Duration::from_secs(2))
                    .map_err(|error| format!("WebView focus timed out: {error}"))??;
            }

            Ok(())
        }),
        on_main_thread: Box::new(move |task: Box<dyn FnOnce() + Send>| {
            let (done_tx, done_rx) = std::sync::mpsc::sync_channel(1);
            main_handle
                .run_on_main_thread(move || {
                    task();
                    // A closed receiver means the caller timed out and gave up;
                    // the work still ran, so there is nothing to report.
                    let _ = done_tx.send(());
                })
                .map_err(|error| format!("could not reach the main thread: {error}"))?;
            done_rx
                .recv_timeout(std::time::Duration::from_secs(10))
                .map_err(|error| format!("main-thread task did not finish: {error}"))
        }),
    })
}

/// The `CGWindowID` of a webview's host window, which is what
/// `screenshot_native` captures by.
///
/// `NSWindow.windowNumber` *is* the `CGWindowID` for on-screen windows, so this
/// is an exact lookup. The alternative — matching the CoreGraphics window list
/// by owner and title — guesses, and guesses wrong as soon as an app opens two
/// windows with the same title.
///
/// Returns `None` rather than an error when the id cannot be read: a window id
/// is a convenience field on `windows.list`, and failing to read it must not
/// take down an otherwise valid window listing.
#[cfg(all(target_os = "macos", debug_assertions))]
fn native_window_id<R: tauri::Runtime>(window: &tauri::WebviewWindow<R>) -> Option<u32> {
    use objc2_app_kit::NSWindow;

    let ptr = window.ns_window().ok()?;
    if ptr.is_null() {
        return None;
    }
    // SAFETY: `ns_window()` returns the `NSWindow *` Tauri holds for this
    // webview, valid for as long as the window is alive — which it is, since we
    // are iterating the live window map. The pointer is only borrowed for the
    // duration of this read and never stored.
    let ns_window: &NSWindow = unsafe { &*ptr.cast::<NSWindow>() };
    u32::try_from(ns_window.windowNumber()).ok()
}

#[cfg(all(any(unix, windows), debug_assertions, not(target_os = "macos")))]
fn native_window_id<R: tauri::Runtime>(_window: &tauri::WebviewWindow<R>) -> Option<u32> {
    None
}

/// Create a list function that enumerates all available webview windows.
#[cfg(all(any(unix, windows), debug_assertions))]
fn make_list_fn<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> ListWindowsFn {
    let handle = app.clone();
    Arc::new(move || {
        let windows = handle.webview_windows();
        // BTreeMap iterates in sorted key order — no explicit sort needed
        let list: Result<Vec<serde_json::Value>, String> = windows
            .iter()
            .map(|(label, wv)| {
                let url = wv.url().map_err(|error| format!("Failed to read URL for window '{label}': {error}"))?;
                let title =
                    wv.title().map_err(|error| format!("Failed to read title for window '{label}': {error}"))?;
                let mut entry = serde_json::json!({
                    "label": label,
                    "url": url.to_string(),
                    "title": title,
                });
                // Present only where native capture exists, so a client can tell
                // "this platform cannot capture natively" from "this window has
                // no id" without a second probe.
                if let Some(native_id) = native_window_id(wv) {
                    entry["native_id"] = serde_json::json!(native_id);
                }
                Ok(entry)
            })
            .collect();
        Ok(serde_json::json!({"windows": list?}))
    })
}

#[cfg(test)]
mod tests {
    #[cfg(all(any(unix, windows), debug_assertions))]
    #[test]
    fn bridge_js_contains_html_to_image_and_hasgard() {
        let js = super::BRIDGE_JS;
        assert!(js.contains("htmlToImage"), "BRIDGE_JS must include the html-to-image IIFE bundle");
        assert!(js.contains("window.__HASGARD__"), "BRIDGE_JS must include the hasgard bridge");
        let html_idx = js.find("htmlToImage").expect("htmlToImage missing");
        let hasgard_idx = js.find("window.__HASGARD__").expect("window.__HASGARD__ missing");
        assert!(html_idx < hasgard_idx, "html-to-image must be injected before hasgard bridge code");
    }

    #[cfg(all(any(unix, windows), debug_assertions))]
    #[test]
    fn bridge_click_dispatches_pointer_sequence() {
        let js = super::BRIDGE_JS;
        let js_normalized: String = js.lines().collect::<Vec<_>>().join("\n");
        let pointer_down_idx = js
            .find(r#"dispatchPointerEvent(el, "pointerdown""#)
            .expect("click must dispatch pointerdown for Radix triggers");
        let mouse_down_idx = js.find(r#"MouseEvent("mousedown""#).expect("click must keep mousedown compatibility");
        let pointer_up_idx = js
            .find(r#"dispatchPointerEvent(el, "pointerup""#)
            .expect("click must dispatch pointerup for Radix triggers");
        let mouse_up_idx = js.find(r#"MouseEvent("mouseup""#).expect("click must keep mouseup compatibility");
        let click_idx = js.find(r#"dispatchPointerEvent(el, "click""#).expect("click must dispatch as a pointer event");

        assert!(
            pointer_down_idx < mouse_down_idx
                && mouse_down_idx < pointer_up_idx
                && pointer_up_idx < mouse_up_idx
                && mouse_up_idx < click_idx,
            "click must dispatch pointerdown -> mousedown -> pointerup -> mouseup -> click"
        );
        assert!(js.contains(r#"pointerType: "mouse""#), "pointer events must include mouse pointer metadata");
        assert!(
            js_normalized.contains(
                "if (pointerDownOk) {\n      const mouseDownOk = el.dispatchEvent(new MouseEvent(\"mousedown\""
            ),
            "mousedown must only dispatch when pointerdown was not canceled"
        );
        assert!(
            js_normalized.contains("if (pointerDownOk) {\n      el.dispatchEvent(new MouseEvent(\"mouseup\""),
            "mouseup must only dispatch when pointerdown was not canceled"
        );
    }

    #[cfg(all(any(unix, windows), debug_assertions))]
    #[test]
    fn bridge_scroll_handles_top_and_bottom_directions() {
        let js = super::BRIDGE_JS;
        assert!(js.contains(r#"if (dir === "top")"#), "scroll must handle direction \"top\"");
        assert!(js.contains(r#"if (dir === "bottom")"#), "scroll must handle direction \"bottom\"");
        assert!(
            js.contains("target.scrollTo(window.scrollX, 0)"),
            "scroll top on window must preserve window.scrollX and set Y=0"
        );
        assert!(
            js.contains("target.scrollTo(window.scrollX, Math.max(0, max))"),
            "scroll bottom on window must preserve window.scrollX and clamp negative max"
        );
        assert!(
            js.contains("Math.max(")
                && js.contains("docEl ? docEl.scrollHeight : 0")
                && js.contains("body ? body.scrollHeight : 0"),
            "scroll bottom on window must use Math.max(documentElement.scrollHeight, body.scrollHeight) for quirks-mode safety"
        );
        assert!(
            js.contains("docEl ? docEl.clientHeight : window.innerHeight"),
            "scroll bottom on window must subtract docEl.clientHeight (excludes horizontal scrollbar) instead of window.innerHeight"
        );
        assert!(
            js.contains("String(dir).slice(0, 64)"),
            "scroll error message must cap user-supplied direction length"
        );
        assert!(js.contains("target.scrollTop = 0"), "scroll top on element must set scrollTop = 0");
        assert!(
            js.contains("target.scrollTop = Math.max(0, target.scrollHeight - target.clientHeight)"),
            "scroll bottom on element must use scrollHeight - clientHeight (not raw scrollHeight)"
        );
        assert!(
            js.contains("Unknown scroll direction:"),
            "scroll must throw on unknown direction instead of silently no-op"
        );
    }

    #[cfg(all(any(unix, windows), debug_assertions))]
    #[test]
    fn bridge_eval_auto_wraps_top_level_await() {
        // #79: top-level `await` in user scripts must compile via the
        // async-IIFE fallback stages instead of crashing with an opaque
        // SyntaxError from indirect eval.
        let js = super::BRIDGE_JS;
        assert!(js.contains("function evalScript("), "BRIDGE_JS must define evalScript");
        assert!(
            js.contains("(async () => (\\n\" + script + \"\\n))()"),
            "evalScript must include the async-expression compile stage (#79)"
        );
        assert!(
            js.contains("hasTopLevelAwait(script)"),
            "evalScript must guard the async fallbacks with hasTopLevelAwait (#79)"
        );
        assert!(
            js.contains("(async () => {\\n\" + script + \"\\n})()"),
            "evalScript must include the async-statement IIFE fallback (#79)"
        );
        assert!(js.contains("function hasTopLevelAwait("), "BRIDGE_JS must define the hasTopLevelAwait helper (#79)");
        assert!(
            js.contains("top-level await detected but the script could not be auto-wrapped"),
            "evalScript must surface a clear error when auto-wrap fails (#79)"
        );

        // Stage ordering: expression compile must precede the async fallbacks,
        // and the async-expression stage must precede the indirect-eval path.
        // Needles are formatting-stable substrings of the JS source, so a
        // future `prettier`/`rustfmt` reflow of `bridge.js` does not silently
        // break the ordering check.
        let evalscript_idx = js.find("function evalScript(").expect("evalScript missing");
        // SAFETY: the needle is ASCII, so `find()` returns a UTF-8 char boundary.
        let body = &js[evalscript_idx..];
        let expr_idx = body.find("\"return (\\n\" + script + \"\\n)\"").expect("stage 1 expression compile missing");
        let async_expr_idx = body
            .find("\"return (async () => (\\n\" + script + \"\\n))()\"")
            .expect("stage 2 async-expression compile missing");
        let async_stmt_idx = body
            .find("\"return (async () => {\\n\" + script + \"\\n})()\"")
            .expect("stage 3 async-statement IIFE missing");
        let indirect_idx = body.find("var indirectEval = eval;").expect("indirect eval fallback missing");
        assert!(expr_idx < async_expr_idx, "expression compile must precede async-expression fallback");
        assert!(async_expr_idx < async_stmt_idx, "async-expression must precede async-statement fallback");
        assert!(
            async_stmt_idx < indirect_idx,
            "async-statement IIFE must precede plain indirect eval (await guard runs first)"
        );
    }

    #[cfg(all(any(unix, windows), debug_assertions))]
    #[test]
    fn bridge_native_value_setter_picks_prototype_per_element() {
        // #85: `fill` and `type` on a <textarea> threw
        // "The HTMLInputElement.value setter can only be used on instances of HTMLInputElement"
        // because the old code used
        //   Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")
        //   || Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value");
        // The first descriptor is always truthy, so the textarea branch was unreachable
        // and the input setter was applied to a textarea, violating the WebIDL brand check.
        let js = super::BRIDGE_JS;

        assert!(
            js.contains("function nativeValueSetter("),
            "BRIDGE_JS must define a nativeValueSetter helper that picks the prototype based on the element (#85)"
        );

        // The helper must use the element's actual prototype to support input,
        // textarea, and select uniformly without violating the brand check.
        assert!(
            js.contains("Object.getPrototypeOf(el)"),
            "nativeValueSetter must derive the prototype from the element instance (#85)"
        );

        // Buggy short-circuit must be gone from fill/typeText.
        let buggy_pattern = "Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, \"value\") ||";
        assert!(
            !js.contains(buggy_pattern),
            "fill/typeText must not use the `HTMLInputElement.prototype || HTMLTextAreaElement.prototype` short-circuit (#85)"
        );

        // Bound each function body by the start of the next `function ` declaration
        // (or end-of-string), so the slice is immune to brace indentation changes
        // and to nested blocks closing with the same brace pattern.
        // ASCII needles → `find()` returns offsets that are valid UTF-8 char boundaries.
        let body_of = |fn_decl: &str| -> &str {
            let start = js.find(fn_decl).unwrap_or_else(|| panic!("{fn_decl} missing"));
            let after = start + fn_decl.len();
            let end = js[after..].find("\n  function ").map_or(js.len(), |off| after + off);
            &js[start..end]
        };

        let fill_body = body_of("function fill(params)");
        let type_body = body_of("function typeText(params)");
        let select_body = body_of("function select(params)");

        assert!(fill_body.contains("nativeValueSetter("), "fill must call nativeValueSetter (#85)");
        assert!(type_body.contains("nativeValueSetter("), "typeText must call nativeValueSetter (#85)");
        assert!(
            select_body.contains("nativeValueSetter("),
            "select must call nativeValueSetter (#85) so a future textarea-style brand-check bug cannot reappear in any setter handler"
        );

        // The pre-refactor `select` relied on the WebIDL brand check to reject
        // non-<select> targets implicitly. The helper drops that guarantee, so
        // `select` must keep an explicit guard to fail fast on misrouted
        // selectors instead of silently writing `value` on an unrelated
        // element. The guard must be realm-safe (tag-based, not `instanceof`),
        // because `nativeValueSetter` was added specifically to support
        // elements coming from another window/iframe realm.
        assert!(
            select_body.contains("select requires a <select> element"),
            "select must explicitly reject non-<select> targets after the nativeValueSetter refactor (#85)"
        );
        assert!(
            !select_body.contains("instanceof HTMLSelectElement"),
            "select guard must be realm-safe — `instanceof HTMLSelectElement` rejects valid <select> elements from another realm, which contradicts the cross-realm support that motivated nativeValueSetter (#85)"
        );

        // Helper must be defined before its callers (hoisting works for `function`
        // declarations, but ordering keeps the source readable for reviewers).
        let fill_idx = js.find("function fill(params)").expect("fill function missing");
        let helper_idx = js.find("function nativeValueSetter(").expect("nativeValueSetter helper missing");
        assert!(helper_idx < fill_idx, "nativeValueSetter must be declared before fill (#85)");
    }

    #[cfg(all(any(unix, windows), debug_assertions))]
    #[test]
    fn bridge_role_map_maps_paragraph_and_keeps_it_noninteractive() {
        // #109: <p> text (e.g. the default Tauri template greeting rendered in
        // a <p>) was dropped from snapshots because ROLE_MAP had no P entry, so
        // getRole returned null and walk() never emitted the node.
        let js = super::BRIDGE_JS;

        assert!(
            js.contains("P: \"paragraph\""),
            "ROLE_MAP must map P to \"paragraph\" so snapshot includes <p> text (#109)"
        );

        // The paragraph role must stay non-interactive so `snapshot --interactive`
        // still excludes <p>. Verify INTERACTIVE_ROLES does not list it.
        let set_start = js.find("INTERACTIVE_ROLES = new Set([").expect("INTERACTIVE_ROLES set missing");
        let set_body = &js[set_start..];
        let set_end = set_body.find("]);").expect("INTERACTIVE_ROLES set unterminated");
        assert!(
            !set_body[..set_end].contains("\"paragraph\""),
            "paragraph must stay out of INTERACTIVE_ROLES so interactive snapshots still exclude <p> (#109)"
        );
    }
}
