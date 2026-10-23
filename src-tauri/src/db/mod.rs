// @Author Christian Relf
// @Date 2026-10-12

//! Database bootstrap: connection configuration, migrations and the
//! pre-migration safety copy.

pub mod migrations;

use crate::error::{AppError, AppResult};
use rusqlite::Connection;
use std::path::Path;

pub const SCHEMA_VERSION: i64 = migrations::MIGRATIONS.len() as i64;

/// Applies connection-level pragmas. WAL gives crash-safe, concurrent-read
/// friendly writes; foreign keys keep relationships consistent.
pub fn configure(conn: &Connection) -> AppResult<()> {
    conn.execute_batch(
        "PRAGMA journal_mode = WAL;
         PRAGMA synchronous = NORMAL;
         PRAGMA foreign_keys = ON;
         PRAGMA busy_timeout = 5000;
         PRAGMA temp_store = MEMORY;
         PRAGMA cache_size = -16000;",
    )?;
    Ok(())
}

pub fn user_version(conn: &Connection) -> AppResult<i64> {
    Ok(conn.query_row("PRAGMA user_version", [], |r| r.get(0))?)
}

/// Opens (creating if necessary) the database at `path` and brings the
/// schema up to date. If an existing database needs migrating, a full copy
/// is written to `safety_dir` first so a failed upgrade can be recovered.
pub fn open(path: &Path, safety_dir: &Path) -> AppResult<Connection> {
    let conn = Connection::open(path)?;
    configure(&conn)?;
    upgrade(&conn, safety_dir)?;
    Ok(conn)
}

/// Tables that belong to this computer rather than to a space: settings,
/// AI accounts and usage, folder trust, caches, notification history and the
/// linked-file index. A cloud space replica parks its own copies under a
/// prefix, so unqualified names resolve to the attached device database.
pub const DEVICE_TABLES: &[&str] = &[
    "settings",
    "ai_accounts",
    "ai_usage_events",
    "ai_failover_events",
    "favicon_cache",
    "link_metadata",
    "storage_scan_cache",
    "trusted_workspaces",
    "notification_log",
    "file_index_roots",
    "file_index",
    "file_fts",
    "calendar_feeds",
    "calendar_events",
    // Credentials are bound to this computer's authenticator.
    "passkeys",
    // An assistant approved here is approved on this computer only.
    "mcp_clients",
    "mcp_audit",
    // And a server Kern can call is a program installed on this computer.
    "mcp_servers",
    "mcp_tool_calls",
];
const PARKED: &str = "_device_";

fn table_exists(conn: &Connection, name: &str) -> AppResult<bool> {
    Ok(conn.query_row("SELECT EXISTS (SELECT 1 FROM main.sqlite_master WHERE type = 'table' AND name = ?1)", [name], |r| r.get(0))?)
}

/// Parks (or restores) the device tables of a space replica. Migrations run
/// with the normal names so every schema step applies unchanged.
fn park_device_tables(conn: &Connection, park: bool) -> AppResult<()> {
    for t in DEVICE_TABLES {
        let parked = format!("{PARKED}{t}");
        let (from, to) = if park { (t.to_string(), parked) } else { (parked, t.to_string()) };
        if table_exists(conn, &from)? && !table_exists(conn, &to)? {
            conn.execute_batch(&format!("ALTER TABLE main.\"{from}\" RENAME TO \"{to}\""))?;
        }
    }
    Ok(())
}

/// Opens (creating if necessary) a cloud space replica at `path`: the same
/// schema as the offline database plus sync bookkeeping, with the device
/// database attached as `local` for settings and other per-computer data.
pub fn open_space(path: &Path, safety_dir: &Path, device_db: &Path) -> AppResult<Connection> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let conn = Connection::open(path)?;
    configure(&conn)?;
    park_device_tables(&conn, false)?;
    upgrade(&conn, safety_dir)?;
    park_device_tables(&conn, true)?;
    crate::domain::cloud::sync::install(&conn)?;
    conn.execute("ATTACH DATABASE ?1 AS local", [device_db.to_string_lossy().to_string()])?;
    Ok(conn)
}

