/**
 * @Author Christian Relf
 * @Date 2026-10-12
 */

// Domain types mirroring the Rust command payloads (camelCase).

export type TaskStatus = "inbox" | "todo" | "in_progress" | "blocked" | "completed";
/** How a completed task was closed; null means done. */
export type TaskResolution = "cancelled" | "duplicate";
export type Priority = 0 | 1 | 2 | 3 | 4;

export interface Recurrence {
  freq: "daily" | "weekdays" | "weekly" | "monthly" | "yearly";
  interval: number;
  weekdays?: number[]; // ISO 1 (Mon) .. 7 (Sun)
  dayOfMonth?: number | null;
  fromCompletion?: boolean;
}

export interface Task {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  priority: Priority;
  projectId: string | null;
  columnId: string | null;
  parentId: string | null;
  dueDate: string | null;
  dueTime: string | null;
  startDate: string | null;
  estimateMinutes: number | null;
  trackedSeconds: number;
  sortOrder: number;
  boardOrder: number;
  pinned: boolean;
  recurrence: Recurrence | null;
  seriesId: string | null;
  reminderMinutes: number | null;
  completedAt: number | null;
  archivedAt: number | null;
  deletedAt: number | null;
  createdAt: number;
  updatedAt: number;
  labelIds: string[];
  subtaskCount: number;
  subtaskDone: number;
  attachmentCount: number;
  /** Linked GitHub issue. */
  issue?: { repo: string; number: number; url: string } | null;
  milestoneId?: string | null;
  /** Explicitly linked development resources. */
  devLinks?: DevLinkRef[];
  /** Set on completed tasks that were cancelled or closed as duplicates. */
  resolution?: TaskResolution | null;
  /** Open tasks that block this one. */
  blockedBy?: number;
  /** Time block: the day it's planned for and, optionally, when (HH:MM). Its length is the estimate. */
  planDate?: string | null;
  planTime?: string | null;
  commentCount?: number;
  /** Kern Cloud account that wrote the task, and its name at the time. Both
   *  are null for anything written offline. */
  createdBy?: string | null;
  createdByName?: string | null;
}

/** A relation from one task's point of view. */
export type TaskRelationKind = "blocks" | "blocked_by" | "related" | "duplicate_of" | "duplicated_by";

export interface TaskRelation {
  kind: TaskRelationKind;
  task: {
    id: string;
    title: string;
    status: TaskStatus;
    resolution: TaskResolution | null;
    priority: number;
    projectId: string | null;
  };
}

export interface DevLinkRef {
  kind: DevLinkKind;
  repositoryId: string | null;
  ref: string;
}

export interface TaskQuery {
  ids?: string[];
  projectIds?: string[];
  noProject?: boolean;
  statuses?: TaskStatus[];
  excludeStatuses?: TaskStatus[];
  minPriority?: number;
  priorities?: number[];
  labelIds?: string[];
  dueFrom?: string;
  dueTo?: string;
  /** Match a task whose start-to-due run touches [dueFrom, dueTo] at all. */
  dueOverlap?: boolean;
  hasDue?: boolean;
  overdueAsOf?: string;
  includeCompleted?: boolean;
  completedFrom?: number;
  completedTo?: number;
  search?: string;
  parentId?: string;
  topLevelOnly?: boolean;
  includeArchived?: boolean;
  pinned?: boolean;
  milestoneIds?: string[];
  noMilestone?: boolean;
  /** Time-blocked within [plannedFrom, plannedTo]. */
  plannedFrom?: string;
  plannedTo?: string;
  limit?: number;
  order?: TaskOrder;
}

export type TaskOrder = "manual" | "due" | "priority" | "created" | "updated" | "title" | "completed";

export interface TaskInput {
  title: string;
  description?: string;
  status?: TaskStatus;
  priority?: number;
  projectId?: string | null;
  columnId?: string | null;
  parentId?: string | null;
  dueDate?: string | null;
  dueTime?: string | null;
  startDate?: string | null;
  estimateMinutes?: number | null;
  pinned?: boolean;
  recurrence?: Recurrence | null;
  labelIds?: string[];
  reminderMinutes?: number | null;
  sortOrder?: number;
  boardOrder?: number;
  milestoneId?: string | null;
  planDate?: string | null;
  planTime?: string | null;
}

export interface TaskPatch {
  title?: string;
  description?: string;
  status?: TaskStatus;
  priority?: number;
  projectId?: string | null;
  columnId?: string | null;
  parentId?: string | null;
  dueDate?: string | null;
  dueTime?: string | null;
  startDate?: string | null;
  estimateMinutes?: number | null;
  reminderMinutes?: number | null;
  recurrence?: Recurrence | null;
  sortOrder?: number;
  boardOrder?: number;
  pinned?: boolean;
  archived?: boolean;
  labelIds?: string[];
  addLabelIds?: string[];
  removeLabelIds?: string[];
  addTrackedSeconds?: number;
  milestoneId?: string | null;
  resolution?: TaskResolution | null;
  planDate?: string | null;
  planTime?: string | null;
}

export interface TaskUpdateResult {
  task: Task;
  previous: Task;
  spawned: Task | null;
  /** Blocked tasks reopened because this was their last open blocker. */
  unblocked: Task[];
}

export interface Label {
  id: string;
  name: string;
  color: string | null;
  taskCount: number;
}

export type ProjectTab = "overview" | "tasks" | "board" | "whiteboard" | "notes" | "milestones" | "files" | "code" | "activity";

export interface Project {
  id: string;
  name: string;
  description: string;
  icon: string | null;
  accent: string | null;
  targetDate: string | null;
  groupId: string | null;
  pinned: boolean;
  sortOrder: number;
  defaultView: ProjectTab | null;
  hiddenTabs: ProjectTab[];
  defaultBoardId: string | null;
  lastOpenedAt: number | null;
  archivedAt: number | null;
  deletedAt: number | null;
  createdAt: number;
  updatedAt: number;
  taskTotal: number;
  taskDone: number;
  taskOverdue: number;
  taskDueSoon: number;
  lastActivityAt: number | null;
  /** Linked folder (canonical path) and its trust; availability via api.folders.get. */
  folderPath: string | null;
  folderTrust: Trust | null;
  aiPrefs: ProjectAiPrefs;
  /** Connected GitHub repository, "owner/name". */
  githubRepo: string | null;
  /** When the project was opened before the current visit. */
  prevOpenedAt: number | null;
  /** Set while the project needs a passkey to open. */
  lockedAt: number | null;
  /** Opened with a passkey this session. With `lockedAt` set and this false,
   *  the counts and folder above are blanked and the content is withheld. */
  unlocked: boolean;
}

export type Trust = "trusted" | "restricted";

export interface ProjectAiPrefs {
  /** Use the global routing settings (default true). */
  inherit?: boolean;
  accountId?: string | null;
  model?: string | null;
  /** Allow AI features to read this project's linked folder. */
  fileAccess?: boolean;
  /** Allow AI features (catch-up) to use this project's tasks, notes and activity. Default true. */
  contentAccess?: boolean;
}

export interface FolderInfo {
  path: string;
  name: string;
  trust: Trust | null;
  linkedProjects: string[];
}

