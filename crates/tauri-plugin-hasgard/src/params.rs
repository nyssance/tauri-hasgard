//! Typed reads of request parameters.

use crate::protocol::{RPC_INVALID_PARAMS, RpcError};

/// An optional whole-number parameter. One of the wrong type is an error, not an absence:
/// a caller who sent `"timeout": "5000"` should not get the default instead.
pub(crate) fn optional_u64(params: &serde_json::Value, name: &str, method: &str) -> Result<Option<u64>, RpcError> {
    match params.get(name) {
        None | Some(serde_json::Value::Null) => Ok(None),
        Some(value) => value.as_u64().map(Some).ok_or_else(|| RpcError {
            code: RPC_INVALID_PARAMS,
            message: format!("{method}: '{name}' must be a non-negative integer"),
            data: None,
        }),
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn an_optional_integer_of_the_wrong_type_is_rejected_rather_than_defaulted() {
        let params = json!({"timeout": "5000", "sinceId": 3, "absent": null});
        assert_eq!(optional_u64(&params, "sinceId", "m").expect("an integer"), Some(3));
        assert_eq!(optional_u64(&params, "absent", "m").expect("null is absent"), None);
        assert_eq!(optional_u64(&params, "missing", "m").expect("missing is absent"), None);
        let error = optional_u64(&params, "timeout", "m").expect_err("a string is not an integer");
        assert_eq!(error.code, RPC_INVALID_PARAMS);
        assert!(error.message.contains("'timeout'"));
        assert!(optional_u64(&json!({"timeout": -1}), "timeout", "m").is_err());
    }
}