/// Checks the schema version, takes a safety copy and migrates.
fn upgrade(conn: &Connection, safety_dir: &Path) -> AppResult<()> {
    let version = user_version(conn)?;
    if version > SCHEMA_VERSION {
        return Err(AppError::Invalid(format!(
            "This data was created by a newer version of the app (schema {version}, supported {SCHEMA_VERSION}). Update the app to open it."
        )));
    }
    if version > 0 && version < SCHEMA_VERSION {
        std::fs::create_dir_all(safety_dir)?;
        let target = safety_dir.join(format!(
            "pre-migration-v{version}-{}.db",
            chrono::Local::now().format("%Y%m%d-%H%M%S")
        ));
        conn.execute("VACUUM INTO ?1", [target.to_string_lossy().to_string()])?;
    }
    migrate(conn)?;
    Ok(())
}

/// Runs all pending migrations, each atomically.
pub fn migrate(conn: &Connection) -> AppResult<()> {
    let current = user_version(conn)?;
    for (idx, sql) in migrations::MIGRATIONS.iter().enumerate() {
        let version = idx as i64 + 1;
        if version <= current {
            continue;
        }
        let tx = conn.unchecked_transaction()?;
        tx.execute_batch(sql)?;
        tx.execute_batch(&format!("PRAGMA user_version = {version}"))?;
        tx.commit()?;
    }
    Ok(())
}

