// @Author Christian Relf
// @Date 2026-10-12

//! A single low-frequency background thread for time-based features:
//! morning briefing / evening review prompts, due-date and overdue
//! reminders, automatic backups and housekeeping. No busy loops; the tick
//! interval is 20s (60s with "reduce background activity").

use crate::domain::{activity, ai, archive, attachments, mcp, notify, settings, trash};
use crate::state::AppState;
use crate::util::now_ms;
use chrono::{Datelike, Local, NaiveTime, Timelike};
use rusqlite::params;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

pub fn start(app: AppHandle) {
    std::thread::Builder::new()
        .name("kern-scheduler".into())
        .spawn(move || {
            let started = Instant::now();
            // Let startup finish before doing any background work.
            std::thread::sleep(Duration::from_secs(6));
            let mut last_maintenance: Option<Instant> = None;
            let mut first = true;
            loop {
                let launched_recently = started.elapsed() < Duration::from_secs(90);
                tick(&app, launched_recently);
                if last_maintenance.map(|t| t.elapsed() > Duration::from_secs(3600)).unwrap_or(true) {
                    maintenance(&app, first);
                    last_maintenance = Some(Instant::now());
                    first = false;
                }
                crate::window::save_window_state(&app);
                let reduce = app
                    .state::<AppState>()
                    .with(|c| Ok(settings::get_or(c, "performance.reduceBackground", false)))
                    .unwrap_or(false);
                std::thread::sleep(Duration::from_secs(if reduce { 60 } else { 20 }));
            }
        })
        .expect("failed to start scheduler thread");
}

fn parse_time(s: &str, fallback: &str) -> NaiveTime {
    NaiveTime::parse_from_str(s, "%H:%M").unwrap_or_else(|_| NaiveTime::parse_from_str(fallback, "%H:%M").unwrap())
}

fn plural(n: i64, one: &str, many: &str) -> String {
    format!("{n} {}", if n == 1 { one } else { many })
}

