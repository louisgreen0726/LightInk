const MAX_SESSION_ID_LEN: usize = 64;

pub fn validate_session_id(value: &str) -> Result<&str, String> {
    if value.is_empty() || value.len() > MAX_SESSION_ID_LEN {
        return Err(format!(
            "invalid session identifier length (expected 1-{MAX_SESSION_ID_LEN} ASCII characters)"
        ));
    }
    if !value
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err("invalid session identifier characters".to_string());
    }
    Ok(value)
}

pub fn validate_content_hash(value: &str) -> Result<&str, String> {
    if value.len() != 16
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err("invalid content hash (expected 16 lowercase hexadecimal characters)".into());
    }
    Ok(value)
}

pub fn validate_version_id(value: &str) -> Result<&str, String> {
    if value.is_empty() || value.len() > 20 || !value.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err("invalid version identifier (expected 1-20 digits)".into());
    }
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_identifier_boundaries() {
        assert!(validate_session_id("a").is_ok());
        assert!(validate_session_id(&"a".repeat(MAX_SESSION_ID_LEN)).is_ok());
        assert!(validate_content_hash("0123456789abcdef").is_ok());
        assert!(validate_version_id("0").is_ok());
        assert!(validate_version_id("12345678901234567890").is_ok());
    }

    #[test]
    fn rejects_invalid_identifiers_without_rewriting() {
        for value in ["", "../session", "a/b", "with space", "会话"] {
            assert!(validate_session_id(value).is_err(), "accepted {value:?}");
        }
        assert!(validate_session_id(&"a".repeat(MAX_SESSION_ID_LEN + 1)).is_err());
        for value in [
            "0123456789abcde",
            "0123456789abcdef0",
            "0123456789ABCDEf",
            "../../annotation",
        ] {
            assert!(validate_content_hash(value).is_err(), "accepted {value:?}");
        }
        for value in ["", "-1", "1.0", "../1", "123456789012345678901"] {
            assert!(validate_version_id(value).is_err(), "accepted {value:?}");
        }
    }
}