/// Opens an in-memory database with the full schema (tests).
#[cfg(test)]
pub fn open_memory() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch("PRAGMA foreign_keys = ON;").unwrap();
    migrate(&conn).unwrap();
    conn
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn v1_data_survives_upgrade() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("kern.db");
        {
            // A database as the first release left it.
            let conn = Connection::open(&path).unwrap();
            configure(&conn).unwrap();
            let tx = conn.unchecked_transaction().unwrap();
            tx.execute_batch(migrations::MIGRATIONS[0]).unwrap();
            tx.execute_batch("PRAGMA user_version = 1").unwrap();
            tx.commit().unwrap();
            conn.execute_batch(
                "INSERT INTO projects(id, name, created_at, updated_at) VALUES ('p1', 'Studbase', 1, 1);
                 INSERT INTO tasks(id, title, project_id, created_at, updated_at) VALUES ('t1', 'Keep me', 'p1', 1, 1);
                 INSERT INTO settings(key, value, updated_at) VALUES ('data.linkPreviews', 'false', 1);",
            )
            .unwrap();
        }
        let safety = dir.path().join("backups");
        let conn = open(&path, &safety).unwrap();
        assert_eq!(user_version(&conn).unwrap(), SCHEMA_VERSION);
        let (title, project): (String, String) =
            conn.query_row("SELECT title, project_id FROM tasks WHERE id = 't1'", [], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
        assert_eq!((title.as_str(), project.as_str()), ("Keep me", "p1"));
        let prefs: String = conn.query_row("SELECT ai_prefs FROM projects WHERE id = 'p1'", [], |r| r.get(0)).unwrap();
        assert_eq!(prefs, "{}");
        let fav: String = conn.query_row("SELECT value FROM settings WHERE key = 'privacy.favicons'", [], |r| r.get(0)).unwrap();
        assert_eq!(fav, "false", "an existing opt-out carries over to favicons");
        // A safety copy was written before migrating.
        assert_eq!(std::fs::read_dir(&safety).unwrap().count(), 1);
    }

    #[test]
    fn space_replicas_share_device_tables_and_import_offline_data() {
        let dir = tempfile::tempdir().unwrap();
        let device = dir.path().join("kern.db");
        {
            let conn = open(&device, &dir.path().join("backups")).unwrap();
            conn.execute_batch(
                "INSERT INTO settings(key, value, updated_at) VALUES ('appearance.theme', '\"dark\"', 1);
                 INSERT INTO projects(id, name, created_at, updated_at) VALUES ('p1', 'Offline project', 1, 1);
                 INSERT INTO tasks(id, title, project_id, created_at, updated_at) VALUES ('t1', 'Offline task', 'p1', 1, 1);
                 INSERT INTO project_folder_links(project_id, path, folder_key, linked_at) VALUES ('p1', 'C:/code/site', 'c:/code/site', 1);",
            )
            .unwrap();
        }
        let replica = dir.path().join("cloud").join("u1").join("s1.db");
        let mut conn = open_space(&replica, &dir.path().join("cloud-backups"), &device).unwrap();
        // Settings come from the device database; space data starts empty.
        let theme: String = crate::domain::settings::get(&conn, "appearance.theme").unwrap();
        assert_eq!(theme, "dark");
        crate::domain::settings::set(&conn, "general.landing", &serde_json::json!("tasks")).unwrap();
        let n: i64 = conn.query_row("SELECT count(*) FROM projects", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 0);
        // Offline data copies in (with the device-only folder link) and is queued to sync.
        let counts = crate::domain::cloud::sync::import_offline(&mut conn, None).unwrap();
        assert_eq!((counts["projects"], counts["tasks"], counts["project_folder_links"]), (1, 1, 1));
        assert!(crate::domain::cloud::sync::pending_count(&conn) >= 2);
        let title: String = conn.query_row("SELECT title FROM main.tasks WHERE id = 't1'", [], |r| r.get(0)).unwrap();
        assert_eq!(title, "Offline task");
        drop(conn);
        // The setting written while in the space landed in the device database.
        let device_conn = open(&device, &dir.path().join("backups")).unwrap();
        let landing: String = crate::domain::settings::get(&device_conn, "general.landing").unwrap();
        assert_eq!(landing, "tasks");
        // Reopening a replica (e.g. after an app update) keeps its data and parking.
        let conn = open_space(&replica, &dir.path().join("cloud-backups"), &device).unwrap();
        let n: i64 = conn.query_row("SELECT count(*) FROM main.projects", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 1);
        let parked: i64 = conn.query_row("SELECT count(*) FROM main.sqlite_master WHERE name = 'settings'", [], |r| r.get(0)).unwrap();
        assert_eq!(parked, 0);
    }

    #[test]
    fn v3_projects_gain_phase_three_without_changes() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("kern.db");
        {
            let conn = Connection::open(&path).unwrap();
            configure(&conn).unwrap();
            for (i, sql) in migrations::MIGRATIONS[..3].iter().enumerate() {
                let tx = conn.unchecked_transaction().unwrap();
                tx.execute_batch(sql).unwrap();
                tx.execute_batch(&format!("PRAGMA user_version = {}", i + 1)).unwrap();
                tx.commit().unwrap();
            }
            conn.execute_batch(
                "INSERT INTO projects(id, name, created_at, updated_at) VALUES ('p1', 'Reactor', 1, 1);
                 INSERT INTO tasks(id, title, project_id, status, created_at, updated_at) VALUES ('t1', 'Cooling', 'p1', 'todo', 1, 1);
                 INSERT INTO project_repos(project_id, owner, name, connected_at) VALUES ('p1', 'acme', 'reactor', 1);
                 INSERT INTO task_issue_links(repo, issue_number, task_id, project_id, html_url, synced_at) VALUES ('acme/reactor', 7, 't1', 'p1', 'u', 1);",
            )
            .unwrap();
        }
        let conn = open(&path, &dir.path().join("backups")).unwrap();
        assert_eq!(user_version(&conn).unwrap(), SCHEMA_VERSION);
        let t = crate::domain::tasks::get_task(&conn, "t1").unwrap();
        assert_eq!((t.title.as_str(), t.milestone_id, t.issue.map(|i| i.number)), ("Cooling", None, Some(7)));
        // The existing GitHub connection shows up as a repository link, unchanged.
        let repos = crate::domain::repos::list(&conn, "p1").unwrap();
        assert_eq!(repos.len(), 1);
        assert_eq!(repos[0].github.as_deref(), Some("acme/reactor"));
        assert!(repos[0].issue_sync);
        let p = crate::domain::projects::get_project(&conn, "p1").unwrap();
        assert_eq!(p.github_repo.as_deref(), Some("acme/reactor"));
    }
}
