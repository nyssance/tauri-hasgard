//! Native window state and control: size, position, minimise, maximise, close.
//!
//! These act on the operating-system window, which the page cannot reach. A
//! label names a window, or a child webview, whose window is then the target.

use std::sync::Arc;

use serde_json::{Value, json};
use tauri::{LogicalPosition, LogicalSize, Manager};

use crate::protocol::{RPC_INTERNAL_ERROR, RPC_INVALID_PARAMS, RpcError};

pub(crate) const METHODS: &[&str] = &[
    "window.state",
    "window.resize",
    "window.move",
    "window.minimize",
    "window.maximize",
    "window.restore",
    "window.close",
];

fn failed(action: &str, error: impl std::fmt::Display) -> RpcError {
    RpcError { code: RPC_INTERNAL_ERROR, message: format!("{action} failed: {error}"), data: None }
}

fn number(params: &Value, name: &str, method: &str) -> Result<f64, RpcError> {
    params.get(name).and_then(Value::as_f64).filter(|value| value.is_finite()).ok_or_else(|| RpcError {
        code: RPC_INVALID_PARAMS,
        message: format!("{method} requires a numeric '{name}'"),
        data: None,
    })
}

/// Size and position in logical pixels, the unit CSS and the screen layout share.
fn state<R: tauri::Runtime>(label: &str, window: &tauri::Window<R>) -> Result<Value, RpcError> {
    let scale = window.scale_factor().map_err(|error| failed("window.state", error))?;
    let size = window.inner_size().map_err(|error| failed("window.state", error))?.to_logical::<f64>(scale);
    let position = window.outer_position().map_err(|error| failed("window.state", error))?.to_logical::<f64>(scale);
    let flag = |value: tauri::Result<bool>| value.map_err(|error| failed("window.state", error));
    Ok(json!({
        "label": label,
        "x": position.x,
        "y": position.y,
        "width": size.width,
        "height": size.height,
        "scaleFactor": scale,
        "visible": flag(window.is_visible())?,
        "focused": flag(window.is_focused())?,
        "minimized": flag(window.is_minimized())?,
        "maximized": flag(window.is_maximized())?,
        "fullscreen": flag(window.is_fullscreen())?,
    }))
}

pub(crate) fn make_window_fn<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> crate::eval::NativeFn {
    let handle = app.clone();
    Arc::new(move |label, method, params| {
        let label = label.unwrap_or("main");
        let window =
            handle.get_window(label).or_else(|| handle.get_webview(label).map(|webview| webview.window())).ok_or_else(
                || RpcError { code: RPC_INTERNAL_ERROR, message: format!("Window '{label}' not found"), data: None },
            )?;
        match method {
            "window.state" => return state(label, &window),
            "window.resize" => {
                let (width, height) = (number(params, "width", method)?, number(params, "height", method)?);
                if width < 1.0 || height < 1.0 {
                    return Err(RpcError {
                        code: RPC_INVALID_PARAMS,
                        message: "window.resize requires a width and height of at least 1".to_owned(),
                        data: None,
                    });
                }
                window.set_size(LogicalSize::new(width, height)).map_err(|error| failed(method, error))?;
            }
            "window.move" => {
                let position = LogicalPosition::new(number(params, "x", method)?, number(params, "y", method)?);
                window.set_position(position).map_err(|error| failed(method, error))?;
            }
            "window.minimize" => window.minimize().map_err(|error| failed(method, error))?,
            "window.maximize" => window.maximize().map_err(|error| failed(method, error))?,
            // Back to an ordinary window from either state.
            "window.restore" => {
                window.unminimize().map_err(|error| failed(method, error))?;
                window.unmaximize().map_err(|error| failed(method, error))?;
            }
            "window.close" => {
                window.close().map_err(|error| failed(method, error))?;
                return Ok(json!({"closed": true}));
            }
            other => {
                return Err(RpcError {
                    code: crate::protocol::RPC_METHOD_NOT_FOUND,
                    message: format!("Unknown window method: {other}"),
                    data: None,
                });
            }
        }
        // The window manager applies a change asynchronously; this is the state at reply time.
        state(label, &window)
    })
}