fn tick(app: &AppHandle, launched_recently: bool) {
    let state = app.state::<AppState>();
    let now = Local::now();
    let today = now.format("%Y-%m-%d").to_string();
    let time = now.time();

    let mut events: Vec<(&'static str, String)> = vec![];
    let mut notes: Vec<(String, String)> = vec![];

    let _ = state.with(|c| {
        // With notification details off, every line below is replaced by a
        // neutral one: counts and task titles stay inside Kern.
        let detail = notify::details_allowed(c);

        // Morning briefing.
        let enabled: bool = settings::get_or(c, "rundown.enabled", true);
        let at = parse_time(&settings::get_or(c, "rundown.time", "09:00".to_string()), "09:00");
        if enabled && time >= at && notify::first_time(c, &format!("briefing:{today}")) {
            events.push(("kern://briefing-due", today.clone()));
            // On launch the in-app prompt is enough; don't add a toast.
            if !launched_recently && notify::category_enabled(c, "rundown.notify") {
                let (due, overdue): (i64, i64) = c.query_row(
                    "SELECT sum(due_date = ?1), sum(due_date < ?1) FROM tasks
                     WHERE deleted_at IS NULL AND archived_at IS NULL AND status != 'completed' AND due_date IS NOT NULL",
                    [&today],
                    |r| Ok((r.get::<_, Option<i64>>(0)?.unwrap_or(0), r.get::<_, Option<i64>>(1)?.unwrap_or(0))),
                )?;
                let mut body = format!("{} due today", plural(due, "task", "tasks"));
                if overdue > 0 {
                    body.push_str(&format!(" · {overdue} overdue"));
                }
                notes.push(("Your daily rundown is ready".into(), if detail { body } else { "Open Kern to see it.".into() }));
            }
        }

        // Evening review (optional).
        let evening: bool = settings::get_or(c, "rundown.eveningEnabled", false);
        let eat = parse_time(&settings::get_or(c, "rundown.eveningTime", "18:00".to_string()), "18:00");
        if evening && time >= eat && notify::first_time(c, &format!("evening:{today}")) {
            events.push(("kern://evening-due", today.clone()));
            if !launched_recently && notify::category_enabled(c, "rundown.eveningNotify") {
                notes.push(("Evening review".into(), "Review today and plan tomorrow.".into()));
            }
        }

        // Weekly review (once a week, on the chosen day and time).
        let review_on: bool = settings::get_or(c, "review.enabled", true);
        let review_day: u32 = settings::get_or(c, "review.day", 5);
        let rat = parse_time(&settings::get_or(c, "review.time", "16:00".to_string()), "16:00");
        if review_on && now.weekday().num_days_from_sunday() == review_day % 7 && time >= rat {
            let week = now.format("%G-W%V").to_string();
            if notify::first_time(c, &format!("review:{week}")) {
                events.push(("kern://review-due", today.clone()));
                if !launched_recently && notify::category_enabled(c, "review.notify") {
                    notes.push(("Weekly review".into(), "Look back on the week and plan the next one.".into()));
                }
            }
        }

        // Due-time reminders.
        if notify::category_enabled(c, "notifications.dueReminders") {
            let lead: i64 = settings::get_or(c, "notifications.dueLeadMinutes", 15);
            let mut stmt = c.prepare(
                "SELECT id, title, due_time, reminder_minutes FROM tasks
                 WHERE deleted_at IS NULL AND archived_at IS NULL AND status != 'completed' AND due_date = ?1 AND due_time IS NOT NULL",
            )?;
            let rows: Vec<(String, String, String, Option<i64>)> = stmt
                .query_map([&today], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?
                .collect::<Result<_, _>>()?;
            let minutes_now = (time.hour() * 60 + time.minute()) as i64;
            for (id, title, due_time, custom) in rows {
                let Ok(t) = NaiveTime::parse_from_str(&due_time, "%H:%M") else { continue };
                let due_min = (t.hour() * 60 + t.minute()) as i64;
                let lead = custom.unwrap_or(lead).max(0);
                // Fire inside [due - lead, due + 60min]; a reminder is never
                // sent for something that ended long ago.
                if minutes_now >= due_min - lead
                    && minutes_now <= due_min + 60
                    && notify::first_time(c, &format!("due:{id}:{today}:{due_time}"))
                {
                    let when = if minutes_now >= due_min { format!("Due now ({due_time})") } else { format!("Due at {due_time}") };
                    notes.push(if detail { (title, when) } else { ("A task is due".into(), "Open Kern to see which one.".into()) });
                }
            }
        }

        // Once-a-day overdue reminder.
        let overdue_at = parse_time(&settings::get_or(c, "notifications.overdueTime", "13:00".to_string()), "13:00");
        if time >= overdue_at && notify::category_enabled(c, "notifications.overdue") {
            let n: i64 = c.query_row(
                "SELECT count(*) FROM tasks WHERE deleted_at IS NULL AND archived_at IS NULL AND status != 'completed' AND due_date < ?1",
                [&today],
                |r| r.get(0),
            )?;
            if n > 0 && notify::first_time(c, &format!("overdue:{today}")) {
                notes.push((
                    "Overdue tasks".into(),
                    if detail { format!("{} past due", plural(n, "task is", "tasks are")) } else { "Open Kern to see them.".into() },
                ));
            }
        }
        Ok(())
    });

    for (event, payload) in events {
        let _ = app.emit(event, payload);
    }
    for (title, body) in notes {
        notify::send(app, &title, &body);
    }
    // Today's tasks in the tray menu (rebuilt only when they change).
    crate::window::refresh_tray(app);
}

fn maintenance(app: &AppHandle, at_startup: bool) {
    let state = app.state::<AppState>();
    let paths = state.paths.clone();
    let version = app.package_info().version.to_string();
    let mut changed = false;
    // Automatic backups protect the offline data; cloud spaces live on the server.
    let cloud = state.cloud.is_active();
    // Other spaces' whiteboards may use attachment files this database
    // doesn't reference, so orphan cleanup only runs without cloud copies.
    let replicas = crate::domain::cloud::has_replicas(&state);
    let _ = state.with(|c| {
        if !cloud {
            if let Err(e) = archive::auto_backup_if_due(c, &paths, &version) {
                eprintln!("automatic backup failed: {e}");
                let _ = app.emit("kern://backup-failed", e.to_string());
            }
        }
        let days: i64 = settings::get_or(c, "tasks.autoArchiveDays", 0);
        if days > 0 {
            let n = c.execute(
                "UPDATE tasks SET archived_at = ?1 WHERE status = 'completed' AND archived_at IS NULL AND deleted_at IS NULL
                   AND completed_at < ?2",
                params![now_ms(), now_ms() - days * 86_400_000],
            )?;
            changed |= n > 0;
        }
        activity::prune(c, settings::get_or(c, "data.activityRetentionDays", 180))?;
        ai::prune(c, settings::get_or(c, "ai.usageRetentionDays", 90))?;
        let assistant_days = settings::get_or(c, "mcp.auditDays", 30);
        mcp::audit::prune(c, assistant_days)?;
        // Both directions, kept for the same length of time: what an
        // assistant did to Kern, and what Kern ran elsewhere.
        mcp::outbound::prune(c, assistant_days)?;
        let purged = trash::purge_older_than(c, settings::get_or(c, "data.trashRetentionDays", 30))?;
        changed |= purged > 0;
        notify::prune_log(c);
        // Credential-store entries of deleted environment variables.
        let _ = crate::domain::envvars::sweep(c, state.ai.vault.as_ref());
        c.execute("DELETE FROM service_checks WHERE checked_at < ?1", [now_ms() - 30 * 86_400_000])?;
        if at_startup && !replicas {
            let _ = attachments::cleanup_orphan_assets(c, &paths.attachments_dir);
            // Clean leftovers from interrupted exports/restores.
            let _ = std::fs::remove_dir_all(paths.data_dir.join("tmp"));
        }
        Ok(())
    });
    if changed {
        let _ = app.emit("kern://data-changed", ());
    }
    // Calendar subscriptions (network, outside the database lock) and the
    // always-current export file.
    if crate::domain::calendar::refresh_due(app) {
        let _ = app.emit("kern://calendar-updated", ());
    }
    crate::domain::calendar::write_auto_export(app);
}
