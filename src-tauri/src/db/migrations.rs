// @Author Christian Relf
// @Date 2026-10-12

//! Versioned schema migrations. `PRAGMA user_version` tracks the applied
//! version. Each migration runs inside its own transaction, so an
//! interrupted migration rolls back cleanly; additionally a full database
//! copy is taken before migrating an existing database (see `db::open`).

pub const MIGRATIONS: &[&str] = &[MIGRATION_1, MIGRATION_2, MIGRATION_3, MIGRATION_4, MIGRATION_5, MIGRATION_6, MIGRATION_7, MIGRATION_8, MIGRATION_9];

const MIGRATION_1: &str = r#"
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE project_groups (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  sort_order REAL NOT NULL DEFAULT 0,
  collapsed INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  icon TEXT,
  accent TEXT,
  target_date TEXT,
  group_id TEXT REFERENCES project_groups(id) ON DELETE SET NULL,
  pinned INTEGER NOT NULL DEFAULT 0,
  sort_order REAL NOT NULL DEFAULT 0,
  default_view TEXT,
  hidden_tabs TEXT NOT NULL DEFAULT '[]',
  default_board_id TEXT,
  last_opened_at INTEGER,
  archived_at INTEGER,
  deleted_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_projects_group ON projects(group_id);

CREATE TABLE labels (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  color TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE boards (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  sort_order REAL NOT NULL DEFAULT 0,
  settings TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_boards_project ON boards(project_id);

CREATE TABLE board_columns (
  id TEXT PRIMARY KEY,
  board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  sort_order REAL NOT NULL DEFAULT 0,
  status TEXT,
  wip_limit INTEGER,
  collapsed INTEGER NOT NULL DEFAULT 0,
  width INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_columns_board ON board_columns(board_id, sort_order);

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'todo',
  priority INTEGER NOT NULL DEFAULT 0,
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  column_id TEXT REFERENCES board_columns(id) ON DELETE SET NULL,
  parent_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
  due_date TEXT,
  due_time TEXT,
  start_date TEXT,
  estimate_minutes INTEGER,
  tracked_seconds INTEGER NOT NULL DEFAULT 0,
  sort_order REAL NOT NULL DEFAULT 0,
  board_order REAL NOT NULL DEFAULT 0,
  pinned INTEGER NOT NULL DEFAULT 0,
  recurrence TEXT,
  series_id TEXT,
  reminder_minutes INTEGER,
  completed_at INTEGER,
  archived_at INTEGER,
  deleted_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_tasks_project ON tasks(project_id, deleted_at);
CREATE INDEX idx_tasks_parent ON tasks(parent_id);
CREATE INDEX idx_tasks_status ON tasks(status, deleted_at);
CREATE INDEX idx_tasks_due ON tasks(due_date) WHERE due_date IS NOT NULL;
CREATE INDEX idx_tasks_column ON tasks(column_id, board_order);
CREATE INDEX idx_tasks_completed ON tasks(completed_at) WHERE completed_at IS NOT NULL;
CREATE INDEX idx_tasks_deleted ON tasks(deleted_at) WHERE deleted_at IS NOT NULL;

CREATE TABLE task_labels (
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  label_id TEXT NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
  PRIMARY KEY (task_id, label_id)
);
CREATE INDEX idx_task_labels_label ON task_labels(label_id);

CREATE TABLE attachments (
  id TEXT PRIMARY KEY,
  task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  path TEXT NOT NULL,
  managed INTEGER NOT NULL DEFAULT 1,
  mime TEXT,
  size INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_attachments_task ON attachments(task_id);
CREATE INDEX idx_attachments_project ON attachments(project_id);

CREATE TABLE notes (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL DEFAULT '',
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  pinned INTEGER NOT NULL DEFAULT 0,
  archived_at INTEGER,
  deleted_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_notes_project ON notes(project_id);

CREATE TABLE inbox_items (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL DEFAULT 'idea',
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE whiteboards (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  pinned INTEGER NOT NULL DEFAULT 0,
  sort_order REAL NOT NULL DEFAULT 0,
  viewport TEXT,
  deleted_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_whiteboards_project ON whiteboards(project_id);

CREATE TABLE wb_nodes (
  id TEXT PRIMARY KEY,
  whiteboard_id TEXT NOT NULL REFERENCES whiteboards(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  x REAL NOT NULL,
  y REAL NOT NULL,
  width REAL,
  height REAL,
  z INTEGER NOT NULL DEFAULT 0,
  parent_id TEXT,
  locked INTEGER NOT NULL DEFAULT 0,
  data TEXT NOT NULL DEFAULT '{}',
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_wb_nodes_board ON wb_nodes(whiteboard_id);

CREATE TABLE wb_edges (
  id TEXT PRIMARY KEY,
  whiteboard_id TEXT NOT NULL REFERENCES whiteboards(id) ON DELETE CASCADE,
  source TEXT NOT NULL,
  target TEXT NOT NULL,
  source_handle TEXT,
  target_handle TEXT,
  data TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX idx_wb_edges_board ON wb_edges(whiteboard_id);

CREATE TABLE dashboards (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  sort_order REAL NOT NULL DEFAULT 0,
  is_default INTEGER NOT NULL DEFAULT 0,
  widgets TEXT NOT NULL DEFAULT '[]',
  layouts TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE daily_snapshots (
  day TEXT NOT NULL,
  kind TEXT NOT NULL,
  data TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  viewed_at INTEGER,
  PRIMARY KEY (day, kind)
);

CREATE TABLE activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  action TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_activity_created ON activity(created_at);
CREATE INDEX idx_activity_project ON activity(project_id, created_at);

CREATE TABLE focus_sessions (
  id TEXT PRIMARY KEY,
  task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  kind TEXT NOT NULL,
  planned_seconds INTEGER NOT NULL,
  actual_seconds INTEGER NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER NOT NULL,
  completed INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_focus_started ON focus_sessions(started_at);

CREATE TABLE saved_views (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  icon TEXT,
  filters TEXT NOT NULL DEFAULT '{}',
  sort_order REAL NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE recent_items (
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  opened_at INTEGER NOT NULL,
  PRIMARY KEY (entity_type, entity_id)
);
CREATE INDEX idx_recent_opened ON recent_items(opened_at);

CREATE TABLE notification_log (
  key TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
);

-- Full-text search across tasks, projects, notes, boards and whiteboard text.
CREATE VIRTUAL TABLE search_fts USING fts5(
  kind UNINDEXED,
  ref_id UNINDEXED,
  parent_id UNINDEXED,
  title,
  body,
  tokenize = 'unicode61 remove_diacritics 2',
  prefix = '2 3'
);

CREATE TRIGGER tasks_fts_ai AFTER INSERT ON tasks WHEN new.deleted_at IS NULL BEGIN
  INSERT INTO search_fts(kind, ref_id, parent_id, title, body) VALUES ('task', new.id, new.project_id, new.title, new.description);
END;
CREATE TRIGGER tasks_fts_au AFTER UPDATE OF title, description, project_id, deleted_at ON tasks BEGIN
  DELETE FROM search_fts WHERE kind = 'task' AND ref_id = old.id;
  INSERT INTO search_fts(kind, ref_id, parent_id, title, body)
    SELECT 'task', new.id, new.project_id, new.title, new.description WHERE new.deleted_at IS NULL;
END;
CREATE TRIGGER tasks_fts_ad AFTER DELETE ON tasks BEGIN
  DELETE FROM search_fts WHERE kind = 'task' AND ref_id = old.id;
END;

CREATE TRIGGER projects_fts_ai AFTER INSERT ON projects WHEN new.deleted_at IS NULL BEGIN
  INSERT INTO search_fts(kind, ref_id, parent_id, title, body) VALUES ('project', new.id, NULL, new.name, new.description);
END;
CREATE TRIGGER projects_fts_au AFTER UPDATE OF name, description, deleted_at ON projects BEGIN
  DELETE FROM search_fts WHERE kind = 'project' AND ref_id = old.id;
  INSERT INTO search_fts(kind, ref_id, parent_id, title, body)
    SELECT 'project', new.id, NULL, new.name, new.description WHERE new.deleted_at IS NULL;
END;
CREATE TRIGGER projects_fts_ad AFTER DELETE ON projects BEGIN
  DELETE FROM search_fts WHERE kind = 'project' AND ref_id = old.id;
END;

CREATE TRIGGER notes_fts_ai AFTER INSERT ON notes WHEN new.deleted_at IS NULL BEGIN
  INSERT INTO search_fts(kind, ref_id, parent_id, title, body) VALUES ('note', new.id, new.project_id, new.title, new.content);
END;
CREATE TRIGGER notes_fts_au AFTER UPDATE OF title, content, project_id, deleted_at ON notes BEGIN
  DELETE FROM search_fts WHERE kind = 'note' AND ref_id = old.id;
  INSERT INTO search_fts(kind, ref_id, parent_id, title, body)
    SELECT 'note', new.id, new.project_id, new.title, new.content WHERE new.deleted_at IS NULL;
END;
CREATE TRIGGER notes_fts_ad AFTER DELETE ON notes BEGIN
  DELETE FROM search_fts WHERE kind = 'note' AND ref_id = old.id;
END;

CREATE TRIGGER boards_fts_ai AFTER INSERT ON boards BEGIN
  INSERT INTO search_fts(kind, ref_id, parent_id, title, body) VALUES ('board', new.id, new.project_id, new.name, '');
END;
CREATE TRIGGER boards_fts_au AFTER UPDATE OF name ON boards BEGIN
  DELETE FROM search_fts WHERE kind = 'board' AND ref_id = old.id;
  INSERT INTO search_fts(kind, ref_id, parent_id, title, body) VALUES ('board', new.id, new.project_id, new.name, '');
END;
CREATE TRIGGER boards_fts_ad AFTER DELETE ON boards BEGIN
  DELETE FROM search_fts WHERE kind = 'board' AND ref_id = old.id;
END;

CREATE TRIGGER whiteboards_fts_ai AFTER INSERT ON whiteboards WHEN new.deleted_at IS NULL BEGIN
  INSERT INTO search_fts(kind, ref_id, parent_id, title, body) VALUES ('whiteboard', new.id, new.project_id, new.name, '');
END;
CREATE TRIGGER whiteboards_fts_au AFTER UPDATE OF name, deleted_at, project_id ON whiteboards BEGIN
  DELETE FROM search_fts WHERE kind = 'whiteboard' AND ref_id = old.id;
  INSERT INTO search_fts(kind, ref_id, parent_id, title, body)
    SELECT 'whiteboard', new.id, new.project_id, new.name, '' WHERE new.deleted_at IS NULL;
END;
CREATE TRIGGER whiteboards_fts_ad AFTER DELETE ON whiteboards BEGIN
  DELETE FROM search_fts WHERE kind = 'whiteboard' AND ref_id = old.id;
END;

-- Searchable whiteboard object text (text cards, stickies, areas, links, shapes).
CREATE TRIGGER wb_nodes_fts_ai AFTER INSERT ON wb_nodes BEGIN
  INSERT INTO search_fts(kind, ref_id, parent_id, title, body)
    SELECT 'wb_node', new.id, new.whiteboard_id,
      COALESCE(json_extract(new.data, '$.title'), json_extract(new.data, '$.label'), ''),
      COALESCE(json_extract(new.data, '$.text'), json_extract(new.data, '$.url'), '')
    WHERE new.type IN ('text', 'sticky', 'area', 'link', 'shape');
END;
CREATE TRIGGER wb_nodes_fts_au AFTER UPDATE OF data ON wb_nodes BEGIN
  DELETE FROM search_fts WHERE kind = 'wb_node' AND ref_id = old.id;
  INSERT INTO search_fts(kind, ref_id, parent_id, title, body)
    SELECT 'wb_node', new.id, new.whiteboard_id,
      COALESCE(json_extract(new.data, '$.title'), json_extract(new.data, '$.label'), ''),
      COALESCE(json_extract(new.data, '$.text'), json_extract(new.data, '$.url'), '')
    WHERE new.type IN ('text', 'sticky', 'area', 'link', 'shape');
END;
CREATE TRIGGER wb_nodes_fts_ad AFTER DELETE ON wb_nodes BEGIN
  DELETE FROM search_fts WHERE kind = 'wb_node' AND ref_id = old.id;
END;
"#;

/// Phase 2: linked project folders and workspace trust, AI API account
/// metadata (secrets live in the OS credential store, never here), local AI
/// usage history, the favicon / link-metadata caches and the storage scan
/// cache. Purely additive: no existing table or id changes.
const MIGRATION_2: &str = r#"
-- A project may be linked to a folder on disk. The link is separate from the
-- project row: deleting a project never touches the folder itself.
CREATE TABLE project_folder_links (
  project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  folder_key TEXT NOT NULL,
  linked_at INTEGER NOT NULL
);
CREATE INDEX idx_folder_links_key ON project_folder_links(folder_key);

-- Trust decisions per canonical folder (exact path; never inherited by
-- parents, children or other folders).
CREATE TABLE trusted_workspaces (
  folder_key TEXT PRIMARY KEY,
  path TEXT NOT NULL,
  trust TEXT NOT NULL CHECK (trust IN ('trusted', 'restricted')),
  decided_at INTEGER NOT NULL
);

-- Per-project AI preferences (JSON: inherit, accountId, model, fileAccess).
ALTER TABLE projects ADD COLUMN ai_prefs TEXT NOT NULL DEFAULT '{}';

-- AI API credential profiles. Only non-sensitive metadata: the key itself is
-- stored in the OS credential store under `credential_ref`.
CREATE TABLE ai_accounts (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL CHECK (provider IN ('anthropic', 'openai')),
  name TEXT NOT NULL,
  credential_ref TEXT NOT NULL UNIQUE,
  key_hint TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  priority REAL NOT NULL DEFAULT 0,
  role TEXT NOT NULL DEFAULT 'none' CHECK (role IN ('primary', 'fallback', 'none')),
  failover_eligible INTEGER NOT NULL DEFAULT 1,
  preferred_model TEXT,
  models TEXT,
  organization_id TEXT,
  project_ref TEXT,
  observed_pool TEXT,
  budget_limit REAL,
  budget_unit TEXT CHECK (budget_unit IN ('tokens', 'usd')),
  budget_warn_percent INTEGER NOT NULL DEFAULT 80,
  budget_hard INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'unknown',
  status_detail TEXT,
  cooldown_until INTEGER,
  rate_limits TEXT,
  last_checked_at INTEGER,
  last_used_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_ai_accounts_order ON ai_accounts(provider, priority);

-- One row per provider call made through Kern. Never prompts or responses.
CREATE TABLE ai_usage_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id TEXT NOT NULL,
  account_id TEXT,
  provider TEXT NOT NULL,
  model TEXT,
  purpose TEXT NOT NULL DEFAULT 'request',
  attempt INTEGER NOT NULL DEFAULT 1,
  started_at INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cached_tokens INTEGER,
  success INTEGER NOT NULL,
  error_category TEXT,
  http_status INTEGER,
  estimated_cost REAL
);
CREATE INDEX idx_ai_usage_started ON ai_usage_events(started_at);
CREATE INDEX idx_ai_usage_account ON ai_usage_events(account_id, started_at);

CREATE TABLE ai_failover_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id TEXT NOT NULL,
  from_account_id TEXT,
  to_account_id TEXT,
  reason TEXT NOT NULL,
  detail TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_ai_failover_created ON ai_failover_events(created_at);

-- Favicons cached per origin; `file` is relative to <data>/cache/favicons.
CREATE TABLE favicon_cache (
  origin TEXT PRIMARY KEY,
  file TEXT,
  status TEXT NOT NULL CHECK (status IN ('ok', 'none', 'error')),
  fetched_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE link_metadata (
  url TEXT PRIMARY KEY,
  title TEXT,
  description TEXT,
  site_name TEXT,
  fetched_at INTEGER NOT NULL
);

CREATE TABLE storage_scan_cache (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  data TEXT NOT NULL,
  scanned_at INTEGER NOT NULL
);

-- Favicons used to share the link-preview switch; carry the user's choice over.
INSERT OR IGNORE INTO settings(key, value, updated_at)
  SELECT 'privacy.favicons', value, updated_at FROM settings WHERE key = 'data.linkPreviews';
"#;

/// GitHub: repositories connected to projects and two-way issue links.
const MIGRATION_3: &str = r#"
CREATE TABLE project_repos (
  project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  owner TEXT NOT NULL,
  name TEXT NOT NULL,
  default_branch TEXT,
  html_url TEXT,
  sync_issues INTEGER NOT NULL DEFAULT 1,
  import_closed INTEGER NOT NULL DEFAULT 0,
  last_synced_at INTEGER,
  last_sync_error TEXT,
  connected_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_project_repos_repo ON project_repos(lower(owner), lower(name));

-- One row per known issue. `task_id` becomes NULL when the task is deleted,
-- which marks the issue as ignored so it's never imported again.
-- synced_* hold the values at the last sync (the merge base).
CREATE TABLE task_issue_links (
  repo TEXT NOT NULL,
  issue_number INTEGER NOT NULL,
  task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  project_id TEXT NOT NULL,
  html_url TEXT NOT NULL,
  remote_updated_at TEXT,
  synced_at INTEGER NOT NULL,
  synced_title TEXT,
  synced_body TEXT,
  synced_state TEXT,
  synced_labels TEXT,
  PRIMARY KEY (repo, issue_number)
);
CREATE UNIQUE INDEX idx_issue_links_task ON task_issue_links(task_id) WHERE task_id IS NOT NULL;
CREATE INDEX idx_issue_links_project ON task_issue_links(project_id);
"#;

/// Phase 3: multi-repository projects, worktree metadata, task ↔ development
/// links, work sessions, workspace state and snapshots, Command Centre
/// layouts, milestones and releases, saved commands, environment profiles,
/// local services, development caches and the linked-file search index.
/// Purely additive: existing tables, ids and relationships are unchanged.
const MIGRATION_4: &str = r#"
-- Repositories linked to a project: zero, one or many. A row has a local
-- clone, a GitHub repository, or both. The project's folder link and its
-- GitHub issue-sync connection (project_repos) stay as they are.
CREATE TABLE project_repositories (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  alias TEXT,
  local_path TEXT,
  folder_key TEXT,
  github TEXT,
  is_primary INTEGER NOT NULL DEFAULT 0,
  sort_order REAL NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (local_path IS NOT NULL OR github IS NOT NULL)
);
CREATE INDEX idx_repositories_project ON project_repositories(project_id, sort_order);
CREATE UNIQUE INDEX idx_repositories_local ON project_repositories(project_id, folder_key) WHERE folder_key IS NOT NULL;
CREATE UNIQUE INDEX idx_repositories_github ON project_repositories(project_id, lower(github)) WHERE github IS NOT NULL;

-- The folder whose repository was last adopted automatically, so unlinking
-- an adopted repository doesn't bring it back.
ALTER TABLE projects ADD COLUMN repo_adopted_key TEXT;
-- Health rule preferences (JSON).
ALTER TABLE projects ADD COLUMN health_prefs TEXT NOT NULL DEFAULT '{}';
-- The open before the current one, for "since last opened".
ALTER TABLE projects ADD COLUMN prev_opened_at INTEGER;

-- Kern's metadata about git worktrees. The worktrees themselves are always
-- read from git; a row only adds an alias and associations.
CREATE TABLE git_worktrees (
  id TEXT PRIMARY KEY,
  repository_id TEXT NOT NULL REFERENCES project_repositories(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  folder_key TEXT NOT NULL,
  alias TEXT,
  task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  agent TEXT,
  created_by_kern INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_worktrees_key ON git_worktrees(repository_id, folder_key);
CREATE INDEX idx_worktrees_task ON git_worktrees(task_id);

-- Milestones (any project) that may also represent a planned release.
CREATE TABLE milestones (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  target_date TEXT,
  status TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned', 'active', 'completed', 'cancelled')),
  progress_mode TEXT NOT NULL DEFAULT 'tasks' CHECK (progress_mode IN ('tasks', 'manual')),
  manual_progress INTEGER NOT NULL DEFAULT 0,
  is_release INTEGER NOT NULL DEFAULT 0,
  version TEXT,
  repository_id TEXT REFERENCES project_repositories(id) ON DELETE SET NULL,
  release_notes TEXT NOT NULL DEFAULT '',
  release_url TEXT,
  sort_order REAL NOT NULL DEFAULT 0,
  completed_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_milestones_project ON milestones(project_id, sort_order);

CREATE TABLE milestone_deps (
  milestone_id TEXT NOT NULL REFERENCES milestones(id) ON DELETE CASCADE,
  depends_on TEXT NOT NULL REFERENCES milestones(id) ON DELETE CASCADE,
  PRIMARY KEY (milestone_id, depends_on),
  CHECK (milestone_id != depends_on)
);

CREATE TABLE release_links (
  id TEXT PRIMARY KEY,
  milestone_id TEXT NOT NULL REFERENCES milestones(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('pull', 'issue')),
  ref TEXT NOT NULL,
  title TEXT,
  url TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE (milestone_id, kind, ref)
);

-- A task belongs to at most one milestone; deleting the milestone keeps the task.
ALTER TABLE tasks ADD COLUMN milestone_id TEXT REFERENCES milestones(id) ON DELETE SET NULL;
CREATE INDEX idx_tasks_milestone ON tasks(milestone_id) WHERE milestone_id IS NOT NULL;

CREATE TRIGGER milestones_fts_ai AFTER INSERT ON milestones BEGIN
  INSERT INTO search_fts(kind, ref_id, parent_id, title, body)
    VALUES ('milestone', new.id, new.project_id, new.title, new.description || ' ' || coalesce(new.version, ''));
END;
CREATE TRIGGER milestones_fts_au AFTER UPDATE OF title, description, version ON milestones BEGIN
  DELETE FROM search_fts WHERE kind = 'milestone' AND ref_id = old.id;
  INSERT INTO search_fts(kind, ref_id, parent_id, title, body)
    VALUES ('milestone', new.id, new.project_id, new.title, new.description || ' ' || coalesce(new.version, ''));
END;
CREATE TRIGGER milestones_fts_ad AFTER DELETE ON milestones BEGIN
  DELETE FROM search_fts WHERE kind = 'milestone' AND ref_id = old.id;
END;

-- Explicit links from a task to development resources. Only explicit links
-- live here; inferred associations are computed and labelled as such.
CREATE TABLE task_dev_links (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('repository', 'branch', 'worktree', 'pull', 'commit')),
  repository_id TEXT REFERENCES project_repositories(id) ON DELETE CASCADE,
  ref TEXT NOT NULL DEFAULT '',
  title TEXT,
  url TEXT,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_dev_links_unique ON task_dev_links(task_id, kind, coalesce(repository_id, ''), ref);
CREATE INDEX idx_dev_links_repo ON task_dev_links(repository_id, kind, ref);

-- Work sessions for any project, with optional development context.
-- Durations derive from timestamps; last_seen_at lets a gap (sleep, crash)
-- be detected and excluded on request.
CREATE TABLE work_sessions (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  repository_id TEXT REFERENCES project_repositories(id) ON DELETE SET NULL,
  branch TEXT,
  worktree_id TEXT REFERENCES git_worktrees(id) ON DELETE SET NULL,
  milestone_id TEXT REFERENCES milestones(id) ON DELETE SET NULL,
  note TEXT NOT NULL DEFAULT '',
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  paused_ms INTEGER NOT NULL DEFAULT 0,
  paused_at INTEGER,
  last_seen_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_sessions_started ON work_sessions(started_at);
CREATE INDEX idx_sessions_task ON work_sessions(task_id);
CREATE INDEX idx_sessions_project ON work_sessions(project_id, started_at);
CREATE INDEX idx_sessions_open ON work_sessions(ended_at) WHERE ended_at IS NULL;

CREATE TABLE session_links (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES work_sessions(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('commit', 'pull', 'issue')),
  repository_id TEXT,
  ref TEXT NOT NULL,
  title TEXT,
  url TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE (session_id, kind, ref)
);

-- Per-project UI context for "resume", and named snapshots of it. Only
-- lightweight references (ids, paths, viewport), never file contents.
CREATE TABLE workspace_state (
  project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  state TEXT NOT NULL DEFAULT '{}',
  updated_at INTEGER NOT NULL
);
CREATE TABLE workspace_snapshots (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_snapshots_project ON workspace_snapshots(project_id);

-- Project Command Centre layouts (widget documents owned by the client).
CREATE TABLE project_layouts (
  project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  preset TEXT,
  widgets TEXT NOT NULL DEFAULT '[]',
  layouts TEXT NOT NULL DEFAULT '{}',
  updated_at INTEGER NOT NULL
);

-- Environment profiles. Secret values live in the OS credential store under
-- secret_ref; only names and non-secret values are stored here.
CREATE TABLE env_profiles (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  sort_order REAL NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_env_profiles_project ON env_profiles(project_id);
CREATE TABLE env_variables (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES env_profiles(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('plain', 'secret', 'inherit')),
  value TEXT,
  secret_ref TEXT,
  sort_order REAL NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (profile_id, name)
);
-- Credential-store entries whose variable is gone; the next sweep removes them.
CREATE TABLE vault_tombstones (
  ref TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
);
CREATE TRIGGER env_variables_secret_ad AFTER DELETE ON env_variables WHEN old.secret_ref IS NOT NULL BEGIN
  INSERT OR IGNORE INTO vault_tombstones(ref, created_at) VALUES (old.secret_ref, CAST(strftime('%s', 'now') AS INTEGER) * 1000);
END;
CREATE TRIGGER env_variables_secret_au AFTER UPDATE OF secret_ref ON env_variables
  WHEN old.secret_ref IS NOT NULL AND (new.secret_ref IS NULL OR new.secret_ref != old.secret_ref) BEGIN
  INSERT OR IGNORE INTO vault_tombstones(ref, created_at) VALUES (old.secret_ref, CAST(strftime('%s', 'now') AS INTEGER) * 1000);
END;

-- Saved project commands: a program and an argument list, never a shell string.
CREATE TABLE project_commands (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  repository_id TEXT REFERENCES project_repositories(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  program TEXT NOT NULL,
  args TEXT NOT NULL DEFAULT '[]',
  cwd TEXT NOT NULL DEFAULT '',
  env_profile_id TEXT REFERENCES env_profiles(id) ON DELETE SET NULL,
  confirm INTEGER NOT NULL DEFAULT 0,
  pinned INTEGER NOT NULL DEFAULT 0,
  sort_order REAL NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_commands_project ON project_commands(project_id, sort_order);

-- Explicitly configured local services and a short check history.
CREATE TABLE local_services (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  health_path TEXT,
  expect_status TEXT,
  expect_text TEXT,
  command_id TEXT REFERENCES project_commands(id) ON DELETE SET NULL,
  repository_id TEXT REFERENCES project_repositories(id) ON DELETE SET NULL,
  interval_secs INTEGER NOT NULL DEFAULT 30,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_status TEXT NOT NULL DEFAULT 'unknown',
  last_detail TEXT,
  last_latency_ms INTEGER,
  last_checked_at INTEGER,
  sort_order REAL NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_services_project ON local_services(project_id);
CREATE TABLE service_checks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  service_id TEXT NOT NULL REFERENCES local_services(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  latency_ms INTEGER,
  detail TEXT,
  checked_at INTEGER NOT NULL
);
CREATE INDEX idx_service_checks ON service_checks(service_id, checked_at);

-- Disposable caches for development data (dependency scans, advisories,
-- GitHub workflow runs and pull requests). Safe to clear at any time.
CREATE TABLE dev_cache (
  key TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  fetched_at INTEGER NOT NULL
);

-- Search index for linked folders: file names, plus the text of small,
-- non-sensitive text files. Updated incrementally from modification times.
CREATE TABLE file_index_roots (
  root_key TEXT PRIMARY KEY,
  path TEXT NOT NULL,
  indexed_at INTEGER NOT NULL,
  file_count INTEGER NOT NULL DEFAULT 0,
  complete INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE file_index (
  id INTEGER PRIMARY KEY,
  root_key TEXT NOT NULL,
  rel TEXT NOT NULL,
  size INTEGER NOT NULL,
  mtime INTEGER NOT NULL,
  UNIQUE (root_key, rel)
);
CREATE VIRTUAL TABLE file_fts USING fts5(
  name,
  body,
  tokenize = 'unicode61 remove_diacritics 2',
  prefix = '2 3'
);
"#;

const MIGRATION_5: &str = r#"
-- How a completed task was closed: NULL means done; 'cancelled' and
-- 'duplicate' close it without counting it as accomplished.
ALTER TABLE tasks ADD COLUMN resolution TEXT;

-- Relations between tasks. One relation per ordered pair: 'blocks' and
-- 'duplicate' read "task_id blocks / duplicates related_id"; 'related' is
-- symmetric.
CREATE TABLE task_relations (
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  related_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('blocks', 'related', 'duplicate')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (task_id, related_id)
);
CREATE INDEX idx_task_relations_related ON task_relations(related_id);
"#;

/// Comments, time blocking, templates, habits and calendar subscriptions.
/// Purely additive.
const MIGRATION_6: &str = r#"
-- Comments on tasks. author_id is the Kern Cloud user who wrote it (NULL
-- offline); mentions is a JSON array of mentioned user ids.
CREATE TABLE task_comments (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  author_id TEXT,
  author_name TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL,
  mentions TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  edited_at INTEGER
);
CREATE INDEX idx_comments_task ON task_comments(task_id, created_at);

-- Time blocking: the day (and optionally the time) a task is planned for.
-- Its length is the task's estimate.
ALTER TABLE tasks ADD COLUMN plan_date TEXT;
ALTER TABLE tasks ADD COLUMN plan_time TEXT;
CREATE INDEX idx_tasks_plan ON tasks(plan_date) WHERE plan_date IS NOT NULL;

-- Reusable projects, notes and tasks (data is a JSON document per kind).
CREATE TABLE templates (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('project', 'note', 'task')),
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  icon TEXT,
  data TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_templates_kind ON templates(kind, name);

-- Habits: something to do on certain days (daily) or a number of times a
-- week (weekly). A check records how many times it was done on a day.
CREATE TABLE habits (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  icon TEXT,
  color TEXT,
  cadence TEXT NOT NULL DEFAULT 'daily' CHECK (cadence IN ('daily', 'weekly')),
  target INTEGER NOT NULL DEFAULT 1,
  weekdays TEXT NOT NULL DEFAULT '[1,2,3,4,5,6,7]',
  sort_order REAL NOT NULL DEFAULT 0,
  archived_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE habit_checks (
  habit_id TEXT NOT NULL REFERENCES habits(id) ON DELETE CASCADE,
  day TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (habit_id, day)
);

-- Read-only calendar subscriptions (ICS addresses) and their events,
-- expanded into occurrences on each refresh. Per computer.
CREATE TABLE calendar_feeds (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  color TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_fetched_at INTEGER,
  last_error TEXT,
  event_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE calendar_events (
  feed_id TEXT NOT NULL REFERENCES calendar_feeds(id) ON DELETE CASCADE,
  uid TEXT NOT NULL,
  -- Local wall-clock start/end: 'YYYY-MM-DD' (all day) or 'YYYY-MM-DDTHH:MM'.
  start TEXT NOT NULL,
  end TEXT NOT NULL,
  all_day INTEGER NOT NULL DEFAULT 0,
  title TEXT NOT NULL DEFAULT '',
  location TEXT,
  PRIMARY KEY (feed_id, uid, start)
);
CREATE INDEX idx_calendar_events_start ON calendar_events(start);
"#;

const MIGRATION_7: &str = r#"
-- Passkeys registered on this computer: Windows Hello, or a security key.
-- Per computer, because a credential id means nothing to another machine's
-- authenticator; `locked_at` on a project syncs, so the lock itself follows
-- the project and each computer needs its own passkey to open it.
CREATE TABLE passkeys (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  -- base64url of the raw credential id the authenticator issued.
  credential_id TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL DEFAULT 'platform' CHECK (kind IN ('platform', 'securityKey')),
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
);

-- "Require a passkey to open this project": the backend returns neither the
-- project nor its tasks, notes, whiteboards or search hits until a passkey
-- has been used for it in this session.
ALTER TABLE projects ADD COLUMN locked_at INTEGER;
"#;

const MIGRATION_8: &str = r#"
-- Who wrote the task. Both columns sync: in a workspace the author's avatar
-- sits at the end of its row, and the cached name keeps that readable for a
-- member who has since left. Offline both stay NULL.
ALTER TABLE tasks ADD COLUMN created_by TEXT;
ALTER TABLE tasks ADD COLUMN created_by_name TEXT;
"#;

const MIGRATION_9: &str = r#"
-- An AI assistant (Claude Desktop, Claude Code) that has asked to connect
-- over the local MCP pipe. Per computer: a connection is made by a program
-- installed here, and approving one on this machine says nothing about
-- another. Nothing connects until `status` is 'approved'.
CREATE TABLE mcp_clients (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'revoked')),
  scope TEXT NOT NULL DEFAULT 'read' CHECK (scope IN ('read', 'write')),
  -- JSON array of project ids; empty means every project.
  projects TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  approved_at INTEGER,
  last_seen_at INTEGER
);

-- Every tool call an assistant made: what it was, what it touched and how it
-- ended. Read by the Assistants tab and pruned on a schedule.
CREATE TABLE mcp_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id TEXT NOT NULL,
  client_name TEXT NOT NULL,
  tool TEXT NOT NULL,
  -- A short, human description of the arguments: never the full payload.
  detail TEXT,
  ok INTEGER NOT NULL DEFAULT 1,
  message TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_mcp_audit_created ON mcp_audit(created_at DESC);
"#;
