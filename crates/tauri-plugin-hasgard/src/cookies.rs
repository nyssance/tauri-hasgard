//! The webview's cookie store: read, set and delete, `HttpOnly` cookies included.
//!
//! Page script sees only what `document.cookie` exposes. A test that needs a
//! signed-in session, or has to assert on a session cookie, needs the store itself.

use serde_json::{Value, json};
use tauri::Manager;
use tauri::webview::Cookie;
use tauri::webview::cookie::{SameSite, time::OffsetDateTime};

use crate::protocol::{RPC_INTERNAL_ERROR, RPC_INVALID_PARAMS, RpcError};

pub(crate) const METHODS: &[&str] = &["cookies.get", "cookies.set", "cookies.clear"];

fn invalid(message: impl Into<String>) -> RpcError {
    RpcError { code: RPC_INVALID_PARAMS, message: message.into(), data: None }
}

fn failed(action: &str, error: impl std::fmt::Display) -> RpcError {
    RpcError { code: RPC_INTERNAL_ERROR, message: format!("{action} failed: {error}"), data: None }
}

fn optional_str<'a>(params: &'a Value, name: &str, method: &str) -> Result<Option<&'a str>, RpcError> {
    match params.get(name) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) => Ok(Some(value)),
        Some(_) => Err(invalid(format!("{method}: '{name}' must be a string"))),
    }
}

fn optional_bool(params: &Value, name: &str, method: &str) -> Result<Option<bool>, RpcError> {
    match params.get(name) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Bool(value)) => Ok(Some(*value)),
        Some(_) => Err(invalid(format!("{method}: '{name}' must be a boolean"))),
    }
}

fn parse_url(raw: &str, method: &str) -> Result<tauri::Url, RpcError> {
    tauri::Url::parse(raw).map_err(|error| invalid(format!("{method}: invalid url '{raw}': {error}")))
}

fn describe(cookie: &Cookie<'_>) -> Value {
    json!({
        "name": cookie.name(),
        "value": cookie.value(),
        "domain": cookie.domain(),
        "path": cookie.path(),
        // Seconds since the Unix epoch; null for a session cookie.
        "expires": cookie.expires_datetime().map(OffsetDateTime::unix_timestamp),
        "httpOnly": cookie.http_only().unwrap_or(false),
        "secure": cookie.secure().unwrap_or(false),
        "sameSite": cookie.same_site().map(|policy| match policy {
            SameSite::Strict => "Strict",
            SameSite::Lax => "Lax",
            SameSite::None => "None",
        }),
    })
}

/// Build the cookie `cookies.set` describes. `url` supplies the domain, the path
/// `/` and the `secure` flag when they are not given.
fn build(params: &Value) -> Result<Cookie<'static>, RpcError> {
    let method = "cookies.set";
    let name = optional_str(params, "name", method)?
        .filter(|name| !name.is_empty())
        .ok_or_else(|| invalid("cookies.set requires a non-empty 'name'"))?;
    let value = optional_str(params, "value", method)?.ok_or_else(|| invalid("cookies.set requires a 'value'"))?;
    let url = optional_str(params, "url", method)?.map(|raw| parse_url(raw, method)).transpose()?;
    let domain = match (optional_str(params, "domain", method)?, &url) {
        (Some(domain), _) => domain.to_owned(),
        (None, Some(url)) => {
            url.host_str().ok_or_else(|| invalid("cookies.set: the url has no host to use as the domain"))?.to_owned()
        }
        (None, None) => return Err(invalid("cookies.set requires a 'domain' or a 'url'")),
    };
    let secure = optional_bool(params, "secure", method)?
        .unwrap_or_else(|| url.as_ref().is_some_and(|url| url.scheme() == "https"));
    let mut cookie = Cookie::build((name.to_owned(), value.to_owned()))
        .domain(domain)
        .path(optional_str(params, "path", method)?.unwrap_or("/").to_owned())
        .secure(secure)
        .http_only(optional_bool(params, "httpOnly", method)?.unwrap_or(false));
    if let Some(policy) = optional_str(params, "sameSite", method)? {
        cookie = cookie.same_site(match policy {
            "Strict" => SameSite::Strict,
            "Lax" => SameSite::Lax,
            "None" => SameSite::None,
            other => return Err(invalid(format!("cookies.set: 'sameSite' must be Strict, Lax or None, got {other}"))),
        });
    }
    match params.get("expires") {
        None | Some(Value::Null) => {}
        Some(expires) => {
            let seconds = expires
                .as_i64()
                .ok_or_else(|| invalid("cookies.set: 'expires' must be whole seconds since the Unix epoch"))?;
            let at = OffsetDateTime::from_unix_timestamp(seconds)
                .map_err(|error| invalid(format!("cookies.set: 'expires' is out of range: {error}")))?;
            cookie = cookie.expires(at);
        }
    }
    Ok(cookie.build())
}

/// A runtime may hand a change to the store and return before the store has
/// applied it. Each change is confirmed by reading the store back.
const SETTLE: std::time::Duration = std::time::Duration::from_secs(2);
const SETTLE_POLL: std::time::Duration = std::time::Duration::from_millis(10);

fn same_cookie(stored: &Cookie<'_>, name: &str, domain: Option<&str>, path: Option<&str>) -> bool {
    let bare = |domain: &str| domain.trim_start_matches('.').to_ascii_lowercase();
    stored.name() == name && stored.domain().map(bare) == domain.map(bare) && stored.path() == path
}