export interface FolderCapabilities {
  browse: boolean;
  openDocuments: boolean;
  openPrograms: boolean;
  modify: boolean;
  aiFiles: boolean;
  aiFilesReason: string | null;
}

export interface ProjectFolder {
  projectId: string;
  path: string;
  name: string;
  status: "ok" | "missing" | "not_directory" | "inaccessible";
  trust: Trust;
  capabilities: FolderCapabilities;
  linkedAt: number;
}

export interface FileEntry {
  name: string;
  rel: string;
  isDir: boolean;
  isLink: boolean;
  size: number | null;
  modified: number | null;
  program: boolean;
  sensitive: boolean;
  hidden: boolean;
}

export interface FileText {
  /** Line endings normalised to "
". */
  text: string;
  crlf: boolean;
  bom: boolean;
  modified: number | null;
  size: number;
  readOnly: boolean;
}

export interface FileKindCount {
  /** Lower-case extension, or the lower-case name of a file without one. */
  key: string;
  count: number;
}

export interface DirListing {
  rel: string;
  entries: FileEntry[];
  truncated: boolean;
}

export interface TrustRecord {
  path: string;
  trust: Trust;
  decidedAt: number;
  projects: string[];
  exists: boolean;
}

export interface ProjectInput {
  name: string;
  description?: string;
  icon?: string | null;
  accent?: string | null;
  targetDate?: string | null;
  groupId?: string | null;
  defaultView?: ProjectTab | null;
  folder?: { path: string; trust: Trust } | null;
}

export interface ProjectPatch {
  name?: string;
  description?: string;
  icon?: string | null;
  accent?: string | null;
  targetDate?: string | null;
  groupId?: string | null;
  pinned?: boolean;
  defaultView?: ProjectTab | null;
  hiddenTabs?: ProjectTab[];
  archived?: boolean;
  sortOrder?: number;
  aiPrefs?: ProjectAiPrefs;
}

export interface ProjectGroup {
  id: string;
  name: string;
  sortOrder: number;
  collapsed: boolean;
}

export interface BoardSettings {
  cardDensity?: "compact" | "expanded";
  hiddenMeta?: string[];
  /** Opt-in card details that are off by default (milestone, branch). */
  showMeta?: string[];
  sort?: "manual" | "due" | "priority" | "created" | "title";
  groupBy?: "none" | "priority" | "label";
  background?: "plain" | "dots" | "lines" | "sunken";
  showCompleted?: boolean;
  filter?: {
    search?: string;
    priorities?: number[];
    labelIds?: string[];
    milestoneIds?: string[];
    repositoryIds?: string[];
    /** Only cards linked to a branch or worktree. */
    hasBranch?: boolean;
    /** Only the card of the active work session. */
    inSession?: boolean;
    due?: "overdue" | "week" | "none";
  };
}

