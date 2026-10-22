// @Author Christian Relf
// @Date 2026-10-12

use crate::error::{AppError, AppResult};
use rusqlite::Connection;
use std::path::PathBuf;
use std::sync::atomic::AtomicU64;
use std::sync::Mutex;

#[derive(Clone, Debug)]
pub struct Paths {
    pub data_dir: PathBuf,
    pub db_path: PathBuf,
    pub attachments_dir: PathBuf,
    pub default_backups_dir: PathBuf,
}

impl Paths {
    pub fn new(data_dir: PathBuf) -> Self {
        Self {
            db_path: data_dir.join("kern.db"),
            attachments_dir: data_dir.join("attachments"),
            default_backups_dir: data_dir.join("backups"),
            data_dir,
        }
    }

    /// Disposable data (favicons, previews). Safe to clear at any time.
    pub fn cache_dir(&self) -> PathBuf {
        self.data_dir.join("cache")
    }

    pub fn favicons_dir(&self) -> PathBuf {
        self.cache_dir().join("favicons")
    }

    pub fn tmp_dir(&self) -> PathBuf {
        self.data_dir.join("tmp")
    }

    pub fn logs_dir(&self) -> PathBuf {
        self.data_dir.join("logs")
    }

    /// Local replicas of Kern Cloud spaces, one folder per account.
    pub fn cloud_dir(&self) -> PathBuf {
        self.data_dir.join("cloud")
    }
}

pub struct AppState {
    db: Mutex<Connection>,
    pub paths: Paths,
    /// Generation counter used to cancel scheduled focus-timer notifications.
    pub focus_generation: AtomicU64,
    /// Set once the window has been hidden to the tray so it can be restored.
    pub quitting: std::sync::atomic::AtomicBool,
    /// Storage scan progress/cancellation and its directory memo.
    pub storage: crate::domain::storage::ScanControl,
    /// AI credential vault, transport and in-flight request cancellation.
    pub ai: crate::domain::ai::router::AiService,
    /// Integrated terminal processes.
    pub pty: crate::domain::pty::PtyManager,
    /// Kern Cloud: the active space, sync signals and status.
    pub cloud: crate::domain::cloud::CloudState,
    /// The assistant (MCP) listener, while it is running.
    pub mcp: crate::domain::mcp::McpState,
}

impl AppState {
    pub fn new(conn: Connection, paths: Paths) -> Self {
        Self {
            db: Mutex::new(conn),
            paths,
            focus_generation: AtomicU64::new(0),
            quitting: std::sync::atomic::AtomicBool::new(false),
            storage: Default::default(),
            ai: crate::domain::ai::default_service(),
            pty: Default::default(),
            cloud: Default::default(),
            mcp: Default::default(),
        }
    }

    /// Replaces the open database (switching between offline data and a
    /// cloud space replica). Waits for any in-flight work on the old one.
    pub fn swap_connection(&self, conn: Connection) -> AppResult<Connection> {
        let mut guard = self
            .db
            .lock()
            .map_err(|_| AppError::Other("Database lock was poisoned; restart the app.".into()))?;
        Ok(std::mem::replace(&mut *guard, conn))
    }

    /// Runs `f` with exclusive access to the database connection.
    pub fn with<T>(&self, f: impl FnOnce(&mut Connection) -> AppResult<T>) -> AppResult<T> {
        let mut guard = self
            .db
            .lock()
            .map_err(|_| AppError::Other("Database lock was poisoned; restart the app.".into()))?;
        f(&mut guard)
    }
}