/// Poll `stored` until `settled` accepts what the store holds.
fn settle(
    method: &str, what: &str, stored: impl Fn() -> Result<Vec<Cookie<'static>>, RpcError>,
    settled: impl Fn(&[Cookie<'static>]) -> bool,
) -> Result<(), RpcError> {
    let deadline = std::time::Instant::now() + SETTLE;
    loop {
        if settled(&stored()?) {
            return Ok(());
        }
        if std::time::Instant::now() >= deadline {
            return Err(failed(method, format!("the cookie store did not {what}")));
        }
        std::thread::sleep(SETTLE_POLL);
    }
}

pub(crate) fn make_cookie_fn<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> crate::eval::NativeFn {
    let handle = app.clone();
    std::sync::Arc::new(move |label, method, params| {
        let label = label.unwrap_or("main");
        let webview = handle.get_webview(label).ok_or_else(|| RpcError {
            code: RPC_INTERNAL_ERROR,
            message: format!("Window '{label}' not found"),
            data: None,
        })?;
        let listed = |url: Option<&str>| -> Result<Vec<Cookie<'static>>, RpcError> {
            match url {
                Some(raw) => webview.cookies_for_url(parse_url(raw, method)?),
                None => webview.cookies(),
            }
            .map_err(|error| failed(method, error))
        };
        match method {
            "cookies.get" => {
                let name = optional_str(params, "name", method)?;
                let cookies = listed(optional_str(params, "url", method)?)?;
                Ok(Value::Array(
                    cookies
                        .iter()
                        .filter(|cookie| name.is_none_or(|name| cookie.name() == name))
                        .map(describe)
                        .collect(),
                ))
            }
            "cookies.set" => {
                let cookie = build(params)?;
                let described = describe(&cookie);
                webview.set_cookie(cookie.clone()).map_err(|error| failed(method, error))?;
                // A store that refuses the cookie — a domain it will not accept, say — never shows it.
                settle(
                    method,
                    "accept the cookie",
                    || listed(None),
                    |stored| {
                        stored.iter().any(|stored| {
                            same_cookie(stored, cookie.name(), cookie.domain(), cookie.path())
                                && stored.value() == cookie.value()
                        })
                    },
                )?;
                Ok(described)
            }
            "cookies.clear" => {
                let name = optional_str(params, "name", method)?;
                let domain = optional_str(params, "domain", method)?;
                let mut removed = Vec::new();
                for cookie in listed(optional_str(params, "url", method)?)? {
                    let wanted = name.is_none_or(|name| cookie.name() == name)
                        && domain.is_none_or(|domain| {
                            cookie.domain().is_some_and(|own| own.trim_start_matches('.') == domain)
                        });
                    if wanted {
                        webview.delete_cookie(cookie.clone()).map_err(|error| failed(method, error))?;
                        removed.push(cookie);
                    }
                }
                settle(
                    method,
                    "delete the cookies",
                    || listed(None),
                    |stored| {
                        !stored.iter().any(|stored| {
                            removed.iter().any(|gone| same_cookie(stored, gone.name(), gone.domain(), gone.path()))
                        })
                    },
                )?;
                Ok(json!({"removed": removed.len()}))
            }
            other => Err(RpcError {
                code: crate::protocol::RPC_METHOD_NOT_FOUND,
                message: format!("Unknown cookie method: {other}"),
                data: None,
            }),
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_url_supplies_domain_path_and_secure_and_explicit_fields_win() {
        let cookie = build(&json!({"name": "sid", "value": "abc", "url": "https://app.example.test/login"}))
            .expect("cookie from a url");
        assert_eq!(
            describe(&cookie),
            json!({
                "name": "sid", "value": "abc", "domain": "app.example.test", "path": "/",
                "expires": null, "httpOnly": false, "secure": true, "sameSite": null
            })
        );

        let explicit = build(&json!({
            "name": "sid", "value": "", "url": "https://app.example.test/", "domain": "example.test",
            "path": "/api", "secure": false, "httpOnly": true, "sameSite": "Strict", "expires": 2_000_000_000
        }))
        .expect("explicit cookie");
        assert_eq!(
            describe(&explicit),
            json!({
                "name": "sid", "value": "", "domain": "example.test", "path": "/api",
                "expires": 2_000_000_000_i64, "httpOnly": true, "secure": false, "sameSite": "Strict"
            })
        );
    }

    #[test]
    fn a_cookie_without_what_it_needs_is_rejected() {
        for params in [
            json!({"value": "x", "domain": "example.test"}),
            json!({"name": "", "value": "x", "domain": "example.test"}),
            json!({"name": "a", "domain": "example.test"}),
            json!({"name": "a", "value": "x"}),
            json!({"name": "a", "value": "x", "url": "not a url"}),
            json!({"name": "a", "value": "x", "url": "data:text/plain,hi"}),
            json!({"name": "a", "value": "x", "domain": "example.test", "sameSite": "lax"}),
            json!({"name": "a", "value": "x", "domain": "example.test", "expires": "tomorrow"}),
            json!({"name": "a", "value": "x", "domain": "example.test", "secure": "yes"}),
        ] {
            assert_eq!(build(&params).expect_err("invalid cookie").code, RPC_INVALID_PARAMS, "{params}");
        }
    }
}
