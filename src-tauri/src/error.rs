// @Author Christian Relf
// @Date 2026-10-12

//! Structured application errors. Raw database / IO errors are mapped to a
//! stable `code` plus a human-readable message so the UI can present
//! actionable feedback instead of leaking internals.

use serde::{Serialize, Serializer};

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("database error: {0}")]
    Db(#[from] rusqlite::Error),
    #[error("file error: {0}")]
    Io(#[from] std::io::Error),
    #[error("data format error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("archive error: {0}")]
    Zip(#[from] zip::result::ZipError),
    #[error("{0} not found")]
    NotFound(String),
    #[error("{0}")]
    Invalid(String),
    #[error("{0}")]
    Network(String),
    /// Kern Cloud rejected the session: sign in again.
    #[error("{0}")]
    Auth(String),
    /// Kern Cloud needs the account's email confirmed first.
    #[error("{0}")]
    Unverified(String),
    /// A project behind a passkey, not opened with one yet this session.
    #[error("{0}")]
    Locked(String),
    /// This server only lets people it has invited create a workspace, and the
    /// key offered was missing, malformed, revoked, or already another
    /// account's. Its own variant so the interface can put the person back in
    /// front of the field instead of showing a toast and nothing to type in.
    #[error("{0}")]
    WorkspaceKey(String),
    #[error("{0}")]
    Other(String),
}

impl AppError {
    pub fn code(&self) -> &'static str {
        match self {
            AppError::Db(rusqlite::Error::SqliteFailure(e, _))
                if e.code == rusqlite::ErrorCode::DatabaseBusy
                    || e.code == rusqlite::ErrorCode::DatabaseLocked =>
            {
                "busy"
            }
            AppError::Db(rusqlite::Error::SqliteFailure(e, _))
                if e.code == rusqlite::ErrorCode::ConstraintViolation =>
            {
                "constraint"
            }
            AppError::Db(rusqlite::Error::QueryReturnedNoRows) => "not_found",
            AppError::Db(_) => "database",
            AppError::Io(_) => "io",
            AppError::Json(_) => "format",
            AppError::Zip(_) => "archive",
            AppError::NotFound(_) => "not_found",
            AppError::Invalid(_) => "invalid",
            AppError::Network(_) => "network",
            AppError::Auth(_) => "auth",
            AppError::Unverified(_) => "unverified",
            AppError::Locked(_) => "locked",
            AppError::WorkspaceKey(_) => "workspace_key",
            AppError::Other(_) => "other",
        }
    }
}

impl Serialize for AppError {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeStruct;
        let mut st = s.serialize_struct("AppError", 2)?;
        st.serialize_field("code", self.code())?;
        st.serialize_field("message", &self.to_string())?;
        st.end()
    }
}

pub type AppResult<T> = Result<T, AppError>;

pub fn invalid<T>(msg: impl Into<String>) -> AppResult<T> {
    Err(AppError::Invalid(msg.into()))
}

pub fn locked<T>(msg: impl Into<String>) -> AppResult<T> {
    Err(AppError::Locked(msg.into()))
}
