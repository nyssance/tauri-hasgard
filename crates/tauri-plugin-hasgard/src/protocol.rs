pub(crate) const MAX_REQUEST_BYTES: usize = 1_048_576;

use serde::{Deserialize, Deserializer, Serialize};

/// JSON-RPC 2.0 numeric error codes (subset used by this crate).
///
/// Centralised here so every handler and test references the same constants
/// rather than scattering `-32602`/`-32603` literals across modules.
#[cfg_attr(not(any(unix, windows)), allow(dead_code, reason = "only referenced by the macOS/IPC handlers"))]
pub(crate) const RPC_INVALID_PARAMS: i32 = -32602;
#[cfg_attr(not(any(unix, windows)), allow(dead_code, reason = "only referenced by the macOS/IPC handlers"))]
pub(crate) const RPC_INTERNAL_ERROR: i32 = -32603;

/// Deserialize params, normalizing `null` to `None`.
fn deserialize_params<'de, D>(deserializer: D) -> Result<Option<serde_json::Value>, D::Error>
where
    D: Deserializer<'de>,
{
    let val: Option<serde_json::Value> = Option::deserialize(deserializer)?;
    match val {
        Some(serde_json::Value::Null) => Ok(None),
        other => Ok(other),
    }
}

/// A JSON-RPC 2.0 request.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct Request {
    pub jsonrpc: String,
    pub id: u64,
    pub method: String,
    #[serde(default, deserialize_with = "deserialize_params")]
    pub params: Option<serde_json::Value>,
}

/// A JSON-RPC 2.0 response.
#[derive(Debug, Clone, Serialize)]
pub(crate) struct Response {
    pub jsonrpc: String,
    pub id: serde_json::Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<RpcError>,
}

impl<'de> Deserialize<'de> for Response {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        use serde::de::Error;
        let value = serde_json::Value::deserialize(deserializer)?;
        let object = value.as_object().ok_or_else(|| D::Error::custom("response must be an object"))?;
        if object.get("jsonrpc").and_then(serde_json::Value::as_str) != Some("2.0") {
            return Err(D::Error::custom("response jsonrpc must be 2.0"));
        }
        let id = object.get("id").ok_or_else(|| D::Error::custom("response id is required"))?;
        if !id.is_null() && id.as_u64().is_none_or(|id| id > 9_007_199_254_740_991) {
            return Err(D::Error::custom("response id must be a nonnegative safe integer or null"));
        }
        let has_result = object.contains_key("result");
        let has_error = object.contains_key("error");
        if has_result == has_error {
            return Err(D::Error::custom("response requires exactly one of result or error"));
        }
        if has_result && id.is_null() {
            return Err(D::Error::custom("successful response id must not be null"));
        }
        let error = object
            .get("error")
            .map(|value| serde_json::from_value(value.clone()))
            .transpose()
            .map_err(D::Error::custom)?;
        Ok(Self {
            jsonrpc: "2.0".to_owned(),
            id: id.clone(),
            // Preserve explicit null: it is a valid result, unlike an absent field.
            result: object.get("result").cloned(),
            error,
        })
    }
}

/// A JSON-RPC 2.0 error object.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct RpcError {
    pub code: i32,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<serde_json::Value>,
}

impl Response {
    /// Create a success response.
    #[must_use]
    pub(crate) fn success(id: u64, result: serde_json::Value) -> Self {
        Self { jsonrpc: "2.0".to_owned(), id: serde_json::Value::Number(id.into()), result: Some(result), error: None }
    }

    /// Create an error response.
    #[must_use]
    pub(crate) fn error(id: serde_json::Value, code: i32, message: impl Into<String>) -> Self {
        Self {
            jsonrpc: "2.0".to_owned(),
            id,
            result: None,
            error: Some(RpcError { code, message: message.into(), data: None }),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn shared_response_contract() {
        let cases: serde_json::Value =
            serde_json::from_str(include_str!("protocol-responses.json")).expect("contract JSON");
        for case in cases.as_array().expect("cases") {
            let parsed = serde_json::from_value::<Response>(case["response"].clone());
            assert_eq!(parsed.is_ok(), case["valid"].as_bool().expect("valid flag"), "{}: {parsed:?}", case["name"]);
            if let Ok(response) = parsed {
                assert_eq!(serde_json::to_value(response).expect("serialize"), case["response"], "{}", case["name"]);
            }
        }
    }

    #[test]
    fn test_deserialize_request_with_params() {
        let raw = r#"{"jsonrpc":"2.0","id":1,"method":"ping","params":null}"#;
        let req: Request = serde_json::from_str(raw).expect("deserialize");
        assert_eq!(req.jsonrpc, "2.0");
        assert_eq!(req.id, 1);
        assert_eq!(req.method, "ping");
        assert!(req.params.is_none(), "null params should normalize to None");
    }

    #[test]
    fn test_deserialize_request_without_params() {
        let raw = r#"{"jsonrpc":"2.0","id":2,"method":"snapshot"}"#;
        let req: Request = serde_json::from_str(raw).expect("deserialize");
        assert_eq!(req.method, "snapshot");
        assert!(req.params.is_none());
    }

    #[test]
    fn test_serialize_success_response() {
        let resp = Response::success(1, json!({"status": "ok"}));
        let v: serde_json::Value = serde_json::to_value(&resp).expect("serialize");
        assert_eq!(v["result"]["status"], "ok");
        assert!(v.get("error").is_none());
    }

    #[test]
    fn test_serialize_error_response() {
        let resp = Response::error(serde_json::Value::Number(1.into()), -32601, "Method not found");
        let s = serde_json::to_string(&resp).expect("serialize");
        assert!(s.contains(r#""error""#));
        assert!(!s.contains(r#""result""#));
        assert!(s.contains("-32601"));
    }

    #[test]
    fn test_roundtrip_request() {
        let req = Request {
            jsonrpc: "2.0".to_owned(),
            id: 42,
            method: "click".to_owned(),
            params: Some(json!({"ref": "e1"})),
        };
        let serialized = serde_json::to_string(&req).expect("serialize");
        let deserialized: Request = serde_json::from_str(&serialized).expect("deserialize");
        assert_eq!(deserialized.id, 42);
        assert_eq!(deserialized.method, "click");
    }

    #[test]
    fn test_roundtrip_response() {
        let resp = Response::success(7, json!([1, 2, 3]));
        let serialized = serde_json::to_string(&resp).expect("serialize");
        let deserialized: Response = serde_json::from_str(&serialized).expect("deserialize");
        assert_eq!(deserialized.id, serde_json::json!(7));
        assert_eq!(deserialized.result, Some(json!([1, 2, 3])));
        assert!(deserialized.error.is_none());
    }
}
