// @Author Christian Relf
// @Date 2026-10-23

//! "*Claude Desktop* wants to move 3 tasks to Trash" — asking before an
//! assistant changes anything.
//!
//! An assistant writes while the user is somewhere else, which is the point
//! of it and also the reason this exists. `mcp.confirmWrites` decides how
//! often they are asked: never, only for the calls that take something away,
//! or every time.
//!
//! The question goes out as an event, the window is brought forward, and the
//! tool call waits on a channel until the dialog answers — or until the
//! timeout, which counts as *no*. Silence can't mean yes: nobody is at the
//! keyboard, and that is exactly when a write shouldn't go through.
//!
//! The wait happens **before** the database lock is taken. Holding the
//! connection while a dialog sits open would stall every other query in the
//! app behind it.

use crate::error::{AppError, AppResult};
use crate::state::AppState;
use crate::util::new_id;
use rusqlite::Connection;
use serde_json::json;
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::oneshot;

use crate::domain::settings;

/// How long a question waits for an answer. Long enough to walk back to the
/// computer, short enough that an assistant isn't left hanging.
const TIMEOUT: Duration = Duration::from_secs(120);

/// What `mcp.confirmWrites` is set to. The default must match `DEFAULTS` in
/// the settings schema.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    Never,
    /// Only calls that take something away: deletes, and replacing what is
    /// already on a whiteboard.
    Destructive,
    Always,
}

/// How much of a change one call is. Decided where the arguments are known,
/// because "replace this whiteboard" and "add to it" are the same tool.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Risk {
    Normal,
    Destructive,
}

pub fn mode(conn: &Connection) -> Mode {
    match settings::get_or(conn, "mcp.confirmWrites", "destructive".to_string()).as_str() {
        "always" => Mode::Always,
        "never" => Mode::Never,
        _ => Mode::Destructive,
    }
}

/// Does a call of this risk need asking about under this mode?
pub fn needed(mode: Mode, risk: Risk) -> bool {
    match mode {
        Mode::Never => false,
        Mode::Destructive => risk == Risk::Destructive,
        Mode::Always => true,
    }
}

/// The questions waiting for an answer, by id. Lives in `McpState`, so a
/// reply from the window can find the call that is waiting for it.
#[derive(Default)]
pub struct Asks(Mutex<HashMap<String, oneshot::Sender<bool>>>);

impl Asks {
    fn put(&self, id: String, tx: oneshot::Sender<bool>) {
        if let Ok(mut map) = self.0.lock() {
            map.insert(id, tx);
        }
    }

    fn take(&self, id: &str) -> Option<oneshot::Sender<bool>> {
        self.0.lock().ok().and_then(|mut map| map.remove(id))
    }
}

/// Asks, and waits. `Ok(())` means the user said yes.
pub async fn ask(app: &AppHandle, client: &str, tool: &str, detail: &str, risk: Risk) -> AppResult<()> {
    let id = new_id();
    let (tx, rx) = oneshot::channel();
    app.state::<AppState>().mcp.asks.put(id.clone(), tx);
    // Being asked is a reason to come to the front; a question behind a
    // hidden window would simply time out.
    crate::window::show_main(app);
    let _ = app.emit(
        "kern://mcp-confirm",
        json!({
            "id": id,
            "client": client,
            "tool": tool,
            "detail": detail,
            "destructive": risk == Risk::Destructive,
            "seconds": TIMEOUT.as_secs(),
        }),
    );

    let answer = tokio::time::timeout(TIMEOUT, rx).await;
    // Whatever happened, the question is over: drop it and tell the window,
    // so a dialog nobody answered doesn't stay on screen.
    app.state::<AppState>().mcp.asks.take(&id);
    let _ = app.emit("kern://mcp-confirm-done", json!({ "id": id }));
    match answer {
        Ok(Ok(true)) => Ok(()),
        // The messages below are read by the model, so they say who decided
        // and what it could do next.
        Ok(_) => Err(AppError::Invalid(
            "The person at this computer turned that change down in Kern. Ask them what they'd like instead.".into(),
        )),
        Err(_) => Err(AppError::Invalid(
            "Kern asked the person at this computer to approve that change and nobody answered, so nothing was written. Try again when they're back.".into(),
        )),
    }
}

/// The window's answer. Unknown ids are ignored: the question may have timed
/// out while the dialog was still open.
pub fn answer(app: &AppHandle, id: &str, allow: bool) {
    if let Some(tx) = app.state::<AppState>().mcp.asks.take(id) {
        let _ = tx.send(allow);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::open_memory;
    use serde_json::json as j;

    #[test]
    fn the_mode_decides_which_calls_are_asked_about() {
        assert!(!needed(Mode::Never, Risk::Destructive));
        assert!(needed(Mode::Destructive, Risk::Destructive));
        assert!(!needed(Mode::Destructive, Risk::Normal));
        assert!(needed(Mode::Always, Risk::Normal));
    }

    #[test]
    fn the_setting_reads_as_destructive_unless_told_otherwise() {
        let c = open_memory();
        assert_eq!(mode(&c), Mode::Destructive, "the default, with nothing written");
        settings::set(&c, "mcp.confirmWrites", &j!("always")).unwrap();
        assert_eq!(mode(&c), Mode::Always);
        settings::set(&c, "mcp.confirmWrites", &j!("never")).unwrap();
        assert_eq!(mode(&c), Mode::Never);
        // Anything else is read as the middle setting rather than as "never".
        settings::set(&c, "mcp.confirmWrites", &j!("whenever")).unwrap();
        assert_eq!(mode(&c), Mode::Destructive);
    }

    #[test]
    fn an_answer_reaches_the_call_waiting_for_it() {
        let asks = Asks::default();
        let (tx, rx) = oneshot::channel();
        asks.put("a1".into(), tx);
        // A reply to a question that is no longer waiting is simply dropped.
        assert!(asks.take("other").is_none());
        asks.take("a1").unwrap().send(true).unwrap();
        assert_eq!(rx.blocking_recv().unwrap(), true);
    }
}