export interface Board {
  id: string;
  projectId: string;
  name: string;
  sortOrder: number;
  settings: BoardSettings;
  isDefault: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface Column {
  id: string;
  boardId: string;
  name: string;
  sortOrder: number;
  status: TaskStatus | null;
  wipLimit: number | null;
  collapsed: boolean;
  width: number | null;
}

export interface BoardData {
  board: Board;
  columns: Column[];
  tasks: Task[];
}

export interface Note {
  id: string;
  title: string;
  content: string;
  projectId: string | null;
  pinned: boolean;
  archivedAt: number | null;
  deletedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface NoteMeta {
  id: string;
  title: string;
  excerpt: string;
  projectId: string | null;
  pinned: boolean;
  archivedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface InboxItem {
  id: string;
  kind: "idea" | "link" | "note";
  content: string;
  createdAt: number;
}

export interface Viewport {
  x: number;
  y: number;
  zoom: number;
}

export interface Whiteboard {
  id: string;
  projectId: string | null;
  name: string;
  pinned: boolean;
  sortOrder: number;
  viewport: Viewport | null;
  nodeCount: number;
  deletedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface WbNodeRecord {
  id: string;
  type: string;
  x: number;
  y: number;
  width: number | null;
  height: number | null;
  z: number;
  parentId: string | null;
  locked: boolean;
  data: Record<string, unknown>;
}

export interface WbEdgeRecord {
  id: string;
  source: string;
  target: string;
  sourceHandle: string | null;
  targetHandle: string | null;
  data: Record<string, unknown>;
}

export interface WhiteboardScene {
  whiteboard: Whiteboard;
  nodes: WbNodeRecord[];
  edges: WbEdgeRecord[];
}

export interface Attachment {
  id: string;
  taskId: string | null;
  projectId: string | null;
  name: string;
  path: string;
  absPath: string;
  managed: boolean;
  mime: string | null;
  size: number;
  exists: boolean;
  createdAt: number;
}

export interface StoredAsset {
  path: string;
  absPath: string;
  name: string;
  size: number;
}

export interface WidgetInstance {
  id: string;
  type: string;
  config: Record<string, unknown>;
  hidden?: boolean;
}

export interface GridItem {
  i: string;
  x: number;
  y: number;
  w: number;
  h: number;
  minW?: number;
  minH?: number;
}

export type GridLayouts = Record<string, GridItem[]>;

export interface Dashboard {
  id: string;
  name: string;
  sortOrder: number;
  isDefault: boolean;
  widgets: WidgetInstance[];
  layouts: GridLayouts;
  updatedAt: number;
}

export interface RundownData {
  overdue: Task[];
  today: Task[];
  upcoming: Task[];
  highPriority: Task[];
  inProgress: Task[];
  pinned: Task[];
  completedToday: Task[];
  completedYesterday: Task[];
  projects: Project[];
}

/** Rundown snapshots, plus the weekly review (stored on the week's first day). */
export type SnapshotKind = "morning" | "evening" | "weekly";

export interface Snapshot<T = unknown> {
  day: string;
  kind: SnapshotKind;
  data: T;
  createdAt: number;
  viewedAt: number | null;
}

export interface SnapshotMeta {
  day: string;
  kind: SnapshotKind;
  createdAt: number;
  viewedAt: number | null;
}

export interface Activity {
  id: number;
  projectId: string | null;
  entityType: string;
  entityId: string;
  action: string;
  summary: string;
  createdAt: number;
}

export interface FocusSession {
  id: string;
  taskId: string | null;
  kind: "focus" | "short_break" | "long_break";
  plannedSeconds: number;
  actualSeconds: number;
  startedAt: number;
  endedAt: number;
  completed: boolean;
}

export interface SavedView {
  id: string;
  name: string;
  icon: string | null;
  filters: TaskFilters;
  sortOrder: number;
}

/** User-facing filter model for task lists and saved views. */
export interface TaskFilters {
  projectIds?: string[];
  noProject?: boolean;
  statuses?: TaskStatus[];
  priorities?: number[];
  labelIds?: string[];
  due?: "any" | "overdue" | "today" | "week" | "next7" | "next30" | "none" | "dated";
  showCompleted?: boolean;
  search?: string;
  sort?: TaskOrder;
  group?: TaskGrouping;
  /** Second level of grouping inside each group. */
  subGroup?: TaskGrouping;
  /** List subtasks alongside top-level tasks. */
  showSubtasks?: boolean;
  /** Properties shown on rows in this view (overrides Appearance settings). */
  display?: Partial<TaskMeta>;
}

export type TaskGrouping = "none" | "project" | "due" | "priority" | "status" | "label" | "milestone";

export interface TaskMeta {
  project: boolean;
  due: boolean;
  priority: boolean;
  labels: boolean;
  subtasks: boolean;
  estimate: boolean;
  /** The author's picture at the end of the row (workspaces only). */
  creator: boolean;
}

export interface RecentItem {
  entityType: "project" | "note" | "whiteboard";
  entityId: string;
  title: string;
  projectId: string | null;
  openedAt: number;
}

export type SearchScope = "all" | "tasks" | "projects" | "notes" | "files" | "code" | "github" | "commands";

export interface SearchHit {
  kind: "task" | "project" | "note" | "board" | "whiteboard" | "wb_node" | "label" | "view" | "milestone" | "command" | "snapshot" | "issue" | "pull" | "commit";
  id: string;
  parentId: string | null;
  title: string;
  snippet: string;
  meta: string | null;
}

export interface Overview {
  openTasks: number;
  overdue: number;
  dueToday: number;
  inbox: number;
  activeProjects: number;
  completedToday: number;
  completedWeek: number;
}

export interface StorageStats {
  dbBytes: number;
  attachmentsBytes: number;
  attachmentsCount: number;
  tasks: number;
  projects: number;
  notes: number;
  whiteboards: number;
  whiteboardObjects: number;
  activityEntries: number;
  trashItems: number;
}

export interface TrashItem {
  kind: "project" | "task" | "note" | "whiteboard";
  id: string;
  title: string;
  projectId: string | null;
  deletedAt: number;
}

export interface ArchiveManifest {
  format: string;
  formatVersion: number;
  schemaVersion: number;
  appVersion: string;
  createdAt: number;
  kind: "auto" | "manual" | "pre-restore" | "export";
  counts: Record<string, number>;
  portable: boolean;
}

export interface BackupInfo {
  path: string;
  fileName: string;
  size: number;
  manifest: ArchiveManifest;
}

export interface RestorePreview {
  manifest: ArchiveManifest;
  valid: boolean;
  problems: string[];
  counts: Record<string, number>;
  hasAttachments: boolean;
}

export interface UpdateInfo {
  current: string;
  /** Newest release when newer than the running version. */
  latest: string | null;
  url: string;
  /** A newer release fixes a security issue: the update is required. */
  security: boolean;
}

export interface ReleaseNotes {
  version: string;
  name: string;
  /** Markdown, as written on the release page. */
  body: string;
  url: string;
  publishedAt: string | null;
}

export interface AppInfo {
  name: string;
  version: string;
  schemaVersion: number;
  dataDir: string;
  dbPath: string;
  attachmentsDir: string;
  defaultBackupsDir: string;
  platform: string;
  tauriVersion: string;
  launchedAtLogin: boolean;
}

export interface LinkMetadata {
  url: string;
  title: string | null;
  description: string | null;
  siteName: string | null;
  image: string | null;
}

export type StorageCategoryId = "database" | "attachments" | "whiteboard" | "backups" | "cache" | "logs" | "other";

export interface StorageCategory {
  id: StorageCategoryId;
  bytes: number;
  files: number;
}

export interface StorageLocation {
  id: string;
  label: string;
  path: string;
  exists: boolean;
}

export interface LinkedFolderUsage {
  projectId: string;
  projectName: string;
  path: string;
  bytes: number;
  files: number;
  complete: boolean;
  note: string | null;
}

export interface StorageReport {
  scannedAt: number;
  durationMs: number;
  totalBytes: number;
  totalFiles: number;
  categories: StorageCategory[];
  locations: StorageLocation[];
  skipped: number;
  linked: LinkedFolderUsage[] | null;
}

export type StorageCleanup = "favicons" | "expiredPreviews" | "temporary" | "unusedWhiteboardAssets";

// ------------------------------------------------------------ AI API accounts

export type AiProvider = "anthropic" | "openai";
export type AiStatus = "ready" | "rate_limited" | "quota_reached" | "auth_error" | "permission_error" | "unavailable" | "disabled" | "unknown";
export type AiErrorCategory =
  | "rate_limited"
  | "spend_limit"
  | "insufficient_quota"
  | "invalid_key"
  | "permission"
  | "model_unavailable"
  | "network"
  | "overloaded"
  | "timeout"
  | "invalid_request"
  | "unknown";

export interface AiAccount {
  id: string;
  provider: AiProvider;
  name: string;
  keyHint: string | null;
  enabled: boolean;
  priority: number;
  role: "primary" | "fallback" | "none";
  failoverEligible: boolean;
  preferredModel: string | null;
  models: string[];
  organizationId: string | null;
  projectRef: string | null;
  observedPool: string | null;
  budgetLimit: number | null;
  budgetUnit: "tokens" | "usd" | null;
  budgetWarnPercent: number;
  budgetHard: boolean;
  status: AiStatus;
  statusDetail: string | null;
  cooldownUntil: number | null;
  /** Provider-reported rate-limit headers at the time of the last response. */
  rateLimits: { headers?: Record<string, string>; observedAt?: number } | null;
  lastCheckedAt: number | null;
  lastUsedAt: number | null;
  createdAt: number;
  month: { requests: number; tokens: number; cost: number | null };
}

export interface AiAccountInput {
  provider: AiProvider;
  name: string;
  apiKey: string;
  organizationId?: string | null;
  projectRef?: string | null;
  preferredModel?: string | null;
}

export interface AiAccountPatch {
  name?: string;
  enabled?: boolean;
  role?: "primary" | "fallback" | "none";
  failoverEligible?: boolean;
  preferredModel?: string | null;
  organizationId?: string | null;
  projectRef?: string | null;
  budgetLimit?: number | null;
  budgetUnit?: "tokens" | "usd";
  budgetWarnPercent?: number;
  budgetHard?: boolean;
}

export interface AiValidation {
  outcome: "authenticated" | "auth_failed" | "permission" | "unavailable" | "rate_limited" | "quota" | "network" | "unknown";
  message: string;
  httpStatus: number | null;
  models: string[];
  pool: string | null;
}

export interface AiFailure {
  category: AiErrorCategory;
  httpStatus: number | null;
  code: string | null;
  message: string;
  retryAfter: number | null;
  replaySafe: boolean;
}

export interface AiRouteRequest {
  requestId: string;
  prompt: string;
  system?: string | null;
  maxTokens?: number;
  accountId?: string | null;
  model?: string | null;
  projectId?: string | null;
  replayable?: boolean;
  purpose?: string;
}

export interface AiRouteOutcome {
  ok: boolean;
  text: string | null;
  accountId: string | null;
  accountName: string | null;
  provider: AiProvider | null;
  model: string | null;
  usage: { inputTokens: number | null; outputTokens: number | null; cachedTokens: number | null } | null;
  estimatedCost: number | null;
  stopReason: string | null;
  attempts: { accountId: string; accountName: string; model: string; ok: boolean; category: AiErrorCategory | null; message: string | null; durationMs: number }[];
  switches: { from: string; to: string; reason: string }[];
  warnings: string[];
  error: AiFailure | null;
}

export interface AiBreakdown {
  key: string;
  label: string;
  requests: number;
  tokens: number;
  cost: number | null;
}

export interface AiUsageEvent {
  id: number;
  requestId: string;
  accountId: string | null;
  accountName: string | null;
  provider: AiProvider;
  model: string | null;
  purpose: string;
  attempt: number;
  startedAt: number;
  durationMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
  cachedTokens: number | null;
  success: boolean;
  errorCategory: string | null;
  httpStatus: number | null;
  estimatedCost: number | null;
}

export interface AiUsageSummary {
  days: { day: string; requests: number; failures: number; inputTokens: number; outputTokens: number }[];
  byProvider: AiBreakdown[];
  byModel: AiBreakdown[];
  byAccount: AiBreakdown[];
  requests: number;
  failures: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  cost: number | null;
  recent: AiUsageEvent[];
  failovers: { id: number; requestId: string; fromName: string | null; toName: string | null; reason: string; detail: string | null; createdAt: number }[];
}

export interface AiSecurityReport {
  store: string;
  accounts: number;
  keysPresent: number;
  missing: string[];
}

export interface Favicon {
  origin: string;
  /** Absolute path of the locally cached icon. */
  path: string | null;
  status: "ok" | "none" | "error" | "disabled";
}

export const LINK_MIME = "text/uri-list";

// ------------------------------------------------------------ git & GitHub

export interface GitRemoteInfo {
  isRepo: boolean;
  originUrl: string | null;
  /** owner/name when origin is on github.com */
  github: string | null;
}

export interface GitChangedFile {
  path: string;
  code: string;
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
  conflicted: boolean;
  renamedFrom: string | null;
}

export interface GitStatus {
  branch: string | null;
  detached: boolean;
  upstream: string | null;
  ahead: number;
  behind: number;
  files: GitChangedFile[];
}

export interface GitCommit {
  hash: string;
  short: string;
  author: string;
  date: string;
  subject: string;
  /** Parent hashes, first parent first. */
  parents: string[];
  /** Full decorations: "HEAD -> refs/heads/main", "refs/remotes/origin/main", "tag: refs/tags/v1.0". */
  refs: string[];
}

export interface GitBranch {
  name: string;
  remote: boolean;
  current: boolean;
  upstream: string | null;
  shortHash: string;
  date: string;
}

export interface TodoItem {
  path: string;
  line: number;
  kind: string;
  text: string;
}

export interface GithubStatus {
  connected: boolean;
  login: string | null;
  source: "cli" | "token" | null;
  cliInstalled: boolean;
  cliSignedIn: boolean;
  hasToken: boolean;
  error: string | null;
}

export interface RepoSummary {
  fullName: string;
  description: string | null;
  private: boolean;
  defaultBranch: string | null;
  htmlUrl: string;
  openIssues: number;
  updatedAt: string | null;
  archived?: boolean;
  fork?: boolean;
  language?: string | null;
}

export interface GithubOrg {
  login: string;
  description: string | null;
  avatarUrl: string | null;
  /** The signed-in user's own account. */
  personal: boolean;
}

export interface ProjectRepo {
  projectId: string;
  owner: string;
  name: string;
  fullName: string;
  defaultBranch: string | null;
  htmlUrl: string | null;
  syncIssues: boolean;
  importClosed: boolean;
  lastSyncedAt: number | null;
  lastSyncError: string | null;
  linkedIssues: number;
}

export interface SyncReport {
  imported: number;
  updatedInKern: number;
  updatedOnGithub: number;
  unchanged: number;
  errors: string[];
}

export interface PullInfo {
  number: number;
  title: string;
  htmlUrl: string;
  draft: boolean;
  author: string;
  head: string;
  base: string;
  updatedAt: string;
  checks: "success" | "failure" | "pending" | "none";
  review: "approved" | "changes_requested" | "commented" | "none";
  linkedIssues: number[];
  linkedTasks: { id: string; title: string; done: boolean }[];
}

export interface RepoOverview {
  fullName: string;
  description: string | null;
  htmlUrl: string;
  defaultBranch: string | null;
  private: boolean;
  stars: number;
  forks: number;
  openIssues: number;
  pushedAt: string | null;
  languages: [string, number][];
  readme: string | null;
  readmeSource: "local" | "github" | null;
}

// ------------------------------------------------------------ phase 3: repositories & git

export interface Repository {
  id: string;
  projectId: string;
  name: string;
  alias: string | null;
  localPath: string | null;
  github: string | null;
  isPrimary: boolean;
  sortOrder: number;
  localStatus: "ok" | "missing" | "not_repo" | "none";
  trust: Trust | null;
  issueSync: boolean;
  createdAt: number;
}

export interface RepoSummaryInfo {
  repositoryId: string;
  available: boolean;
  reason: string | null;
  branch: string | null;
  detached: boolean;
  upstream: string | null;
  ahead: number;
  behind: number;
  changed: number;
  untracked: number;
  conflicted: number;
  lastCommit: GitCommit | null;
}

export interface BranchCheck {
  valid: boolean;
  exists: boolean;
  message: string | null;
}

export interface Worktree {
  repositoryId: string;
  id: string | null;
  path: string;
  name: string;
  alias: string | null;
  branch: string | null;
  head: string | null;
  detached: boolean;
  isMain: boolean;
  locked: string | null;
  prunable: boolean;
  taskId: string | null;
  taskTitle: string | null;
  agent: string | null;
  createdByKern: boolean;
  trust: Trust | null;
  changed: number | null;
  untracked: number | null;
  ahead: number | null;
  behind: number | null;
  lastActivity: number | null;
}

export interface WorktreeInput {
  repositoryId: string;
  branch: string;
  newBranch: boolean;
  base?: string | null;
  path?: string | null;
  taskId?: string | null;
  alias?: string | null;
  trust: boolean;
}

export interface WorktreeInspection {
  path: string;
  exists: boolean;
  isMain: boolean;
  locked: string | null;
  branch: string | null;
  modified: string[];
  untracked: string[];
  modifiedCount: number;
  untrackedCount: number;
  unpushed: number | null;
  merged: boolean | null;
  inUse: string[];
}

export type DevLinkKind = "repository" | "branch" | "worktree" | "pull" | "commit";

export interface DevLink {
  id: string;
  taskId: string;
  kind: DevLinkKind;
  repositoryId: string | null;
  repositoryName: string | null;
  ref: string;
  title: string | null;
  url: string | null;
  createdAt: number;
}

export interface LinkedPull {
  repository: string;
  number: number;
  title: string;
  url: string;
  head: string;
  checks: PullInfo["checks"];
  review: PullInfo["review"];
  draft: boolean;
  inferred: boolean;
}

export interface TaskDevContext {
  links: DevLink[];
  pulls: LinkedPull[];
  sessionSeconds: number;
  sessionCount: number;
  activeSessionId: string | null;
}

// ------------------------------------------------------------ sessions

export interface SessionLink {
  id: string;
  kind: "commit" | "pull" | "issue";
  repositoryId: string | null;
  ref: string;
  title: string | null;
  url: string | null;
}

export interface WorkSession {
  id: string;
  projectId: string | null;
  projectName: string | null;
  taskId: string | null;
  taskTitle: string | null;
  repositoryId: string | null;
  repositoryName: string | null;
  branch: string | null;
  worktreeId: string | null;
  milestoneId: string | null;
  milestoneTitle: string | null;
  note: string;
  startedAt: number;
  endedAt: number | null;
  pausedMs: number;
  pausedAt: number | null;
  lastSeenAt: number;
  status: "running" | "paused" | "ended";
  elapsedMs: number;
  gapMs: number | null;
  links: SessionLink[];
}

export interface SessionInput {
  projectId?: string | null;
  taskId?: string | null;
  repositoryId?: string | null;
  branch?: string | null;
  worktreeId?: string | null;
  milestoneId?: string | null;
  note?: string | null;
}

export interface SessionBucket {
  key: string | null;
  label: string;
  ms: number;
  sessions: number;
}

export interface SessionReport {
  totalMs: number;
  sessions: number;
  byDay: SessionBucket[];
  byProject: SessionBucket[];
  byTask: SessionBucket[];
}

// ------------------------------------------------------------ workspace

export interface WorkspaceSnapshot {
  id: string;
  projectId: string;
  name: string;
  state: WorkspaceState;
  createdAt: number;
  updatedAt: number;
}

/** Lightweight per-project UI context (ids, paths, viewport), never content. */
export interface WorkspaceState {
  tab?: ProjectTab;
  boardId?: string | null;
  whiteboardId?: string | null;
  taskId?: string | null;
  noteId?: string | null;
  repositoryId?: string | null;
  worktreePath?: string | null;
  codeSection?: string | null;
  openFile?: { rel: string; repositoryId?: string | null } | null;
  files?: { rel: string; repositoryId?: string | null }[];
  terminals?: { title: string; cwd: string; shell: string }[];
  terminalOpen?: boolean;
  terminalHeight?: number;
  inspectorWidth?: number;
  savedAt?: number;
}

export interface ProjectLayout {
  projectId: string;
  preset: string | null;
  widgets: WidgetInstance[];
  layouts: GridLayouts;
  updatedAt: number;
}

export interface ProjectCapabilities {
  hasFolder: boolean;
  repositories: number;
  localRepositories: number;
  githubRepositories: number;
  issueSync: boolean;
  commands: number;
  services: number;
  envProfiles: number;
  milestones: number;
  worktrees: number;
  aiAccounts: number;
}

// ------------------------------------------------------------ milestones

export type MilestoneStatus = "planned" | "active" | "completed" | "cancelled";

export interface ReleaseLink {
  id: string;
  kind: "pull" | "issue";
  ref: string;
  title: string | null;
  url: string | null;
}

export interface Milestone {
  id: string;
  projectId: string;
  title: string;
  description: string;
  targetDate: string | null;
  status: MilestoneStatus;
  progressMode: "tasks" | "manual";
  manualProgress: number;
  isRelease: boolean;
  version: string | null;
  repositoryId: string | null;
  releaseNotes: string;
  releaseUrl: string | null;
  sortOrder: number;
  completedAt: number | null;
  createdAt: number;
  updatedAt: number;
  taskTotal: number;
  taskDone: number;
  progress: number;
  overdue: boolean;
  dependsOn: string[];
  blockedBy: string[];
  links: ReleaseLink[];
}

export interface MilestoneInput {
  projectId: string;
  title: string;
  description?: string;
  targetDate?: string | null;
  status?: MilestoneStatus;
  isRelease?: boolean;
  version?: string | null;
  repositoryId?: string | null;
}

export interface MilestonePatch {
  title?: string;
  description?: string;
  targetDate?: string | null;
  status?: MilestoneStatus;
  progressMode?: "tasks" | "manual";
  manualProgress?: number;
  isRelease?: boolean;
  version?: string | null;
  repositoryId?: string | null;
  releaseNotes?: string;
  releaseUrl?: string | null;
  sortOrder?: number;
}

// ------------------------------------------------------------ environment, commands, terminal

export interface Tech {
  id: string;
  name: string;
  kind: "language" | "framework" | "runtime" | "tool" | "engine" | "package-manager";
  evidence: string;
}

export interface DetectedCommand {
  name: string;
  program: string;
  args: string[];
  cwd: string;
  category: "dev" | "build" | "test" | "lint" | "preview" | "run" | "other";
  source: string;
  detail: string | null;
}

export interface Runtime {
  id: string;
  name: string;
  program: string;
  available: boolean;
  path: string | null;
  helpUrl: string;
}

export interface DevEnvironment {
  root: string;
  techs: Tech[];
  packageManager: string | null;
  commands: DetectedCommand[];
  runtimes: Runtime[];
  branch: string | null;
  scannedDirs: number;
}

export interface SavedCommand {
  id: string;
  projectId: string;
  repositoryId: string | null;
  name: string;
  program: string;
  args: string[];
  cwd: string;
  envProfileId: string | null;
  confirm: boolean;
  pinned: boolean;
  sortOrder: number;
}

export interface CommandInput {
  id?: string | null;
  projectId: string;
  repositoryId?: string | null;
  name: string;
  program: string;
  args: string[];
  cwd: string;
  envProfileId?: string | null;
  confirm: boolean;
  pinned: boolean;
}

export interface Shell {
  id: string;
  name: string;
  program: string;
  args: string[];
}

export type CwdTarget =
  | { kind: "project"; projectId: string; rel?: string | null }
  | { kind: "repository"; repositoryId: string; rel?: string | null }
  | { kind: "worktree"; repositoryId: string; path: string }
  | { kind: "default" };

export interface RunSpec {
  commandId?: string | null;
  program?: string | null;
  args?: string[];
  envProfileId?: string | null;
}

export interface PtySpawnInput {
  cwd: CwdTarget;
  shell?: string | null;
  run?: RunSpec | null;
  projectId?: string | null;
  title?: string | null;
  cols: number;
  rows: number;
}

export interface PtyInfo {
  id: string;
  title: string;
  projectId: string | null;
  cwd: string;
  shell: string;
  command: string | null;
  commandId: string | null;
  startedAt: number;
  exitCode: number | null;
  running: boolean;
}

export interface EnvVar {
  id: string;
  profileId: string;
  name: string;
  kind: "plain" | "secret" | "inherit";
  value: string | null;
  hasSecret: boolean;
}

export interface EnvProfile {
  id: string;
  projectId: string;
  name: string;
  variables: EnvVar[];
}

export interface EnvVarInput {
  profileId: string;
  id?: string | null;
  name: string;
  kind: EnvVar["kind"];
  value?: string | null;
}

// ------------------------------------------------------------ services

export interface ServiceCheck {
  status: ServiceStatus;
  latencyMs: number | null;
  detail: string | null;
  checkedAt: number;
}

export type ServiceStatus = "running" | "stopped" | "degraded" | "unknown";

export interface LocalService {
  id: string;
  projectId: string;
  name: string;
  url: string;
  healthPath: string | null;
  expectStatus: string | null;
  expectText: string | null;
  commandId: string | null;
  repositoryId: string | null;
  intervalSecs: number;
  enabled: boolean;
  status: ServiceStatus;
  healthy: boolean | null;
  detail: string | null;
  latencyMs: number | null;
  checkedAt: number | null;
  history: ServiceCheck[];
}

export interface ServiceInput {
  id?: string | null;
  projectId: string;
  name: string;
  url: string;
  healthPath?: string | null;
  expectStatus?: string | null;
  expectText?: string | null;
  commandId?: string | null;
  repositoryId?: string | null;
  intervalSecs?: number;
  enabled?: boolean;
}

export interface Container {
  id: string;
  name: string;
  image: string;
  state: string;
  status: string;
  ports: string;
}

// ------------------------------------------------------------ dependencies

export interface DepPackage {
  name: string;
  ecosystem: string;
  declared: string | null;
  resolved: string | null;
  direct: boolean | null;
  group: "prod" | "dev" | "peer" | "optional" | "build";
  manifest: string;
}

export interface DepManifest {
  path: string;
  ecosystem: string;
  lockfile: string | null;
}

export interface DepReport {
  root: string;
  scannedAt: number;
  manifests: DepManifest[];
  packages: DepPackage[];
  edges: [string, string][];
  truncated: boolean;
}

export interface Advisory {
  id: string;
  summary: string | null;
  aliases: string[];
  severity: string | null;
  affected: string | null;
  fixed: string | null;
  url: string;
}

export interface AdvisoryFinding {
  name: string;
  ecosystem: string;
  version: string;
  advisories: Advisory[];
}

export interface AdvisoryReport {
  checkedAt: number;
  checked: number;
  unchecked: number;
  findings: AdvisoryFinding[];
  source: string;
}

// ------------------------------------------------------------ health & catch-up

export interface HealthPrefs {
  overdue: boolean;
  blocked: boolean;
  dueSoon: boolean;
  dueSoonDays: number;
  milestones: boolean;
  stale: boolean;
  staleDays: number;
  ci: boolean;
  workflows: string[];
  pulls: boolean;
  dependencies: boolean;
  services: boolean;
  repositories: string[];
}

export interface HealthItem {
  key: string;
  label: string;
  count: number;
  severity: "info" | "warning" | "critical";
  target: "tasks" | "milestones" | "build" | "pulls" | "dependencies" | "services";
  targetRef: string | null;
}

export interface ProjectHealth {
  state: "on_track" | "needs_attention" | "blocked" | "no_data";
  items: HealthItem[];
  prefs: HealthPrefs;
  checkedAt: number;
}

export interface CatchupInclude {
  tasks: boolean;
  notes: boolean;
  milestones: boolean;
  sessions: boolean;
  commits: boolean;
  github: boolean;
}

export interface CatchupSource {
  id: string;
  kind: "task" | "note" | "milestone" | "commit" | "pull" | "issue" | "run" | "session";
  refId: string;
  title: string;
  detail: string | null;
  url: string | null;
  repositoryId: string | null;
  at: number | null;
  category: string;
}

export interface CatchupLine {
  text: string;
  sources: string[];
}

export interface CatchupDigest {
  projectId: string;
  projectName: string;
  from: number;
  to: number;
  whatChanged: CatchupLine[];
  completed: CatchupLine[];
  needsAttention: CatchupLine[];
  nextSteps: CatchupLine[];
  sources: CatchupSource[];
  counts: Record<string, number>;
}

export interface CatchupPreview {
  categories: [string, number][];
  sources: number;
  chars: number;
  approxTokens: number;
  allowed: boolean;
  blockedReason: string | null;
}

export interface CatchupAi {
  whatChanged: CatchupLine[];
  completed: CatchupLine[];
  needsAttention: CatchupLine[];
  nextSteps: CatchupLine[];
  sources: CatchupSource[];
  dropped: number;
  model: string | null;
  accountName: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  estimatedCost: number | null;
}

// ------------------------------------------------------------ GitHub (more)

export interface WorkflowRun {
  id: number;
  workflowId: number;
  workflow: string;
  title: string;
  branch: string;
  event: string;
  status: string;
  conclusion: string | null;
  htmlUrl: string;
  createdAt: string;
  runNumber: number;
  actor: string;
  headSha: string;
}

export interface ActionsOverview {
  repository: string;
  defaultBranch: string | null;
  latest: WorkflowRun[];
  recent: WorkflowRun[];
}

export interface IssueSummary {
  number: number;
  title: string;
  htmlUrl: string;
  state: string;
  labels: string[];
  author: string;
  comments: number;
  updatedAt: string;
  taskId: string | null;
}

export interface RemoteCommit {
  sha: string;
  short: string;
  subject: string;
  author: string;
  date: string;
  htmlUrl: string;
}

export interface CachedGithub {
  repository: string;
  pulls: PullInfo[] | null;
  actions: ActionsOverview | null;
  issues: IssueSummary[] | null;
  commits: RemoteCommit[] | null;
  fetchedAt: number | null;
}

// ------------------------------------------------------------ file search

export interface FileHit {
  projectId: string;
  repositoryId: string | null;
  root: string;
  rel: string;
  name: string;
  snippet: string | null;
}

export interface IndexStats {
  roots: number;
  files: number;
  updated: number;
  removed: number;
  incomplete: boolean;
}

export interface IndexStatus {
  roots: number;
  indexed: number;
  files: number;
  indexing: boolean;
  stale: boolean;
}

// ------------------------------------------------------------ Kern Cloud

export interface CloudAccount {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  image: string | null;
}

export type SpaceKind = "personal" | "workspace";
export type SpaceRole = "owner" | "admin" | "member" | "viewer";

export interface ActiveSpace {
  id: string;
  kind: SpaceKind;
  name: string;
}

export type SyncState = "off" | "idle" | "syncing" | "offline" | "error" | "signed_out" | "read_only";

export interface SyncStatus {
  state: SyncState;
  pending: number;
  lastSyncedAt: number | null;
  message: string | null;
}

/**
 * A Kern Cloud server this copy of Kern knows about.
 *
 * Kern Cloud is a server, not a service: the same code runs at the public
 * address and on somebody's own machine. The list lives in a file only the
 * back end writes - see `domain/cloud/servers.rs` for why it isn't a setting.
 */
export interface CloudServer {
  /** The API base, e.g. `https://kern.example.com/kern/v1`. */
  url: string;
  /** What to call it here. */
  name: string;
  /** The instance's own name, from its `/instance` reply when it was added. */
  instanceName: string | null;
  addedAt: number | null;
}

/** Where the choice of server came from. */
export type ServerSource = "environment" | "chosen" | "default";

/** The server in use, and whether the choice can be changed in the app. */
export interface ActiveServer {
  url: string;
  source: ServerSource;
  name: string;
}

/** What sign-ups a server allows. */
export type Registration = "open" | "invite" | "closed";

/** A server's answer to `GET /instance`, before any account exists. */
export interface ServerCheck {
  url: string;
  name: string;
  protocol: number;
  registration: Registration;
  /** A note from this server's administrator, for the sign-in screen. */
  notice: string | null;
  contact: string | null;
  /** Whether the server can actually send a verification code. */
  sendsEmail: boolean;
  /** Set when the address is allowed but not encrypted. */
  warning: string | null;
  /** True when it is already in the list. */
  added: boolean;
}

export interface CloudInfo {
  apiUrl: string;
  wsUrl: string;
  signedIn: boolean;
  account: CloudAccount | null;
  active: ActiveSpace | null;
  sync: SyncStatus;
  /** Which server this is, and whether the choice can be changed here. */
  server: ActiveServer;
}

export type TeamSize = "just-me" | "2-10" | "11-50" | "51-200" | "201-1000" | "1000+";

export interface Space {
  id: string;
  kind: SpaceKind;
  name: string;
  slug: string | null;
  description: string;
  logo: string | null;
  accent: string | null;
  website: string | null;
  industry: string | null;
  teamSize: TeamSize | null;
  useCase: string | null;
  timezone: string | null;
  githubOrg: string | null;
  githubSyncedAt: string | null;
  settings: Record<string, unknown>;
  ownerId: string;
  role: SpaceRole;
  head: number;
  memberCount?: number;
  createdAt: string;
  updatedAt: string;
}

export type InviteStatus = "pending" | "accepted" | "declined" | "revoked" | "expired";

export interface Invite {
  id: string;
  spaceId: string;
  email: string;
  role: Exclude<SpaceRole, "owner">;
  message: string | null;
  invitedBy: string | null;
  inviterName: string | null;
  createdAt: string;
  expiresAt: string;
  lastSentAt: string | null;
  sendCount: number;
  status: InviteStatus;
  link: string;
  /** Present on invitations addressed to the signed-in user. */
  workspace?: string;
  logo?: string | null;
}

export interface InviteSummary {
  id: string;
  workspace: string;
  logo: string | null;
  inviterName: string | null;
  role: Exclude<SpaceRole, "owner">;
  emailHint: string;
  expiresAt: string;
  status: InviteStatus;
}

export interface Me {
  user: CloudAccount & { createdAt: string | null };
  personal: Space | null;
  workspaces: Space[];
  invites: Invite[];
}

export interface Member {
  userId: string;
  role: SpaceRole;
  title: string | null;
  joinedAt: string;
  name: string;
  email: string;
  image: string | null;
}

export interface WorkspaceDetail {
  workspace: Space;
  members: Member[];
  invites: Invite[];
}

export interface InviteResult {
  email: string;
  ok: boolean;
  reason?: string;
  invite?: Invite;
}

export interface AuditEntry {
  id: number;
  action: string;
  detail: Record<string, unknown>;
  at: string;
  actor: string | null;
}

export interface RemoteChange {
  seq: number;
  t: string;
  id: string;
  op: "upsert" | "delete";
  data: Record<string, unknown> | null;
}

export interface OfflineSummary {
  projects: [string, string][];
  counts: Record<string, number>;
}

export interface ScenePatch {
  nodes: WbNodeRecord[];
  removedNodes: string[];
  edges: WbEdgeRecord[];
  removedEdges: string[];
}

// ------------------------------------------------------------ Kern Cloud streams

export type StreamAction = "task" | "inbox" | "issue" | "task_issue";
export type StreamAuth = "public" | "token" | "signature";
export type StreamFieldType = "text" | "long_text" | "email" | "url" | "number" | "boolean" | "choice";
export type StreamEventStatus = "delivered" | "partial" | "rejected" | "duplicate" | "spam" | "failed";

export interface StreamField {
  key: string;
  label: string;
  type: StreamFieldType;
  required: boolean;
  /** 0 = the type's default. */
  maxLength: number;
  options: string[];
  hidden: boolean;
}

export interface StreamConfig {
  action: StreamAction;
  task: {
    projectId: string | null;
    columnId: string | null;
    status: Exclude<TaskStatus, "completed">;
    priority: number;
    priorityField: string | null;
    priorityMap: Record<string, number>;
    labelIds: string[];
    dueInDays: number | null;
  };
  templates: { title: string; titleFallback: string; body: string; footer: boolean; includeJson: boolean };
  fields: { mode: "lenient" | "strict"; list: StreamField[] };
  github: { repo: string | null; labels: string[]; assignees: string[]; linkToTask: boolean; neutralizeMentions: boolean };
  security: {
    auth: StreamAuth;
    allowedOrigins: string[];
    requireOrigin: boolean;
    ipAllowlist: string[];
    blockedSenders: string[];
    honeypotField: string | null;
    turnstile: boolean;
    turnstileSiteKey: string | null;
    signatureToleranceSec: number;
    maxBodyKb: number;
    allowFormPosts: boolean;
    rateLimit: { perMinute: number; perHour: number; streamPerHour: number };
    dedupeMinutes: number;
    escapeMarkdown: boolean;
  };
  responses: { successMessage: string; redirectUrl: string | null; returnIds: boolean };
  notify: { app: boolean; email: "off" | "each" | "failures"; emailTo: "creator" | "admins" };
  /** Email to this stream: <alias>@<domain>. The server picks the alias. */
  email?: { enabled: boolean; alias: string | null; allowedSenders: string[] };
  log: { storePayloads: boolean; retentionDays: number };
}

export interface Stream {
  id: string;
  spaceId: string;
  url: string;
  name: string;
  description: string;
  enabled: boolean;
  config: StreamConfig;
  secretHint: string;
  previousSecretExpiresAt: string | null;
  github: { tokenSet: boolean; tokenHint: string | null; checkedAt: string | null };
  turnstile: { secretSet: boolean };
  /** The stream's email address (when email is on and the server accepts mail). */
  email?: { available: boolean; address: string | null };
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  lastDeliveryAt: string | null;
  deliveryCount: number;
  last24h?: { total: number; problems: number };
}

export interface StreamList {
  streams: Stream[];
  presets: { id: string; description: string }[];
  limit: number;
  baseUrl: string;
  docsUrl: string;
}

export interface StreamDetail {
  stream: Stream;
  stats: {
    last24h: Partial<Record<StreamEventStatus, number>>;
    last7d: Partial<Record<StreamEventStatus, number>>;
    daily: { day: string; status: StreamEventStatus; n: number }[];
  };
}

export interface StreamEvent {
  id: number;
  receivedAt: string;
  status: StreamEventStatus;
  code: string | null;
  message: string | null;
  test: boolean;
  auth: string | null;
  sender: string | null;
  origin: string | null;
  userAgent: string | null;
  contentType: string | null;
  idempotencyKey: string | null;
  taskId: string | null;
  inboxId: string | null;
  issue: { number: number; url: string } | null;
  durationMs: number | null;
  hasPayload: boolean;
  payload?: Record<string, unknown> | null;
}

export interface StreamPreview {
  valid: boolean;
  errors: Record<string, string>;
  payload: Record<string, unknown>;
  title: string;
  body: string;
  githubBody: string;
}

export interface StreamOutcome {
  eventId: number;
  status: "delivered" | "partial" | "failed";
  code: string | null;
  message: string | null;
  title: string;
  taskId: string | null;
  inboxId: string | null;
  issue: { number: number; url: string } | null;
  notes: string[];
}

export interface GithubRepoCheck {
  fullName: string;
  private: boolean;
  hasIssues: boolean;
  htmlUrl: string;
}

// ------------------------------------------------------------ comments

export interface TaskComment {
  id: string;
  taskId: string;
  authorId: string | null;
  authorName: string;
  /** Plain text; mentions are written as @[Name](user-id). */
  body: string;
  mentions: string[];
  createdAt: number;
  updatedAt: number;
  editedAt: number | null;
  /** Written by whoever is using Kern here (always true offline). */
  mine: boolean;
}

export interface Mention {
  commentId: string;
  taskId: string;
  taskTitle: string;
  authorName: string;
  excerpt: string;
  createdAt: number;
}

// ------------------------------------------------------------ templates

export type TemplateKind = "project" | "note" | "task";

export interface TemplateMeta {
  id: string;
  kind: TemplateKind;
  name: string;
  description: string;
  icon: string | null;
  builtin: boolean;
  summary: string;
  updatedAt: number;
}

export interface Template extends TemplateMeta {
  data: Record<string, unknown>;
}

// ------------------------------------------------------------ habits

export interface Habit {
  id: string;
  name: string;
  icon: string | null;
  color: string | null;
  cadence: "daily" | "weekly";
  target: number;
  /** ISO weekdays (1 = Monday) a daily habit is due on. */
  weekdays: number[];
  sortOrder: number;
  archivedAt: number | null;
  createdAt: number;
  /** Day (YYYY-MM-DD) → times done, in the requested range. */
  checks: Record<string, number>;
  streak: number;
  bestStreak: number;
  /** Done today (daily) or this week (weekly). */
  progress: number;
  done: boolean;
  dueToday: boolean;
  /** Share of due periods met in the last 30 days. */
  rate: number;
}

export interface HabitInput {
  name: string;
  icon?: string | null;
  color?: string | null;
  cadence?: "daily" | "weekly";
  target?: number;
  weekdays?: number[];
}

export interface HabitPatch extends Partial<HabitInput> {
  archived?: boolean;
}

// ------------------------------------------------------------ calendars

export interface CalendarFeed {
  id: string;
  name: string;
  url: string;
  color: string | null;
  enabled: boolean;
  lastFetchedAt: number | null;
  lastError: string | null;
  eventCount: number;
}

export interface CalEvent {
  feedId: string;
  feedName: string;
  color: string | null;
  uid: string;
  /** 'YYYY-MM-DD' (all day) or 'YYYY-MM-DDTHH:MM', local time. */
  start: string;
  /** Inclusive last day (all day) or end time. */
  end: string;
  allDay: boolean;
  title: string;
  location: string | null;
}

export interface IcsExportOptions {
  projectIds?: string[] | null;
  includeCompleted?: boolean;
  includeMilestones?: boolean;
  includePlanned?: boolean;
}

/** A Kern Cloud calendar address for the open space. */
export interface CloudCalendarFeed {
  url: string;
  options: { includeMilestones?: boolean; projectIds?: string[] | null };
  createdAt: string;
  lastFetchedAt: string | null;
}

// ------------------------------------------------------------ review & estimates

export interface EstimateRow {
  taskId: string;
  title: string;
  projectId: string | null;
  estimateMinutes: number;
  actualMinutes: number;
  ratio: number;
  completedAt: number | null;
}

export interface EstimateStats {
  count: number;
  totalEstimateMinutes: number;
  totalActualMinutes: number;
  medianRatio: number | null;
  onTarget: number;
  over: number;
  under: number;
  untracked: number;
  misses: EstimateRow[];
}

export interface WeekReview {
  weekStart: string;
  weekEnd: string;
  completed: Task[];
  cancelled: number;
  created: number;
  slipped: Task[];
  olderOverdue: number;
  stale: Task[];
  inboxItems: { id: string; content: string; createdAt: number }[];
  inboxTasks: Task[];
  nextWeek: Task[];
  milestones: Milestone[];
  trackedMs: number;
  byProject: SessionBucket[];
  byDay: SessionBucket[];
  focusMinutes: number;
  habits: { id: string; name: string; icon: string | null; met: number; due: number; streak: number }[];
  estimates: EstimateStats;
}

/** What the weekly review keeps (a "weekly" snapshot of the week's first day). */
export interface WeekReflection {
  wins: string;
  lessons: string;
  focus: string;
  /** Tasks picked to focus on next week. */
  focusTaskIds: string[];
  summary?: string | null;
  completedCount?: number;
  slippedCount?: number;
  doneAt?: number | null;
}

// ------------------------------------------------------------ AI actions

export type AssistAction = "breakdown" | "extract" | "weekly" | "ask";

export interface AssistInput {
  action: AssistAction;
  taskId?: string;
  noteId?: string;
  projectId?: string;
  question?: string;
  weekStart?: string;
  today?: string;
  tzOffsetMinutes?: number;
}

export interface AssistPreview {
  allowed: boolean;
  blockedReason: string | null;
  system: string;
  prompt: string;
  chars: number;
  approxTokens: number;
}

export interface AssistSuggestion {
  title: string;
  detail: string | null;
  estimateMinutes: number | null;
  dueDate: string | null;
}

export interface AssistResult {
  suggestions: AssistSuggestion[];
  text: string | null;
  sources: { id: string; kind: string; refId: string; title: string }[];
  dropped: number;
  model: string | null;
  accountName: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  estimatedCost: number | null;
}

// ------------------------------------------------------------ imports, links, shares

export interface ImportTask {
  projectKey?: string | null;
  column?: string | null;
  title: string;
  description?: string;
  status?: TaskStatus | null;
  priority?: number;
  dueDate?: string | null;
  dueTime?: string | null;
  estimateMinutes?: number | null;
  labels?: string[];
  completedAt?: number | null;
  createdAt?: number | null;
  subtasks?: ImportTask[];
}

export interface ImportProject {
  key: string;
  name: string;
  description?: string;
  columns?: { name: string; status: TaskStatus | null }[] | null;
  notes?: { title: string; content: string }[];
}

export interface ImportBundle {
  source: string;
  projects: ImportProject[];
  tasks: ImportTask[];
}

export interface ImportResult {
  projects: number;
  tasks: number;
  notes: number;
  labels: number;
  projectIds: string[];
}

export interface Backlink {
  id: string;
  title: string;
  projectId: string | null;
  context: string;
  updatedAt: number;
}

/**
 * One misspelled run inside a block of text. `start` and `len` are UTF-16
 * code units from the start of that block, which is what JavaScript string
 * indexes count too.
 */
export interface SpellRange {
  start: number;
  len: number;
  /** The one right answer when the checker is certain; "" means delete the run. */
  replacement: string | null;
}

export type ShareKind = "note" | "whiteboard" | "project";

export interface ShareLink {
  id: string;
  url: string;
  kind: ShareKind;
  refId: string;
  title: string;
  views: number;
  hasImage: boolean;
  createdAt: string;
  updatedAt: string;
  expiresAt: string | null;
}

// ---------------------------------------------------------------- passkeys

/** Which authenticator a passkey lives in. */
export type PasskeyKind = "platform" | "securityKey";

export interface Passkey {
  id: string;
  label: string;
  kind: PasskeyKind;
  createdAt: number;
  lastUsedAt: number | null;
}

export interface PasskeySupport {
  /** Windows Hello (or another built-in verifying authenticator) is set up. */
  platform: boolean;
  securityKey: boolean;
  /** Why one or both are unavailable, ready to show. */
  reason: string | null;
}

export interface LockedProject {
  id: string;
  name: string;
  lockedAt: number;
  /** Opened with a passkey this session. */
  unlocked: boolean;
}
