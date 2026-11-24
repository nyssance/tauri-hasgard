//! Tauri events: emit one to the application, and record the ones it emits.
//!
//! Events are how a Tauri backend and its windows talk without a command. A test
//! needs both directions: to deliver an event the backend would send, and to see
//! that the application emitted one.

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};

use serde_json::{Value, json};
use tauri::{Emitter, Listener};

use crate::protocol::{RPC_INTERNAL_ERROR, RPC_INVALID_PARAMS, RpcError};

pub(crate) const METHODS: &[&str] = &["event.emit", "event.listen", "event.unlisten", "event.list", "event.clear"];

const MAX_EVENTS: usize = 500;

#[derive(Default)]
struct Recorded {
    listeners: HashMap<String, tauri::EventId>,
    events: VecDeque<Value>,
    sequence: u64,
}

fn invalid(message: impl Into<String>) -> RpcError {
    RpcError { code: RPC_INVALID_PARAMS, message: message.into(), data: None }
}

/// Tauri's own rule for an event name. Checked here because Tauri panics on a
/// name it rejects when listening.
fn event_name<'a>(params: &'a Value, method: &str) -> Result<&'a str, RpcError> {
    let name = params
        .get("event")
        .and_then(Value::as_str)
        .filter(|name| !name.is_empty())
        .ok_or_else(|| invalid(format!("{method} requires a non-empty 'event'")))?;
    if name.chars().all(|c| c.is_alphanumeric() || matches!(c, '-' | '/' | ':' | '_')) {
        Ok(name)
    } else {
        Err(invalid(format!(
            "{method}: event names may contain only letters, digits, '-', '/', ':' and '_', got {name:?}"
        )))
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| u64::try_from(elapsed.as_millis()).unwrap_or(u64::MAX))
}

fn names_a_target<R: tauri::Runtime>(handle: &tauri::AppHandle<R>, label: &str) -> bool {
    use tauri::Manager;
    handle.get_webview(label).is_some() || handle.get_window(label).is_some()
}

pub(crate) fn make_event_fn<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> crate::eval::NativeFn {
    let handle = app.clone();
    let recorded = Arc::new(Mutex::new(Recorded::default()));
    Arc::new(move |label, method, params| {
        match method {
            "event.emit" => {
                let name = event_name(params, method)?;
                let payload = params.get("payload").cloned().unwrap_or(Value::Null);
                // Naming a window delivers to that window only; otherwise every listener hears it.
                let sent = match label {
                    // Tauri delivers to no one, and reports success, when nothing carries the label.
                    Some(label) if !names_a_target(&handle, label) => {
                        return Err(invalid(format!("{method}: no window or webview is labelled {label:?}")));
                    }
                    Some(label) => handle.emit_to(label, name, payload),
                    None => handle.emit(name, payload),
                };
                sent.map_err(|error| RpcError {
                    code: RPC_INTERNAL_ERROR,
                    message: format!("event.emit failed: {error}"),
                    data: None,
                })?;
                Ok(json!({"emitted": name}))
            }
            "event.listen" => {
                let name = event_name(params, method)?.to_owned();
                let mut state = recorded.lock().expect("recorded events");
                if !state.listeners.contains_key(&name) {
                    let log = Arc::clone(&recorded);
                    let heard = name.clone();
                    let id = handle.listen_any(name.clone(), move |event| {
                        // A payload is JSON by construction; one that is not is kept as its text.
                        let payload = serde_json::from_str::<Value>(event.payload())
                            .unwrap_or_else(|_| Value::String(event.payload().to_owned()));
                        let mut state = log.lock().expect("recorded events");
                        state.sequence += 1;
                        let entry = json!({
                            "id": state.sequence, "timestamp": now_ms(), "event": heard, "payload": payload
                        });
                        state.events.push_back(entry);
                        if state.events.len() > MAX_EVENTS {
                            state.events.pop_front();
                        }
                    });
                    state.listeners.insert(name.clone(), id);
                }
                Ok(json!({"listening": state.listeners.keys().collect::<std::collections::BTreeSet<_>>()}))
            }
            "event.unlisten" => {
                let name = event_name(params, method)?;
                let mut state = recorded.lock().expect("recorded events");
                if let Some(id) = state.listeners.remove(name) {
                    handle.unlisten(id);
                }
                Ok(json!({"listening": state.listeners.keys().collect::<std::collections::BTreeSet<_>>()}))
            }
            "event.list" => {
                let name = match params.get("event") {
                    None | Some(Value::Null) => None,
                    Some(_) => Some(event_name(params, method)?),
                };
                let since = crate::params::optional_u64(params, "sinceId", method)?.unwrap_or(0);
                let state = recorded.lock().expect("recorded events");
                let events: Vec<&Value> = state
                    .events
                    .iter()
                    .filter(|entry| entry["id"].as_u64().is_some_and(|id| id > since))
                    .filter(|entry| name.is_none_or(|name| entry["event"] == name))
                    .collect();
                Ok(json!({
                    "events": events,
                    "listening": state.listeners.keys().collect::<std::collections::BTreeSet<_>>(),
                }))
            }
            "event.clear" => {
                recorded.lock().expect("recorded events").events.clear();
                Ok(json!({"cleared": true}))
            }
            other => Err(RpcError {
                code: crate::protocol::RPC_METHOD_NOT_FOUND,
                message: format!("Unknown event method: {other}"),
                data: None,
            }),
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_event_name_tauri_would_reject_is_refused_before_it_reaches_tauri() {
        let valid = json!({"event": "download:done/1_a-b"});
        assert_eq!(event_name(&valid, "event.listen").expect("valid name"), "download:done/1_a-b");
        for params in [
            json!({}),
            json!({"event": ""}),
            json!({"event": 5}),
            json!({"event": "has space"}),
            json!({"event": "a.b"}),
        ] {
            assert_eq!(event_name(&params, "event.listen").expect_err("invalid name").code, RPC_INVALID_PARAMS);
        }
    }
}
