//! The system clipboard's text, read and written from the application's process.
//!
//! `navigator.clipboard` needs a focused document and, in some webviews, a
//! permission prompt; neither exists in a test. The clipboard itself is shared
//! with the user, so a test that writes it should restore what it found.

use serde_json::{Value, json};

use crate::protocol::{RPC_INTERNAL_ERROR, RPC_INVALID_PARAMS, RpcError};

pub(crate) const METHODS: &[&str] = &["clipboard.read", "clipboard.write"];

fn failed(action: &str, error: impl std::fmt::Display) -> RpcError {
    RpcError { code: RPC_INTERNAL_ERROR, message: format!("{action} failed: {error}"), data: None }
}

pub(crate) fn make_clipboard_fn() -> crate::eval::NativeFn {
    std::sync::Arc::new(|_label, method, params| {
        let mut clipboard = arboard::Clipboard::new().map_err(|error| failed(method, error))?;
        match method {
            "clipboard.read" => match clipboard.get_text() {
                Ok(text) => Ok(json!({"text": text})),
                // Empty, or holding something that is not text: there is no text to report.
                Err(arboard::Error::ContentNotAvailable) => Ok(json!({"text": null})),
                Err(error) => Err(failed(method, error)),
            },
            "clipboard.write" => {
                let text = params.get("text").and_then(Value::as_str).ok_or_else(|| RpcError {
                    code: RPC_INVALID_PARAMS,
                    message: "clipboard.write requires a string 'text'".to_owned(),
                    data: None,
                })?;
                clipboard.set_text(text).map_err(|error| failed(method, error))?;
                Ok(json!({"written": true}))
            }
            other => Err(RpcError {
                code: crate::protocol::RPC_METHOD_NOT_FOUND,
                message: format!("Unknown clipboard method: {other}"),
                data: None,
            }),
        }
    })
}
