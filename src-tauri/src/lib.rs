// @Author Christian Relf
// @Date 2026-10-12

//! Kern - a local-first personal productivity workspace.
//!
//! The backend owns persistence (SQLite), file management, notifications,
//! backups and OS integration. The frontend talks to it exclusively through
//! the typed commands registered below - it never issues SQL.

pub mod db;
pub mod domain;
pub mod error;
pub mod scheduler;
pub mod state;
pub mod util;
pub mod window;

use domain::*;
use state::{AppState, Paths};
use tauri::{Emitter, Manager};
use tauri_plugin_deep_link::DeepLinkExt;
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};

/// The app context, with the updater's install mode chosen for how this copy
/// was installed: the per-user .exe installer runs with no window of its own
/// (Kern's update screen is the only UI); an .msi install is per-machine, so
/// it stays passive, which lets Windows ask for admin approval.
fn context() -> tauri::Context {
    let mut ctx = tauri::generate_context!();
    if matches!(tauri::utils::platform::bundle_type(), Some(tauri::utils::config::BundleType::Nsis)) {
        if let Some(windows) = ctx.config_mut().plugins.0.get_mut("updater").and_then(|u| u.get_mut("windows")).and_then(|w| w.as_object_mut()) {
            windows.insert("installMode".into(), "quiet".into());
        }
    }
    ctx
}

