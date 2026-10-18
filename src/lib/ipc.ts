/**
 * @Author Christian Relf
 * @Date 2026-10-12
 */

// Typed client for the Rust command layer. All persistence goes through
// here; the UI never builds SQL.

import { invoke } from "@tauri-apps/api/core";
import type * as T from "./types";

export class KernError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

async function call<R>(cmd: string, args?: Record<string, unknown>): Promise<R> {
  try {
    return await invoke<R>(cmd, args);
  } catch (e) {
    if (e && typeof e === "object" && "code" in e && "message" in e) {
      const err = e as { code: string; message: string };
      throw new KernError(err.code, err.message);
    }
    throw new KernError("other", typeof e === "string" ? e : "Something went wrong.");
  }
}

/** Human-friendly message for a failed operation. */
export function describeError(e: unknown, fallback = "Couldn't save your changes."): string {
  if (e instanceof KernError) {
    switch (e.code) {
      case "invalid":
      case "not_found":
      case "network":
      case "auth":
      case "unverified":
      case "locked":
        return e.message.charAt(0).toUpperCase() + e.message.slice(1);
      case "busy":
        return "The database is busy. Try again in a moment.";
      case "io":
        return `File error: ${e.message.replace(/^file error: /, "")}`;
      default:
        return fallback;
    }
  }
  return fallback;
}

export const api = {
  settings: {
    getAll: () => call<Record<string, unknown>>("settings_get_all"),
    set: (entries: Record<string, unknown>) => call<void>("settings_set", { entries }),
    reset: (keys?: string[]) => call<void>("settings_reset", { keys: keys ?? null }),
  },
  tasks: {
    query: (query: T.TaskQuery) => call<T.Task[]>("tasks_query", { query }),
    get: (id: string) => call<T.Task>("task_get", { id }),
    create: (input: T.TaskInput) => call<T.Task>("task_create", { input }),
    update: (id: string, patch: T.TaskPatch) => call<T.TaskUpdateResult>("task_update", { id, patch }),
    updateMany: (ids: string[], patch: T.TaskPatch) => call<T.TaskUpdateResult[]>("tasks_update_many", { ids, patch }),
    patchBatch: (items: [string, T.TaskPatch][]) => call<void>("tasks_patch_batch", { items }),
    duplicate: (id: string) => call<T.Task>("task_duplicate", { id }),
    delete: (ids: string[]) => call<void>("tasks_delete", { ids }),
    restore: (ids: string[]) => call<void>("tasks_restore", { ids }),
    purge: (ids: string[]) => call<void>("tasks_purge", { ids }),
    reorder: (ids: string[], field?: "board" | "list") => call<void>("tasks_reorder", { ids, field: field ?? null }),
  },
  relations: {
    list: (taskId: string) => call<T.TaskRelation[]>("task_relations", { taskId }),
    /** `kind` is from `taskId`'s point of view; replaces any existing relation between the two. */
    set: (taskId: string, otherId: string, kind: "blocks" | "blocked_by" | "related" | "duplicate_of") =>
      call<void>("task_relation_set", { taskId, otherId, kind }),
    remove: (taskId: string, otherId: string) => call<void>("task_relation_remove", { taskId, otherId }),
  },
  comments: {
    list: (taskId: string) => call<T.TaskComment[]>("comments_list", { taskId }),
    add: (taskId: string, body: string) => call<T.TaskComment>("comment_add", { taskId, body }),
    edit: (id: string, body: string) => call<T.TaskComment>("comment_edit", { id, body }),
    delete: (id: string) => call<void>("comment_delete", { id }),
    /** Comments by others that mention you (Kern Cloud spaces). */
    mentions: (limit?: number) => call<T.Mention[]>("comment_mentions", { limit: limit ?? null }),
  },
  templates: {
    list: (kind?: T.TemplateKind) => call<T.TemplateMeta[]>("templates_list", { kind: kind ?? null }),
    get: (id: string) => call<T.Template>("template_get", { id }),
    saveProject: (projectId: string, name: string, description: string, includeTasks: boolean, includeNotes: boolean) =>
      call<T.Template>("template_save_project", { projectId, name, description, includeTasks, includeNotes }),
    saveNote: (noteId: string, name: string) => call<T.Template>("template_save_note", { noteId, name }),
    saveTask: (taskId: string, name: string) => call<T.Template>("template_save_task", { taskId, name }),
    update: (id: string, patch: { name?: string; description?: string; icon?: string }) => call<T.Template>("template_update", { id, patch }),
    delete: (id: string) => call<void>("template_delete", { id }),
    useProject: (id: string, input: { name: string; startDate?: string | null; groupId?: string | null; includeTasks?: boolean; includeNotes?: boolean }) =>
      call<T.Project>("template_use_project", { id, input }),
    useNote: (id: string, projectId?: string | null) => call<T.Note>("template_use_note", { id, projectId: projectId ?? null }),
    useTask: (id: string, projectId?: string | null, dueDate?: string | null) => call<T.Task>("template_use_task", { id, projectId: projectId ?? null, dueDate: dueDate ?? null }),
    export: (id: string, path: string) => call<void>("template_export", { id, path }),
    import: (path: string) => call<T.Template>("template_import", { path }),
  },
  habits: {
    list: (today: string, days?: number, includeArchived = false) => call<T.Habit[]>("habits_list", { today, days: days ?? null, includeArchived }),
    create: (input: T.HabitInput, today: string) => call<T.Habit>("habit_create", { input, today }),
    update: (id: string, patch: T.HabitPatch, today: string) => call<T.Habit>("habit_update", { id, patch, today }),
    delete: (id: string) => call<void>("habit_delete", { id }),
    /** Adds `delta` to a day's count (never below zero). */
    check: (id: string, day: string, delta: number, today: string) => call<T.Habit>("habit_check", { id, day, delta, today }),
    reorder: (ids: string[]) => call<void>("habits_reorder", { ids }),
  },
  calendar: {
    feeds: () => call<T.CalendarFeed[]>("calendar_feeds_list"),
    /** Adds a subscription and fetches it straight away (fails if the address doesn't work). */
    addFeed: (name: string, url: string, color?: string | null) => call<T.CalendarFeed>("calendar_feed_add", { name, url, color: color ?? null }),
    updateFeed: (id: string, patch: { name?: string; color?: string; enabled?: boolean }) => call<T.CalendarFeed>("calendar_feed_update", { id, patch }),
    deleteFeed: (id: string) => call<void>("calendar_feed_delete", { id }),
    refresh: (id?: string | null) => call<T.CalendarFeed[]>("calendar_feed_refresh", { id: id ?? null }),
    events: (from: string, to: string) => call<T.CalEvent[]>("calendar_events", { from, to }),
    exportIcs: (path: string, options: T.IcsExportOptions) => call<number>("calendar_export_ics", { path, options }),
  },
  review: {
    week: (weekStart: string, today: string) => call<T.WeekReview>("weekly_review", { weekStart, today, tzOffsetMinutes: -new Date().getTimezoneOffset() }),
    estimates: (from: number, to: number, projectId?: string | null) => call<T.EstimateStats>("estimate_accuracy", { from, to, projectId: projectId ?? null }),
  },
  /** AI actions (preview shows exactly what would be sent). */
  assist: {
    preview: (input: T.AssistInput) => call<T.AssistPreview>("assist_preview", { input }),
    run: (input: T.AssistInput, requestId: string) => call<T.AssistResult>("assist_run", { input, requestId }),
  },
  importBundle: (bundle: T.ImportBundle) => call<T.ImportResult>("import_bundle", { bundle }),
  labels: {
    list: () => call<T.Label[]>("labels_list"),
    create: (name: string, color?: string | null) => call<T.Label>("label_create", { name, color: color ?? null }),
    update: (id: string, name?: string, color?: string) =>
      call<void>("label_update", { id, name: name ?? null, color: color ?? null }),
    delete: (id: string) => call<void>("label_delete", { id }),
  },
  projects: {
    list: (includeArchived = false) => call<T.Project[]>("projects_list", { includeArchived }),
    get: (id: string) => call<T.Project>("project_get", { id }),
    create: (input: T.ProjectInput) => call<T.Project>("project_create", { input }),
    update: (id: string, patch: T.ProjectPatch) => call<T.Project>("project_update", { id, patch }),
    /** Reorders projects; pass `group` to also move them into a group (null = ungrouped). */
    reorder: (ids: string[], group?: { groupId: string | null }) =>
      call<void>("projects_reorder", { ids, setGroup: group !== undefined, groupId: group?.groupId ?? null }),
    /** Full sidebar arrangement: order plus group membership, applied atomically. */
    arrange: (placements: { id: string; groupId: string | null }[]) => call<void>("projects_arrange", { placements }),
    resetOrder: () => call<void>("projects_reset_order"),
    duplicate: (id: string) => call<T.Project>("project_duplicate", { id }),
    delete: (id: string) => call<void>("project_delete", { id }),
    restore: (id: string) => call<void>("project_restore", { id }),
    touch: (id: string) => call<void>("project_touch", { id }),
    capabilities: (id: string) => call<T.ProjectCapabilities>("project_capabilities", { id }),
  },
  /** Passkeys, and the per-project locks they open. Credentials never cross
   *  the boundary: the OS prompt is drawn by the back end. */
  passkeys: {
    list: () => call<T.Passkey[]>("passkeys_list"),
    support: () => call<T.PasskeySupport>("passkeys_support"),
    /** Shows the OS prompt, then records the new passkey. */
    register: (label: string, kind: T.PasskeyKind) => call<T.Passkey>("passkey_register", { label, kind }),
    rename: (id: string, label: string) => call<void>("passkey_rename", { id, label }),
    /** Needs a passkey of its own: the OS prompt comes first. */
    remove: (id: string) => call<void>("passkey_remove", { id }),
    /** Forgets every passkey and clears every lock, for a lost authenticator. */
    reset: () => call<void>("passkeys_reset"),
    locked: () => call<T.LockedProject[]>("locked_projects_list"),
    setLocked: (id: string, locked: boolean) => call<void>("project_set_locked", { id, locked }),
    /** Opens one locked project for this session, via the OS prompt. */
    unlock: (id: string) => call<void>("project_unlock", { id }),
    /** "Lock now": one project, or every one when id is omitted. */
    relock: (id?: string) => call<void>("project_relock", { id: id ?? null }),
  },
  ai: {
    list: () => call<T.AiAccount[]>("ai_accounts_list"),
    /** The key is write-only: it goes to the OS credential store and is never returned. */
    create: (input: T.AiAccountInput) => call<T.AiAccount>("ai_account_create", { input }),
    update: (id: string, patch: T.AiAccountPatch) => call<T.AiAccount>("ai_account_update", { id, patch }),
    replaceKey: (id: string, apiKey: string) => call<T.AiAccount>("ai_account_replace_key", { id, apiKey }),
    remove: (id: string) => call<void>("ai_account_delete", { id }),
    reorder: (ids: string[]) => call<void>("ai_accounts_reorder", { ids }),
    test: (id: string) => call<T.AiValidation>("ai_account_test", { id }),
    /** Validates a key without saving it. */
    testKey: (provider: T.AiProvider, apiKey: string, organizationId?: string | null, projectRef?: string | null) =>
      call<T.AiValidation>("ai_key_test", { provider, apiKey, organizationId: organizationId ?? null, projectRef: projectRef ?? null }),
    request: (request: T.AiRouteRequest) => call<T.AiRouteOutcome>("ai_request", { request }),
    cancel: (requestId: string) => call<void>("ai_request_cancel", { requestId }),
    usage: (since: number) => call<T.AiUsageSummary>("ai_usage", { since, tzOffsetMinutes: -new Date().getTimezoneOffset() }),
    clearHistory: () => call<void>("ai_history_clear"),
    security: () => call<T.AiSecurityReport>("ai_security_check"),
  },
  /** Git commands act on one linked repository (see `repos`). */
  git: {
    available: () => call<string | null>("git_available"),
    remote: (projectId: string) => call<T.GitRemoteInfo>("git_remote", { projectId }),
    status: (repoId: string) => call<T.GitStatus>("git_status", { repoId }),
    diff: (repoId: string, path: string, staged: boolean, untracked: boolean) => call<string>("git_diff", { repoId, path, staged, untracked }),
    log: (repoId: string, limit?: number, all?: boolean, range?: string | null) =>
      call<T.GitCommit[]>("git_log", { repoId, limit: limit ?? null, all: all ?? null, range: range ?? null }),
    branches: (repoId: string) => call<T.GitBranch[]>("git_branches", { repoId }),
    switch: (repoId: string, name: string, create = false) => call<void>("git_switch", { repoId, name, create }),
    checkBranch: (repoId: string, name: string) => call<T.BranchCheck>("git_branch_check", { repoId, name }),
    createBranch: (repoId: string, name: string, base: string | null, switchTo: boolean) =>
      call<void>("git_create_branch", { repoId, name, base, switch: switchTo }),
    sync: (repoId: string, action: "fetch" | "pull" | "push") => call<{ output: string }>("git_sync", { repoId, action }),
    clone: (repo: string, parent: string) => call<string>("git_clone", { repo, parent }),
    scanTodos: (projectId: string) => call<T.TodoItem[]>("project_scan_todos", { projectId }),
    defaultBase: (repositoryId: string) => call<string>("repo_default_base", { repositoryId }),
  },
  repos: {
    list: (projectId: string) => call<T.Repository[]>("repos_list", { projectId }),
    linkLocal: (projectId: string, path: string, trust: T.Trust) => call<T.Repository>("repo_link_local", { projectId, path, trust }),
    linkGithub: (projectId: string, repo: string) => call<T.Repository>("repo_link_github", { projectId, repo }),
    unlink: (id: string) => call<void>("repo_unlink", { id }),
    update: (id: string, patch: { alias?: string | null; primary?: boolean; sortOrder?: number }) => call<T.Repository>("repo_update", { id, patch }),
    setTrust: (id: string, trust: T.Trust) => call<T.Repository>("repo_set_trust", { id, trust }),
    summary: (id: string) => call<T.RepoSummaryInfo>("repo_summary", { id }),
    reveal: (id: string) => call<void>("repo_reveal", { id }),
  },
  worktrees: {
    list: (repositoryId: string, withStatus = true) => call<T.Worktree[]>("worktrees_list", { repositoryId, withStatus }),
    defaultPath: (repositoryId: string, branch: string) => call<string>("worktree_default_path", { repositoryId, branch }),
    create: (input: T.WorktreeInput) => call<T.Worktree>("worktree_create", { input }),
    inspect: (repositoryId: string, path: string) => call<T.WorktreeInspection>("worktree_inspect", { repositoryId, path }),
    remove: (repositoryId: string, path: string, force: boolean, deleteBranch: boolean) =>
      call<{ removed: boolean; branchDeleted: boolean; branchNote: string | null }>("worktree_remove", { repositoryId, path, force, deleteBranch }),
    update: (repositoryId: string, path: string, patch: { alias?: string | null; taskId?: string | null; agent?: string | null }) =>
      call<void>("worktree_update", { repositoryId, path, patch }),
    prune: (repositoryId: string) => call<void>("worktrees_prune", { repositoryId }),
    openInEditor: (path: string) => call<void>("open_in_editor", { path }),
  },
  devLinks: {
    list: (taskId: string) => call<T.DevLink[]>("task_links", { taskId }),
    add: (input: { taskId: string; kind: T.DevLinkKind; repositoryId?: string | null; ref: string; title?: string | null; url?: string | null }) =>
      call<void>("task_link_add", { input: { repositoryId: null, title: null, url: null, ...input } }),
    remove: (id: string) => call<void>("task_link_remove", { id }),
    context: (taskId: string) => call<T.TaskDevContext>("task_dev_context", { taskId }),
    branchCommits: (repositoryId: string, branch: string, limit?: number) =>
      call<{ base: string; commits: T.GitCommit[] }>("task_branch_commits", { repositoryId, branch, limit: limit ?? null }),
  },
  sessions: {
    active: () => call<T.WorkSession | null>("session_active"),
    start: (input: T.SessionInput) => call<T.WorkSession>("session_start", { input }),
    pause: (id: string) => call<T.WorkSession>("session_pause", { id }),
    resume: (id: string) => call<T.WorkSession>("session_resume", { id }),
    stop: (id: string, note?: string | null, at?: number | null) => call<T.WorkSession>("session_stop", { id, note: note ?? null, at: at ?? null }),
    heartbeat: (id: string) => call<void>("session_heartbeat", { id }),
    discardGap: (id: string) => call<T.WorkSession>("session_discard_gap", { id }),
    update: (id: string, patch: Partial<Pick<T.WorkSession, "note" | "taskId" | "projectId" | "milestoneId" | "repositoryId" | "branch">>) =>
      call<T.WorkSession>("session_update", { id, patch }),
    delete: (id: string) => call<void>("session_delete", { id }),
    list: (query: { from?: number; to?: number; projectId?: string | null; taskId?: string | null; limit?: number }) => call<T.WorkSession[]>("sessions_list", { query }),
    report: (from: number, to: number, projectId?: string | null) =>
      call<T.SessionReport>("sessions_report", { from, to, tzOffsetMinutes: -new Date().getTimezoneOffset(), projectId: projectId ?? null }),
    addLink: (input: { sessionId: string; kind: T.SessionLink["kind"]; repositoryId?: string | null; ref: string; title?: string | null; url?: string | null }) =>
      call<void>("session_link_add", { input: { repositoryId: null, title: null, url: null, ...input } }),
    removeLink: (id: string) => call<void>("session_link_remove", { id }),
  },
  workspace: {
    get: (projectId: string) => call<T.WorkspaceState | null>("workspace_state_get", { projectId }),
    save: (projectId: string, value: T.WorkspaceState) => call<void>("workspace_state_save", { projectId, value }),
    snapshots: (projectId: string) => call<T.WorkspaceSnapshot[]>("workspace_snapshots_list", { projectId }),
    saveSnapshot: (projectId: string, name: string, value: T.WorkspaceState, id?: string | null) =>
      call<T.WorkspaceSnapshot>("workspace_snapshot_save", { projectId, name, value, id: id ?? null }),
    deleteSnapshot: (id: string) => call<void>("workspace_snapshot_delete", { id }),
    layout: (projectId: string) => call<T.ProjectLayout | null>("project_layout_get", { projectId }),
    saveLayout: (projectId: string, preset: string | null, widgets: T.WidgetInstance[], layouts: T.GridLayouts) =>
      call<void>("project_layout_save", { projectId, preset, widgets, layouts }),
    resetLayout: (projectId: string) => call<void>("project_layout_reset", { projectId }),
  },
  milestones: {
    list: (projectId: string) => call<T.Milestone[]>("milestones_list", { projectId }),
    upcoming: (until: string, limit?: number) => call<T.Milestone[]>("milestones_upcoming", { until, limit: limit ?? null }),
    get: (id: string) => call<T.Milestone>("milestone_get", { id }),
    create: (input: T.MilestoneInput) => call<T.Milestone>("milestone_create", { input }),
    update: (id: string, patch: T.MilestonePatch) => call<T.Milestone>("milestone_update", { id, patch }),
    delete: (id: string) => call<void>("milestone_delete", { id }),
    reorder: (ids: string[]) => call<void>("milestones_reorder", { ids }),
    setDeps: (id: string, dependsOn: string[]) => call<T.Milestone>("milestone_set_deps", { id, dependsOn }),
    addLink: (input: { milestoneId: string; kind: "pull" | "issue"; ref: string; title?: string | null; url?: string | null }) =>
      call<T.Milestone>("release_link_add", { input: { title: null, url: null, ...input } }),
    removeLink: (id: string) => call<void>("release_link_remove", { id }),
    changelog: (id: string) => call<string>("milestone_changelog", { id }),
  },
  devenv: {
    detect: (projectId: string, repositoryId?: string | null) => call<T.DevEnvironment>("devenv_detect", { projectId, repositoryId: repositoryId ?? null }),
    cached: (projectId: string) => call<Record<string, string[]>>("devenv_cached", { projectId }),
    which: (program: string) => call<string | null>("which_program", { program }),
  },
  commands: {
    list: (projectId: string) => call<T.SavedCommand[]>("commands_list", { projectId }),
    save: (input: T.CommandInput) => call<T.SavedCommand>("command_save", { input }),
    delete: (id: string) => call<void>("command_delete", { id }),
  },
  pty: {
    shells: () => call<T.Shell[]>("pty_shells"),
    spawn: (input: T.PtySpawnInput) => call<T.PtyInfo>("pty_spawn", { input }),
    write: (id: string, data: string) => call<void>("pty_write", { id, data }),
    resize: (id: string, cols: number, rows: number) => call<void>("pty_resize", { id, cols, rows }),
    kill: (id: string) => call<void>("pty_kill", { id }),
    close: (id: string) => call<void>("pty_close", { id }),
    list: () => call<T.PtyInfo[]>("pty_list"),
    rename: (id: string, title: string) => call<void>("pty_rename", { id, title }),
  },
  env: {
    profiles: (projectId: string) => call<T.EnvProfile[]>("env_profiles_list", { projectId }),
    createProfile: (projectId: string, name: string) => call<T.EnvProfile>("env_profile_create", { projectId, name }),
    renameProfile: (id: string, name: string) => call<T.EnvProfile>("env_profile_rename", { id, name }),
    deleteProfile: (id: string) => call<void>("env_profile_delete", { id }),
    duplicateProfile: (id: string) => call<T.EnvProfile>("env_profile_duplicate", { id }),
    setVar: (input: T.EnvVarInput) => call<T.EnvVar>("env_var_set", { input: { id: null, value: null, ...input } }),
    deleteVar: (id: string) => call<void>("env_var_delete", { id }),
    /** Returns the value; only on explicit request. */
    reveal: (id: string) => call<string>("env_var_reveal", { id }),
    import: (profileId: string, path: string, opts: { autoSecret: boolean; allSecret: boolean; overwrite: boolean }) =>
      call<{ added: number; updated: number; skipped: number; secrets: number }>("env_import", { profileId, path, ...opts }),
    export: (profileId: string, path: string, includeSecrets: boolean, overwrite: boolean) =>
      call<number>("env_export", { profileId, path, includeSecrets, overwrite }),
  },
  services: {
    list: (projectId: string) => call<T.LocalService[]>("services_list", { projectId }),
    save: (input: T.ServiceInput) => call<T.LocalService>("service_save", { input }),
    delete: (id: string) => call<void>("service_delete", { id }),
    check: (id: string) => call<T.LocalService>("service_check", { id }),
    checkProject: (projectId: string) => call<T.LocalService[]>("services_check_project", { projectId }),
    containers: () => call<T.Container[]>("docker_containers"),
    containerAction: (id: string, action: "start" | "stop" | "restart") => call<void>("docker_container_action", { id, action }),
  },
  deps: {
    cached: (projectId: string, repositoryId?: string | null) =>
      call<{ report: T.DepReport | null; advisories: T.AdvisoryReport | null }>("deps_cached", { projectId, repositoryId: repositoryId ?? null }),
    scan: (projectId: string, repositoryId?: string | null) => call<T.DepReport>("deps_scan", { projectId, repositoryId: repositoryId ?? null }),
    advisories: (projectId: string, repositoryId?: string | null) => call<T.AdvisoryReport>("deps_advisories", { projectId, repositoryId: repositoryId ?? null }),
  },
  health: {
    get: (projectId: string) => call<T.ProjectHealth>("project_health", { projectId }),
    setPrefs: (projectId: string, prefs: T.HealthPrefs) => call<T.ProjectHealth>("project_health_prefs", { projectId, prefs }),
  },
  catchup: {
    local: (projectId: string, from: number, to: number, include: T.CatchupInclude) => call<T.CatchupDigest>("catchup_local", { projectId, from, to, include }),
    preview: (projectId: string, from: number, to: number, include: T.CatchupInclude) => call<T.CatchupPreview>("catchup_preview", { projectId, from, to, include }),
    ai: (projectId: string, from: number, to: number, include: T.CatchupInclude, requestId: string) =>
      call<T.CatchupAi>("catchup_ai", { projectId, from, to, include, requestId }),
  },
  files: {
    index: (projectIds?: string[] | null, force = false) => call<T.IndexStats>("files_index", { projectIds: projectIds ?? null, force }),
    search: (query: string, code: boolean, projectIds?: string[] | null, limit?: number) =>
      call<T.FileHit[]>("files_search", { query, code, projectIds: projectIds ?? null, limit: limit ?? null }),
    status: () => call<T.IndexStatus>("files_index_status"),
    clear: () => call<void>("files_index_clear"),
  },
  github: {
    status: () => call<T.GithubStatus>("github_status"),
    setToken: (token: string) => call<string>("github_set_token", { token }),
    clearToken: () => call<void>("github_clear_token"),
    repos: () => call<T.RepoSummary[]>("github_repos"),
    project: (projectId: string) => call<T.ProjectRepo | null>("github_project", { projectId }),
    connect: (projectId: string, repo: string, importClosed = false) => call<T.ProjectRepo>("github_connect", { projectId, repo, importClosed }),
    disconnect: (projectId: string) => call<void>("github_disconnect", { projectId }),
    update: (projectId: string, patch: { syncIssues?: boolean; importClosed?: boolean }) =>
      call<void>("github_update_connection", { projectId, syncIssues: patch.syncIssues ?? null, importClosed: patch.importClosed ?? null }),
    sync: (projectId: string) => call<T.SyncReport>("github_sync", { projectId }),
    syncTask: (taskId: string) => call<T.SyncReport>("github_sync_task", { taskId }),
    createIssue: (taskId: string) => call<string>("github_create_issue", { taskId }),
    pulls: (projectId: string, repo?: string | null) => call<T.PullInfo[]>("github_pulls", { projectId, repo: repo ?? null }),
    overview: (projectId: string, repo?: string | null, repositoryId?: string | null) => call<T.RepoOverview>("github_overview", { projectId, repo: repo ?? null, repositoryId: repositoryId ?? null }),
    actions: (projectId: string, repo?: string | null) => call<T.ActionsOverview>("github_actions", { projectId, repo: repo ?? null }),
    issues: (projectId: string, repo?: string | null) => call<T.IssueSummary[]>("github_issues", { projectId, repo: repo ?? null }),
    commits: (projectId: string, repo?: string | null) => call<T.RemoteCommit[]>("github_commits", { projectId, repo: repo ?? null }),
    cached: (projectId: string) => call<T.CachedGithub[]>("github_cached", { projectId }),
    orgs: () => call<T.GithubOrg[]>("github_orgs"),
    orgRepos: (org: string) => call<T.RepoSummary[]>("github_org_repos", { org }),
    importRepos: (repos: Pick<T.RepoSummary, "fullName" | "description" | "defaultBranch" | "htmlUrl">[], syncIssues = true) =>
      call<{ created: string[]; skipped: string[] }>("github_import_repos", { repos, syncIssues }),
  },
  /** Kern Cloud. Requests are made by the backend, which holds the session. */
  cloud: {
    status: () => call<T.CloudInfo>("cloud_status"),
    signUp: (name: string, email: string, password: string) => call<void>("cloud_sign_up", { name, email, password }),
    signIn: (email: string, password: string) => call<T.CloudAccount>("cloud_sign_in", { email, password }),
    sendCode: (email: string, purpose: "verify" | "sign-in" | "reset") => call<void>("cloud_send_code", { email, purpose }),
    verifyEmail: (email: string, code: string) => call<T.CloudAccount>("cloud_verify_email", { email, code }),
    signInWithCode: (email: string, code: string) => call<T.CloudAccount>("cloud_sign_in_code", { email, code }),
    resetPassword: (email: string, code: string, password: string) => call<void>("cloud_reset_password", { email, code, password }),
    signOut: (forget = false) => call<boolean>("cloud_sign_out", { forget }),
    request: <R = unknown>(method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", path: string, body?: unknown) =>
      call<R>("cloud_request", { method, path, body: body ?? null }),
    inviteInfo: (id: string) => call<T.InviteSummary>("cloud_invite_info", { id }),
    openSpace: (space: T.ActiveSpace | null) => call<void>("cloud_open_space", { space }),
    apply: (space: string, from: number, to: number, changes: T.RemoteChange[]) => call<void>("cloud_apply", { space, from, to, changes }),
    syncNow: () => call<void>("cloud_sync_now"),
    resync: () => call<void>("cloud_resync"),
    setConnection: (connId: string | null) => call<void>("cloud_set_connection", { connId }),
    offlineSummary: () => call<T.OfflineSummary>("cloud_offline_summary"),
    importOffline: (projectIds?: string[] | null) => call<Record<string, number>>("cloud_import_offline", { projectIds: projectIds ?? null }),
    forgetSpace: (spaceId: string) => call<void>("cloud_forget_space", { spaceId }),
    takeLinks: () => call<string[]>("cloud_take_links"),
    /** Shares a compressed whiteboard image with the space; returns its asset id. */
    uploadAsset: (space: string, dataBase64: string, mime: string, width?: number, height?: number) =>
      call<string>("cloud_upload_asset", { space, dataBase64, mime, width: width ?? null, height: height ?? null }),
    /** Local file for a whiteboard image: the original, or the downloaded shared copy. */
    imagePath: (space: string | null, src: string | null, asset: string | null) => call<string | null>("cloud_image_path", { space, src, asset }),
  },
  folders: {
    inspect: (path: string) => call<T.FolderInfo>("folder_inspect", { path }),
    get: (projectId: string) => call<T.ProjectFolder | null>("project_folder_get", { projectId }),
    link: (projectId: string, path: string, trust: T.Trust) => call<T.ProjectFolder>("project_folder_link", { projectId, path, trust }),
    unlink: (projectId: string) => call<void>("project_folder_unlink", { projectId }),
    setTrust: (projectId: string, trust: T.Trust) => call<T.ProjectFolder>("project_folder_set_trust", { projectId, trust }),
    list: (projectId: string, rel: string, repositoryId?: string | null) => call<T.DirListing>("project_files_list", { projectId, rel, repositoryId: repositoryId ?? null }),
    open: (projectId: string, rel: string, confirmedProgram = false, repositoryId?: string | null) =>
      call<void>("project_file_open", { projectId, rel, confirmedProgram, repositoryId: repositoryId ?? null }),
    reveal: (projectId: string, rel: string, repositoryId?: string | null) => call<void>("project_file_reveal", { projectId, rel, repositoryId: repositoryId ?? null }),
    path: (projectId: string, rel: string, repositoryId?: string | null) => call<string>("project_file_path", { projectId, rel, repositoryId: repositoryId ?? null }),
    createFolder: (projectId: string, parentRel: string, name: string) =>
      call<string>("project_folder_create", { projectId, parentRel, name }),
    rename: (projectId: string, rel: string, newName: string) => call<string>("project_file_rename", { projectId, rel, newName }),
    createFile: (projectId: string, parentRel: string, name: string) => call<string>("project_file_create", { projectId, parentRel, name }),
    duplicate: (projectId: string, rel: string) => call<string>("project_file_duplicate", { projectId, rel }),
    /** Moves to the Recycle Bin / Trash. */
    trash: (projectId: string, rel: string) => call<void>("project_file_trash", { projectId, rel }),
    read: (projectId: string, rel: string, repositoryId?: string | null) => call<T.FileText>("project_file_read", { projectId, rel, repositoryId: repositoryId ?? null }),
    write: (projectId: string, rel: string, file: Pick<T.FileText, "text" | "crlf" | "bom" | "modified">, repositoryId?: string | null) =>
      call<number | null>("project_file_write", { projectId, rel, text: file.text, crlf: file.crlf, bom: file.bom, expectedModified: file.modified, repositoryId: repositoryId ?? null }),
    /** Data URL of an image inside the folder. */
    image: (projectId: string, rel: string, repositoryId?: string | null) => call<string>("project_file_image", { projectId, rel, repositoryId: repositoryId ?? null }),
    kinds: (projectId: string) => call<T.FileKindCount[]>("project_file_kinds", { projectId }),
    trusted: () => call<T.TrustRecord[]>("trusted_folders_list"),
    /** trust = null forgets the decision. */
    updateTrusted: (path: string, trust: T.Trust | null) => call<void>("trusted_folder_update", { path, trust }),
  },
  plugins: {
    installed: () => call<string[]>("syntax_installed"),
    install: (names: string[]) => call<string[]>("syntax_install", { names }),
    remove: (names: string[]) => call<void>("syntax_remove", { names }),
    grammar: (name: string) => call<string>("syntax_grammar", { name }),
  },
  groups: {
    list: () => call<T.ProjectGroup[]>("groups_list"),
    create: (name: string) => call<T.ProjectGroup>("group_create", { name }),
    update: (id: string, patch: { name?: string; collapsed?: boolean; sortOrder?: number }) =>
      call<void>("group_update", {
        id,
        name: patch.name ?? null,
        collapsed: patch.collapsed ?? null,
        sortOrder: patch.sortOrder ?? null,
      }),
    delete: (id: string) => call<void>("group_delete", { id }),
    reorder: (ids: string[]) => call<void>("groups_reorder", { ids }),
  },
  boards: {
    list: (projectId?: string) => call<T.Board[]>("boards_list", { projectId: projectId ?? null }),
    get: (id: string) => call<T.BoardData>("board_get", { id }),
    create: (projectId: string, name: string) => call<T.Board>("board_create", { projectId, name }),
    update: (id: string, patch: { name?: string; settings?: T.BoardSettings; makeDefault?: boolean }) =>
      call<T.Board>("board_update", { id, patch }),
    delete: (id: string) => call<void>("board_delete", { id }),
    createColumn: (boardId: string, name: string, status?: T.TaskStatus | null) =>
      call<T.Column>("column_create", { boardId, name, status: status ?? null }),
    updateColumn: (
      id: string,
      patch: { name?: string; status?: T.TaskStatus | null; wipLimit?: number | null; collapsed?: boolean; width?: number | null },
    ) => call<void>("column_update", { id, patch }),
    deleteColumn: (id: string, moveTo?: string | null) => call<void>("column_delete", { id, moveTo: moveTo ?? null }),
    reorderColumns: (ids: string[]) => call<void>("columns_reorder", { ids }),
  },
  notes: {
    list: (projectId?: string | null, includeArchived = false) =>
      call<T.NoteMeta[]>("notes_list", { projectId: projectId ?? null, includeArchived }),
    get: (id: string) => call<T.Note>("note_get", { id }),
    create: (input: { title?: string; content?: string; projectId?: string | null }) =>
      call<T.Note>("note_create", {
        title: input.title ?? null,
        content: input.content ?? null,
        projectId: input.projectId ?? null,
      }),
    update: (
      id: string,
      patch: { title?: string; content?: string; projectId?: string | null; pinned?: boolean; archived?: boolean },
    ) => call<T.Note>("note_update", { id, patch }),
    delete: (ids: string[]) => call<void>("notes_delete", { ids }),
    restore: (ids: string[]) => call<void>("notes_restore", { ids }),
    /** Notes that link to a note, task or project. */
    backlinks: (kind: "note" | "task" | "project", id: string) => call<T.Backlink[]>("note_backlinks", { kind, id }),
  },
  inbox: {
    list: () => call<T.InboxItem[]>("inbox_list"),
    add: (content: string, kind?: T.InboxItem["kind"]) => call<T.InboxItem>("inbox_add", { content, kind: kind ?? null }),
    update: (id: string, content: string) => call<void>("inbox_update", { id, content }),
    delete: (id: string) => call<T.InboxItem | null>("inbox_delete", { id }),
    restore: (item: T.InboxItem) => call<void>("inbox_restore", { item }),
    convert: (id: string, to: "task" | "note", projectId?: string | null) =>
      call<{ kind: string; id: string }>("inbox_convert", { id, to, projectId: projectId ?? null }),
  },
  whiteboards: {
    list: (projectId?: string | null) => call<T.Whiteboard[]>("whiteboards_list", { projectId: projectId ?? null }),
    get: (id: string) => call<T.WhiteboardScene>("whiteboard_get", { id }),
    preview: (id: string) => call<T.WhiteboardScene>("whiteboard_preview", { id }),
    create: (name: string, projectId?: string | null) =>
      call<T.Whiteboard>("whiteboard_create", { name, projectId: projectId ?? null }),
    update: (
      id: string,
      patch: { name?: string; pinned?: boolean; viewport?: T.Viewport; projectId?: string | null; sortOrder?: number },
    ) => call<T.Whiteboard>("whiteboard_update", { id, patch }),
    save: (id: string, nodes: T.WbNodeRecord[], edges: T.WbEdgeRecord[], viewport?: T.Viewport | null) =>
      call<void>("whiteboard_save", { id, nodes, edges, viewport: viewport ?? null }),
    /** Saves only what changed, so collaborators' edits are never overwritten. */
    patch: (id: string, patch: T.ScenePatch, viewport?: T.Viewport | null) => call<void>("whiteboard_patch", { id, patch, viewport: viewport ?? null }),
    duplicate: (id: string) => call<T.Whiteboard>("whiteboard_duplicate", { id }),
    import: (document: unknown, projectId?: string | null) =>
      call<T.Whiteboard>("whiteboard_import", { document, projectId: projectId ?? null }),
    delete: (id: string) => call<void>("whiteboard_delete", { id }),
    restore: (id: string) => call<void>("whiteboard_restore", { id }),
  },
  attachments: {
    list: (q: { taskId?: string; projectId?: string }) =>
      call<T.Attachment[]>("attachments_list", { taskId: q.taskId ?? null, projectId: q.projectId ?? null }),
    add: (sourcePath: string, target: { taskId?: string; projectId?: string }, managed = true) =>
      call<T.Attachment>("attachment_add", {
        sourcePath,
        taskId: target.taskId ?? null,
        projectId: target.projectId ?? null,
        managed,
      }),
    delete: (id: string) => call<void>("attachment_delete", { id }),
    addLink: (url: string, target: { taskId?: string; projectId?: string }, title?: string | null) =>
      call<T.Attachment>("attachment_add_link", { url, title: title ?? null, taskId: target.taskId ?? null, projectId: target.projectId ?? null }),
    rename: (id: string, name: string) => call<void>("attachment_rename", { id, name }),
    importAsset: (sourcePath: string) => call<T.StoredAsset>("asset_import", { sourcePath }),
    /** A managed file's bytes (base64), e.g. to compress a whiteboard image. */
    readBase64: (path: string) => call<string>("attachment_read_base64", { path }),
    importAssetBytes: (name: string, dataBase64: string) =>
      call<T.StoredAsset>("asset_import_bytes", { name, dataBase64 }),
  },
  dashboards: {
    list: () => call<T.Dashboard[]>("dashboards_list"),
    create: (name: string, widgets: T.WidgetInstance[], layouts: T.GridLayouts) =>
      call<T.Dashboard>("dashboard_create", { name, widgets, layouts }),
    update: (
      id: string,
      patch: { name?: string; widgets?: T.WidgetInstance[]; layouts?: T.GridLayouts; isDefault?: boolean; sortOrder?: number },
    ) => call<T.Dashboard>("dashboard_update", { id, patch }),
    delete: (id: string) => call<void>("dashboard_delete", { id }),
  },
  daily: {
    data: (args: {
      today: string;
      horizonEnd: string;
      dayStart: number;
      yesterdayStart: number;
      tomorrowStart: number;
      projectIds?: string[] | null;
    }) => call<T.RundownData>("rundown_data", { ...args, projectIds: args.projectIds ?? null }),
    getSnapshot: <D>(day: string, kind: T.SnapshotKind) =>
      call<T.Snapshot<D> | null>("snapshot_get", { day, kind }),
    saveSnapshot: (day: string, kind: T.SnapshotKind, data: unknown, replace = false) =>
      call<void>("snapshot_save", { day, kind, data, replace }),
    markViewed: (day: string, kind: T.SnapshotKind) => call<void>("snapshot_mark_viewed", { day, kind }),
    listSnapshots: (limit?: number) => call<T.SnapshotMeta[]>("snapshots_list", { limit: limit ?? null }),
  },
  focus: {
    record: (input: Omit<T.FocusSession, "id">) => call<T.FocusSession>("focus_record", { input }),
    list: (from: number, to: number) => call<T.FocusSession[]>("focus_sessions_list", { from, to }),
    schedule: (endAt: number, title: string, body: string) => call<void>("focus_schedule", { endAt, title, body }),
    cancel: () => call<void>("focus_cancel"),
  },
  activity: {
    list: (projectId?: string | null, limit?: number, before?: number) =>
      call<T.Activity[]>("activity_list", { projectId: projectId ?? null, limit: limit ?? null, before: before ?? null }),
  },
  recent: {
    list: (limit?: number) => call<T.RecentItem[]>("recent_list", { limit: limit ?? null }),
  },
  views: {
    list: () => call<T.SavedView[]>("views_list"),
    create: (name: string, filters: T.TaskFilters, icon?: string | null) =>
      call<T.SavedView>("view_create", { name, filters, icon: icon ?? null }),
    update: (id: string, patch: { name?: string; icon?: string; filters?: T.TaskFilters }) =>
      call<void>("view_update", { id, name: patch.name ?? null, icon: patch.icon ?? null, filters: patch.filters ?? null }),
    delete: (id: string) => call<void>("view_delete", { id }),
    reorder: (ids: string[]) => call<void>("views_reorder", { ids }),
  },
  search: (query: string, limit?: number, scope?: T.SearchScope) => call<T.SearchHit[]>("search", { query, limit: limit ?? null, scope: scope ?? null }),
  stats: {
    overview: (today: string, dayStart: number, weekStart: number) =>
      call<T.Overview>("stats_overview", { today, dayStart, weekStart }),
    completions: (from: number, to: number) => call<number[]>("stats_completions", { from, to }),
    dueCounts: (from: string, to: string) => call<[string, number, number][]>("stats_due_counts", { from, to }),
    storage: () => call<T.StorageStats>("storage_stats"),
  },
  storage: {
    /** Last scan result without scanning. */
    report: () => call<T.StorageReport | null>("storage_report"),
    scan: (includeLinked: boolean) => call<T.StorageReport>("storage_scan", { includeLinked }),
    cancel: () => call<void>("storage_scan_cancel"),
    /** Returns bytes freed. */
    cleanup: (what: T.StorageCleanup) => call<number>("storage_cleanup", { what }),
  },
  trash: {
    list: () => call<T.TrashItem[]>("trash_list"),
    purge: (kind: string, id: string) => call<void>("trash_purge", { kind, id }),
    empty: () => call<number>("trash_empty"),
  },
  data: {
    backupCreate: (destDir?: string | null) => call<T.BackupInfo>("backup_create", { destDir: destDir ?? null }),
    backupsList: () => call<T.BackupInfo[]>("backups_list"),
    backupPreview: (path: string) => call<T.RestorePreview>("backup_preview", { path }),
    backupRestore: (path: string) => call<T.BackupInfo>("backup_restore", { path }),
    backupDelete: (path: string) => call<void>("backup_delete", { path }),
    exportAll: (path: string) => call<T.BackupInfo>("export_all", { path }),
    exportTasksCsv: (path: string) => call<void>("export_tasks_csv", { path }),
    exportNotesMarkdown: (dir: string) => call<number>("export_notes_markdown", { dir }),
    exportProjectsJson: (path: string, ids?: string[] | null) =>
      call<void>("export_projects_json", { path, ids: ids ?? null }),
    dataDirSize: () => call<number>("data_dir_size"),
  },
  system: {
    info: () => call<T.AppInfo>("app_info"),
    checkForUpdate: () => call<T.UpdateInfo>("check_for_update"),
    releaseNotes: (version: string) => call<T.ReleaseNotes>("release_notes", { version }),
    open: (target: string) => call<void>("open_external", { target }),
    reveal: (path: string) => call<void>("reveal_path", { path }),
    exists: (path: string) => call<boolean>("path_exists", { path }),
    writeText: (path: string, contents: string) => call<void>("write_text_file", { path, contents }),
    writeBinary: (path: string, dataBase64: string) => call<void>("write_binary_file", { path, dataBase64 }),
    readText: (path: string) => call<string>("read_text_file", { path }),
    linkMetadata: (url: string) => call<T.LinkMetadata>("link_metadata", { url }),
    favicon: (url: string) => call<T.Favicon>("favicon_get", { url }),
    setTrayVisible: (visible: boolean) => call<void>("tray_set_visible", { visible }),
    quit: () => call<void>("quit_app"),
    showWindow: () => call<void>("show_main_window"),
  },
  /** Full Kern or Kern Lite, in the same window. */
  app: {
    mode: () => call<{ mode: "kern" | "lite"; ask: boolean }>("app_mode_get"),
    setMode: (mode: "kern" | "lite") => call<void>("app_mode_set", { mode }),
    pinLite: (on: boolean) => call<void>("app_lite_pin", { on }),
    /** Rebuilds the tray's Today list. */
    trayRefresh: () => call<void>("tray_refresh"),
  },
};