pub fn run() {
    let mut builder = tauri::Builder::default();
    // An isolated test/development instance (KERN_DATA_DIR) runs alongside
    // the normal one instead of handing over to it.
    if std::env::var_os("KERN_DATA_DIR").is_none() {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            window::show_main(app);
            // "Kern Lite" / "Kern" shortcuts while Kern is already running.
            if let Some(mode) = window::mode_from_args(&args) {
                let _ = app.emit("kern://switch-mode", mode);
            }
        }));
    }
    builder
        // After single-instance, so a kern:// link opened while Kern runs
        // reaches the running app.
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        // In-app updates: signed installers from the GitHub release.
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--autostart"]),
        ))
        .setup(|app| {
            // KERN_DATA_DIR points a development or test run at a separate
            // data folder so real data is never touched.
            let data_dir = match std::env::var_os("KERN_DATA_DIR") {
                Some(d) if !d.is_empty() => std::path::PathBuf::from(d),
                _ => app.path().app_data_dir()?,
            };
            let paths = Paths::new(data_dir);
            std::fs::create_dir_all(&paths.data_dir)?;
            std::fs::create_dir_all(&paths.attachments_dir)?;
            // The asset protocol may read managed attachments and cached
            // favicons only, wherever the data folder actually is.
            let scope = app.asset_protocol_scope();
            let _ = scope.allow_directory(&paths.attachments_dir, true);
            let _ = scope.allow_directory(paths.favicons_dir(), true);
            // Whiteboard images shared by collaborators (Kern Cloud).
            let shared_images = paths.cache_dir().join("cloud-assets");
            let _ = std::fs::create_dir_all(&shared_images);
            let _ = scope.allow_directory(&shared_images, true);
            let conn = match db::open(&paths.db_path, &paths.default_backups_dir) {
                Ok(c) => c,
                Err(e) => {
                    app.dialog()
                        .message(format!(
                            "Kern couldn't open its data.\n\n{e}\n\nYour data folder is:\n{}",
                            paths.data_dir.display()
                        ))
                        .kind(MessageDialogKind::Error)
                        .title("Kern")
                        .blocking_show();
                    std::process::exit(1);
                }
            };
            let _ = settings::set(
                &conn,
                "internal.attachmentsDir",
                &serde_json::json!(paths.attachments_dir.to_string_lossy()),
            );
            if let Err(e) = folders::apply_trust_retention(&conn) {
                eprintln!("couldn't apply trust retention: {e}");
            }
            app.manage(AppState::new(conn, paths));
            // Reopen the cloud space that was open last time (works offline too).
            cloud::restore_active(app.handle());
            cloud::start_worker(app.handle().clone());
            // kern://invite/<id> links. Installers register the scheme; this
            // also covers development runs and portable copies.
            let _ = app.deep_link().register_all();
            if let Ok(Some(urls)) = app.deep_link().get_current() {
                for u in urls {
                    app.state::<AppState>().cloud.push_link(u.to_string());
                }
            }
            let handle = app.handle().clone();
            app.deep_link().on_open_url(move |event| {
                for u in event.urls() {
                    handle.state::<AppState>().cloud.push_link(u.to_string());
                }
                window::show_main(&handle);
                let _ = handle.emit("kern://deep-link", ());
            });
            if let Err(e) = window::create_tray(app) {
                eprintln!("tray unavailable: {e}");
            }
            window::restore_and_show(app.handle());
            scheduler::start(app.handle().clone());
            Ok(())
        })
        .on_window_event(window::on_window_event)
        .invoke_handler(tauri::generate_handler![
            // settings
            settings::settings_get_all,
            settings::settings_set,
            settings::settings_reset,
            // tasks
            tasks::tasks_query,
            tasks::task_get,
            tasks::task_create,
            tasks::task_update,
            tasks::tasks_update_many,
            tasks::tasks_patch_batch,
            tasks::task_duplicate,
            tasks::tasks_copy_to_project,
            tasks::tasks_delete,
            tasks::tasks_restore,
            tasks::tasks_purge,
            tasks::tasks_reorder,
            relations::task_relations,
            relations::task_relation_set,
            relations::task_relation_remove,
            // comments
            comments::comments_list,
            comments::comment_add,
            comments::comment_edit,
            comments::comment_delete,
            comments::comment_mentions,
            // labels
            labels::labels_list,
            labels::label_create,
            labels::label_update,
            labels::label_delete,
            // projects
            projects::projects_list,
            projects::project_get,
            projects::project_create,
            projects::project_update,
            projects::projects_reorder,
            projects::projects_arrange,
            projects::projects_reset_order,
            projects::groups_reorder,
            projects::project_duplicate,
            projects::project_delete,
            projects::project_restore,
            projects::project_touch,
            projects::project_capabilities,
            projects::groups_list,
            projects::group_create,
            projects::group_update,
            projects::group_delete,
            // project folders & workspace trust
            folders::folder_inspect,
            folders::project_folder_get,
            folders::project_folder_link,
            folders::project_folder_unlink,
            folders::project_folder_set_trust,
            folders::project_files_list,
            folders::project_file_open,
            folders::project_file_reveal,
            folders::project_file_path,
            folders::project_folder_create,
            folders::project_file_rename,
            folders::project_file_create,
            folders::project_file_duplicate,
            folders::project_file_trash,
            folders::project_file_read,
            folders::project_file_write,
            folders::project_file_image,
            plugins::syntax_installed,
            plugins::syntax_install,
            plugins::syntax_remove,
            plugins::syntax_grammar,
            plugins::project_file_kinds,
            folders::trusted_folders_list,
            folders::trusted_folder_update,
            // passkeys & locked projects
            passkeys::passkeys_list,
            passkeys::passkeys_support,
            passkeys::passkey_register,
            passkeys::passkey_rename,
            passkeys::passkey_remove,
            passkeys::passkeys_reset,
            passkeys::locked_projects_list,
            passkeys::project_set_locked,
            passkeys::project_unlock,
            passkeys::project_relock,
            // AI API accounts & routing
            ai::ai_accounts_list,
            ai::ai_account_create,
            ai::ai_account_update,
            ai::ai_account_replace_key,
            ai::ai_account_delete,
            ai::ai_accounts_reorder,
            ai::ai_account_test,
            ai::ai_key_test,
            ai::ai_request,
            ai::ai_request_cancel,
            ai::ai_usage,
            ai::ai_history_clear,
            ai::ai_security_check,
            // git & GitHub (repository-scoped)
            git::git_remote,
            git::git_status,
            git::git_diff,
            git::git_log,
            git::git_branches,
            git::git_switch,
            git::git_branch_check,
            git::git_create_branch,
            git::git_sync,
            git::git_clone,
            git::git_available,
            git::project_scan_todos,
            // repositories & worktrees
            repos::repos_list,
            repos::repo_link_local,
            repos::repo_link_github,
            repos::repo_unlink,
            repos::repo_update,
            repos::repo_set_trust,
            repos::repo_summary,
            repos::repo_reveal,
            worktrees::worktrees_list,
            worktrees::worktree_default_path,
            worktrees::worktree_create,
            worktrees::worktree_inspect,
            worktrees::worktree_remove,
            worktrees::worktree_update,
            worktrees::worktrees_prune,
            worktrees::open_in_editor,
            // task ↔ development links
            workflow::task_links,
            workflow::task_link_add,
            workflow::task_link_remove,
            workflow::task_dev_context,
            workflow::task_branch_commits,
            workflow::repo_default_base,
            // work sessions
            sessions::session_active,
            sessions::session_start,
            sessions::session_pause,
            sessions::session_resume,
            sessions::session_stop,
            sessions::session_heartbeat,
            sessions::session_discard_gap,
            sessions::session_update,
            sessions::session_delete,
            sessions::sessions_list,
            sessions::sessions_report,
            sessions::session_link_add,
            sessions::session_link_remove,
            // workspace state, snapshots, Command Centre layout
            workspace::workspace_state_get,
            workspace::workspace_state_save,
            workspace::workspace_snapshots_list,
            workspace::workspace_snapshot_save,
            workspace::workspace_snapshot_delete,
            workspace::project_layout_get,
            workspace::project_layout_save,
            workspace::project_layout_reset,
            // milestones & releases
            milestones::milestones_list,
            milestones::milestones_upcoming,
            milestones::milestone_get,
            milestones::milestone_create,
            milestones::milestone_update,
            milestones::milestone_delete,
            milestones::milestones_reorder,
            milestones::milestone_set_deps,
            milestones::release_link_add,
            milestones::release_link_remove,
            milestones::milestone_changelog,
            // development environment, commands, terminal, environment profiles
            devenv::devenv_detect,
            devenv::devenv_cached,
            devenv::commands_list,
            devenv::command_save,
            devenv::command_delete,
            devenv::which_program,
            pty::pty_shells,
            pty::pty_spawn,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
            pty::pty_close,
            pty::pty_list,
            pty::pty_rename,
            envvars::env_profiles_list,
            envvars::env_profile_create,
            envvars::env_profile_rename,
            envvars::env_profile_delete,
            envvars::env_profile_duplicate,
            envvars::env_var_set,
            envvars::env_var_delete,
            envvars::env_var_reveal,
            envvars::env_import,
            envvars::env_export,
            // local services, dependencies, health, catch-up
            services::services_list,
            services::service_save,
            services::service_delete,
            services::service_check,
            services::services_check_project,
            services::docker_containers,
            services::docker_container_action,
            deps::deps_cached,
            deps::deps_scan,
            deps::deps_advisories,
            health::project_health,
            health::project_health_prefs,
            catchup::catchup_local,
            catchup::catchup_preview,
            catchup::catchup_ai,
            // linked-folder search index
            fileindex::files_index,
            fileindex::files_search,
            fileindex::files_index_status,
            fileindex::files_index_clear,
            github::github_status,
            github::github_set_token,
            github::github_clear_token,
            github::github_repos,
            github::github_project,
            github::github_connect,
            github::github_disconnect,
            github::github_update_connection,
            github::github_sync,
            github::github_sync_task,
            github::github_create_issue,
            github::github_pulls,
            github::github_overview,
            github::github_actions,
            github::github_issues,
            github::github_commits,
            github::github_cached,
            github::github_orgs,
            github::github_org_repos,
            github::github_import_repos,
            // Kern Cloud: account, spaces, sync
            cloud::cloud_status,
            cloud::cloud_sign_up,
            cloud::cloud_sign_in,
            cloud::cloud_send_code,
            cloud::cloud_verify_email,
            cloud::cloud_sign_in_code,
            cloud::cloud_reset_password,
            cloud::cloud_sign_out,
            cloud::cloud_request,
            cloud::cloud_invite_info,
            cloud::cloud_open_space,
            cloud::cloud_apply,
            cloud::cloud_sync_now,
            cloud::cloud_resync,
            cloud::cloud_set_connection,
            cloud::cloud_offline_summary,
            cloud::cloud_import_offline,
            cloud::cloud_forget_space,
            cloud::cloud_take_links,
            cloud::cloud_upload_asset,
            cloud::cloud_image_path,
            // boards
            boards::boards_list,
            boards::board_get,
            boards::board_create,
            boards::board_update,
            boards::board_delete,
            boards::column_create,
            boards::column_update,
            boards::column_delete,
            boards::columns_reorder,
            // notes & inbox
            notes::notes_list,
            notes::note_get,
            notes::note_create,
            notes::note_update,
            notes::notes_delete,
            notes::notes_restore,
            notes::inbox_list,
            notes::inbox_add,
            notes::inbox_update,
            notes::inbox_delete,
            notes::inbox_restore,
            notes::inbox_convert,
            notes::note_backlinks,
            // spelling
            spelling::spell_supported,
            spelling::spell_check,
            spelling::spell_suggest,
            spelling::spell_add,
            spelling::spell_ignore,
            // templates
            templates::templates_list,
            templates::template_get,
            templates::template_save_project,
            templates::template_save_note,
            templates::template_save_task,
            templates::template_update,
            templates::template_delete,
            templates::template_use_project,
            templates::template_use_note,
            templates::template_use_task,
            templates::template_export,
            templates::template_import,
            // habits
            habits::habits_list,
            habits::habit_create,
            habits::habit_update,
            habits::habit_delete,
            habits::habit_check,
            habits::habits_reorder,
            // calendars
            calendar::calendar_feeds_list,
            calendar::calendar_feed_add,
            calendar::calendar_feed_update,
            calendar::calendar_feed_delete,
            calendar::calendar_feed_refresh,
            calendar::calendar_events,
            calendar::calendar_export_ics,
            // weekly review, estimates, AI actions, imports
            review::weekly_review,
            review::estimate_accuracy,
            assist::assist_preview,
            assist::assist_run,
            import::import_bundle,
            // whiteboards
            whiteboards::whiteboards_list,
            whiteboards::whiteboard_get,
            whiteboards::whiteboard_preview,
            whiteboards::whiteboard_create,
            whiteboards::whiteboard_update,
            whiteboards::whiteboard_save,
            whiteboards::whiteboard_patch,
            whiteboards::whiteboard_duplicate,
            whiteboards::whiteboard_import,
            whiteboards::whiteboard_delete,
            whiteboards::whiteboard_restore,
            // attachments
            attachments::attachments_list,
            attachments::attachment_add,
            attachments::attachment_delete,
            attachments::attachment_add_link,
            attachments::attachment_rename,
            attachments::asset_import,
            attachments::asset_import_bytes,
            attachments::attachment_read_base64,
            // dashboards
            dashboards::dashboards_list,
            dashboards::dashboard_create,
            dashboards::dashboard_update,
            dashboards::dashboard_delete,
            // daily rundown
            daily::rundown_data,
            daily::snapshot_get,
            daily::snapshot_save,
            daily::snapshot_mark_viewed,
            daily::snapshots_list,
            // focus
            focus::focus_record,
            focus::focus_sessions_list,
            focus::focus_schedule,
            focus::focus_cancel,
            // misc data
            activity::activity_list,
            recent::recent_list,
            views::views_list,
            views::view_create,
            views::view_update,
            views::view_delete,
            views::views_reorder,
            search::search,
            stats::stats_overview,
            stats::stats_completions,
            stats::stats_due_counts,
            stats::storage_stats,
            storage::storage_report,
            storage::storage_scan,
            storage::storage_scan_cancel,
            storage::storage_cleanup,
            trash::trash_list,
            trash::trash_purge,
            trash::trash_empty,
            // backups & export
            archive::backup_create,
            archive::backups_list,
            archive::backup_preview,
            archive::backup_restore,
            archive::backup_delete,
            archive::export_all,
            archive::export_tasks_csv,
            archive::export_notes_markdown,
            archive::export_projects_json,
            archive::data_dir_size,
            // system
            system::app_info,
            system::open_external,
            system::reveal_path,
            system::path_exists,
            system::write_text_file,
            system::write_binary_file,
            system::read_text_file,
            links::link_metadata,
            links::favicon_get,
            system::tray_set_visible,
            system::quit_app,
            system::show_main_window,
            window::app_mode_get,
            window::app_mode_set,
            window::app_lite_pin,
            window::tray_refresh,
            updates::check_for_update,
            updates::release_notes,
        ])
        .build(context())
        .expect("error while building Kern")
        .run(|app, event| {
            // Terminal processes never outlive the app.
            if let tauri::RunEvent::Exit = event {
                app.state::<AppState>().pty.kill_all();
            }
        });
}
