/**
 * @Author Christian Relf
 * @Date 2026-10-12
 */

// The single source of truth for user settings: keys, types and defaults.
// Settings persist in SQLite (settings table); the Rust side reads a few of
// these keys (notifications, backups, window behaviour) with identical
// defaults.

import type { ProjectTab, TaskStatus } from "@/lib/types";

export type Density = "compact" | "comfortable" | "relaxed";
export type Theme = "dark" | "light" | "system";
export type Accent = "none" | "blue" | "violet" | "green" | "amber" | "rose" | "teal";
export type MotionPref = "system" | "full" | "reduced" | "off";
export type NavItemId = "dashboard" | "tasks" | "inbox" | "projects" | "whiteboards" | "notes" | "search" | "focus" | "rundown" | "ai" | "habits" | "review" | "planner";
export type SidebarSectionId = "views" | "pinned" | "projects";
export type CompletionIntensity = "subtle" | "standard" | "pronounced";
export type AiRoutingMode = "manual" | "failover" | "priority" | "cost";
export interface ModelPrice {
  /** USD per million input tokens. */
  input: number;
  /** USD per million output tokens. */
  output: number;
  /** USD per million cached input tokens (defaults to the input price). */
  cached?: number;
}

export interface ColumnTemplate {
  name: string;
  status: TaskStatus | null;
}

export interface Settings {
  // General
  "general.launchAtLogin": boolean;
  "general.launchMinimized": boolean;
  "general.minimizeToTray": boolean;
  "general.closeBehavior": "quit" | "tray";
  "general.showTray": boolean;
  "general.rememberWindow": boolean;
  "general.startMaximized": boolean;
  "general.landing": "dashboard" | "last" | "tasks" | "inbox";
  /** Open full Kern, Kern Lite, or ask each time. Read by the backend too. */
  "general.startMode": "ask" | "kern" | "lite";
  "general.confirmPermanentDelete": boolean;
  "general.confirmDelete": boolean;
  "plugins.suggestSyntax": boolean;
  "plugins.declined": string[];
  "general.detailMode": "inspector" | "modal" | "page";
  "general.globalCaptureShortcut": string | null;
  /** System-wide shortcut that opens Kern Lite. */
  "general.globalLiteShortcut": string | null;
  /** Today's tasks in the tray menu, to tick off without opening Kern. */
  "general.trayTasks": boolean;
  "general.onboarded": boolean;
  // Interactions
  "interaction.closePanelsOnOutsideClick": boolean;
  "interaction.inspectorPinning": boolean;
  "interaction.completionAnimation": boolean;
  "interaction.completionIntensity": CompletionIntensity;
  "interaction.createInterface": "composer" | "quick";
  "interaction.rememberTaskProps": boolean;
  // Writing
  /** Underline misspelled words in notes, with corrections on right-click. */
  "editor.spellcheck": boolean;
  /** How wide a note's text runs: a measured column, or the whole pane. */
  "editor.noteWidth": "readable" | "wide";
  // Appearance
  "appearance.theme": Theme;
  "appearance.accent": Accent;
  "appearance.font": "inter" | "geist" | "system";
  "appearance.fontScale": number;
  "appearance.density": Density;
  "appearance.radius": "sharp" | "default" | "round";
  "appearance.motion": MotionPref;
  "appearance.sidebarWidth": number;
  "appearance.sidebarCollapsed": boolean;
  "appearance.navItems": NavItemId[];
  "appearance.taskRowStyle": "compact" | "expanded";
  "appearance.taskMeta": { project: boolean; due: boolean; priority: boolean; labels: boolean; subtasks: boolean; estimate: boolean; creator: boolean };
  "appearance.scrollbars": "thin" | "hover" | "wide";
  "appearance.inspectorWidth": number;
  // Sidebar
  "sidebar.reorder": boolean;
  "sidebar.dragHandles": boolean;
  "sidebar.layout": "standard" | "flexible";
  "sidebar.sectionOrder": SidebarSectionId[];
  "sidebar.rememberGroups": boolean;
  "sidebar.collapsedSections": SidebarSectionId[];
  // Dashboard
  "dashboard.refreshOnFocus": boolean;
  "dashboard.showHeader": boolean;
  // Tasks
  "tasks.defaultPriority": number;
  "tasks.defaultDestination": "inbox" | "today" | "noDate";
  "tasks.defaultView": "list" | "today" | "upcoming" | "calendar" | "board" | "plan";
  "tasks.weekStart": 0 | 1;
  "tasks.dateFormat": "relative" | "dmy" | "mdy" | "iso";
  "tasks.timeFormat": "24h" | "12h";
  "tasks.showCompleted": boolean;
  "tasks.autoArchiveDays": number;
  "tasks.defaultSort": "manual" | "due" | "priority" | "created" | "title";
  "tasks.recurrenceFromCompletion": boolean;
  "tasks.maxSubtaskDepth": number;
  // Projects & boards
  "projects.defaultTab": ProjectTab;
  "projects.defaultColumns": ColumnTemplate[];
  "projects.showProgress": boolean;
  "projects.archivedDisplay": "hide" | "section";
  "projects.grouping": "groups" | "none";
  "projects.sidebarOrder": "manual" | "recent" | "name";
  "projects.progressIncludeArchived": boolean;
  "projects.folderField": "visible" | "more";
  "projects.openFolderAfterCreate": boolean;
  "projects.showFolderInOverview": boolean;
  "projects.rememberTrust": boolean;
  "projects.showFilesTab": boolean;
  "projects.resume": "resume" | "overview" | "lastTab" | "ask";
  "boards.defaultCardDensity": "compact" | "expanded";
  "boards.columnWidth": number;
  /** Confetti when a card is completed or dropped into a done column. */
  "boards.celebrate": boolean;
  // Whiteboards
  "wb.snapToGrid": boolean;
  "wb.showGrid": boolean;
  "wb.gridSize": number;
  "wb.defaultZoom": number;
  "wb.connectorStyle": "smooth" | "straight" | "step";
  "wb.connectorArrow": boolean;
  "wb.stickySize": "s" | "m" | "l";
  "wb.stickyTone": "plain" | "warm" | "cool";
  "wb.alignGuides": boolean;
  "wb.panSensitivity": number;
  "wb.zoomSensitivity": number;
  "wb.autoFit": boolean;
  "wb.interactionMode": "mouse" | "trackpad";
  "wb.limitEffects": boolean;
  // Notifications
  "notifications.enabled": boolean;
  "notifications.dueReminders": boolean;
  "notifications.dueLeadMinutes": number;
  "notifications.overdue": boolean;
  "notifications.overdueTime": string;
  "notifications.focus": boolean;
  "notifications.quietHours": { enabled: boolean; start: string; end: string };
  /** Someone @mentions you in a task comment (Kern Cloud). */
  "notifications.mentions": boolean;
  // Weekly review
  "review.enabled": boolean;
  /** 0 = Sunday … 6 = Saturday. */
  "review.day": number;
  "review.time": string;
  "review.notify": boolean;
  // Calendars
  "calendar.showEvents": boolean;
  "calendar.refreshMinutes": number;
  /** An .ics file Kern keeps up to date (calendar apps can subscribe to it). */
  "calendar.autoExportPath": string | null;
  /** First hour shown in the day planner. */
  "calendar.dayStart": number;
  "calendar.dayEnd": number;
  // Daily rundown
  "rundown.enabled": boolean;
  "rundown.time": string;
  "rundown.notify": boolean;
  "rundown.autoOpen": boolean;
  "rundown.includeOverdue": boolean;
  "rundown.includeUpcoming": boolean;
  "rundown.includeCompleted": boolean;
  "rundown.includeProjects": boolean;
  "rundown.maxTasks": number;
  "rundown.upcomingDays": number;
  "rundown.projectIds": string[] | null;
  "rundown.eveningEnabled": boolean;
  "rundown.eveningTime": string;
  "rundown.eveningNotify": boolean;
  // Focus
  "focus.focusMinutes": number;
  "focus.shortBreakMinutes": number;
  "focus.longBreakMinutes": number;
  "focus.longBreakEvery": number;
  "focus.autoStartBreaks": boolean;
  "focus.autoStartFocus": boolean;
  "focus.trackHistory": boolean;
  // Keyboard
  "keyboard.shortcuts": Record<string, string | null>;
  // Data & backups
  "backups.frequency": "off" | "daily" | "weekly";
  "backups.dir": string | null;
  "backups.keep": number;
  "data.trashRetentionDays": number;
  "data.activityRetentionDays": number;
  "data.linkPreviews": boolean;
  "storage.includeLinkedFolders": boolean;
  // Kern Cloud
  "cloud.enabled": boolean;
  "cloud.sharePresence": boolean;
  "cloud.showCursors": boolean;
  "cloud.streamToasts": boolean;
  // Privacy & security
  "privacy.network": boolean;
  "privacy.favicons": boolean;
  "privacy.aiProjectContent": boolean;
  "privacy.aiLinkedFolders": boolean;
  /** Allow plugin and syntax downloads (needs network access too). */
  "privacy.pluginDownloads": boolean;
  /** Let notifications carry task, note and comment text. Read by the backend. */
  "privacy.notificationDetails": boolean;
  /** Blur the window's contents while Kern isn't the focused app. */
  "privacy.blurOnUnfocus": boolean;
  /** Days a folder stays trusted after the decision; 0 means indefinitely. Read by the backend. */
  "privacy.trustExpiryDays": number;
  /** Keep a list of recently opened projects, notes and whiteboards. Read by the backend. */
  "privacy.recordRecents": boolean;
  /** Minutes an unlocked project stays open; 0 means until Kern closes. Read by the backend. */
  "privacy.passkeyRelockMinutes": number;
  // AI API accounts
  "ai.routingMode": AiRoutingMode;
  "ai.crossProvider": boolean;
  "ai.maxAttempts": number;
  "ai.maxRetryWaitSeconds": number;
  "ai.notifySwitch": boolean;
  "ai.usageRetentionDays": number;
  "ai.modelPrices": Record<string, ModelPrice>;
  // Assistants (MCP): AI clients that connect to Kern over a local pipe
  /** Off by default. Nothing listens until this is on. Read by the backend. */
  "mcp.enabled": boolean;
  /** Tool calls one assistant may make in a minute; 0 means no limit. Read by the backend. */
  "mcp.maxCallsPerMinute": number;
  /** Days of assistant activity to keep. Read by the backend. */
  "mcp.auditDays": number;
  // GitHub
  "github.auth": "auto" | "cli" | "token";
  "github.autoSync": boolean;
  "github.pushOnEdit": boolean;
  // Developer tools (all optional)
  "dev.editor": string;
  "terminal.shell": string;
  "terminal.defaultCwd": string;
  "terminal.fontSize": number;
  /** "all": every terminal stays visible; "project": only the open project's tabs (others keep running). */
  "terminal.scope": "all" | "project";
  "services.pollWhileOpen": boolean;
  "search.indexFiles": boolean;
  "search.codeSearch": boolean;
  "sessions.gapPrompt": boolean;
  // Performance
  "performance.reduceBackground": boolean;
  "performance.cacheMinutes": number;
  // Kern Lite
  /** Keep the Lite window above other windows. */
  "lite.alwaysOnTop": boolean;
  /** Show today's completed tasks under the list. */
  "lite.showDone": boolean;
  /** Little celebrations when a list is cleared. */
  "lite.celebrate": boolean;
}

export const DEFAULTS: Settings = {
  "general.launchAtLogin": false,
  "general.launchMinimized": false,
  "general.minimizeToTray": false,
  "general.closeBehavior": "quit",
  "general.showTray": true,
  "general.rememberWindow": true,
  "general.startMaximized": false,
  "general.landing": "dashboard",
  "general.startMode": "ask",
  "general.confirmPermanentDelete": true,
  "general.confirmDelete": true,
  "plugins.suggestSyntax": true,
  "plugins.declined": [],
  "general.detailMode": "inspector",
  "general.globalCaptureShortcut": null,
  "general.globalLiteShortcut": null,
  "general.trayTasks": true,
  "general.onboarded": false,

  "interaction.closePanelsOnOutsideClick": true,
  "interaction.inspectorPinning": true,
  "interaction.completionAnimation": true,
  "interaction.completionIntensity": "standard",
  "interaction.createInterface": "composer",
  "interaction.rememberTaskProps": true,

  "editor.spellcheck": true,
  "editor.noteWidth": "readable",

  "appearance.theme": "dark",
  "appearance.accent": "none",
  "appearance.font": "inter",
  "appearance.fontScale": 1,
  "appearance.density": "comfortable",
  "appearance.radius": "default",
  "appearance.motion": "system",
  "appearance.sidebarWidth": 236,
  "appearance.sidebarCollapsed": false,
  "appearance.navItems": ["dashboard", "tasks", "inbox", "projects", "whiteboards", "notes"],
  "appearance.taskRowStyle": "compact",
  "appearance.taskMeta": { project: true, due: true, priority: true, labels: true, subtasks: true, estimate: false, creator: true },
  "appearance.scrollbars": "thin",
  "appearance.inspectorWidth": 380,

  "sidebar.reorder": true,
  "sidebar.dragHandles": true,
  "sidebar.layout": "standard",
  "sidebar.sectionOrder": ["views", "pinned", "projects"],
  "sidebar.rememberGroups": true,
  "sidebar.collapsedSections": [],

  "dashboard.refreshOnFocus": true,
  "dashboard.showHeader": true,

  "tasks.defaultPriority": 0,
  "tasks.defaultDestination": "inbox",
  "tasks.defaultView": "list",
  "tasks.weekStart": 1,
  "tasks.dateFormat": "relative",
  "tasks.timeFormat": "24h",
  "tasks.showCompleted": false,
  "tasks.autoArchiveDays": 0,
  "tasks.defaultSort": "manual",
  "tasks.recurrenceFromCompletion": false,
  "tasks.maxSubtaskDepth": 3,

  "projects.defaultTab": "overview",
  "projects.defaultColumns": [
    { name: "Backlog", status: null },
    { name: "To Do", status: "todo" },
    { name: "In Progress", status: "in_progress" },
    { name: "Done", status: "completed" },
  ],
  "projects.showProgress": true,
  "projects.archivedDisplay": "section",
  "projects.grouping": "groups",
  "projects.sidebarOrder": "manual",
  "projects.progressIncludeArchived": false,
  "projects.folderField": "visible",
  "projects.openFolderAfterCreate": false,
  "projects.showFolderInOverview": true,
  "projects.rememberTrust": true,
  "projects.showFilesTab": true,
  "projects.resume": "resume",
  "boards.defaultCardDensity": "compact",
  "boards.columnWidth": 288,
  "boards.celebrate": true,

  "wb.snapToGrid": false,
  "wb.showGrid": true,
  "wb.gridSize": 20,
  "wb.defaultZoom": 1,
  "wb.connectorStyle": "smooth",
  "wb.connectorArrow": true,
  "wb.stickySize": "m",
  "wb.stickyTone": "plain",
  "wb.alignGuides": true,
  "wb.panSensitivity": 1,
  "wb.zoomSensitivity": 1,
  "wb.autoFit": true,
  "wb.interactionMode": "mouse",
  "wb.limitEffects": false,

  "notifications.enabled": true,
  "notifications.dueReminders": true,
  "notifications.dueLeadMinutes": 15,
  "notifications.overdue": true,
  "notifications.overdueTime": "13:00",
  "notifications.focus": true,
  "notifications.quietHours": { enabled: false, start: "22:00", end: "07:00" },
  "notifications.mentions": true,

  "review.enabled": true,
  "review.day": 5,
  "review.time": "16:00",
  "review.notify": true,

  "calendar.showEvents": true,
  "calendar.refreshMinutes": 180,
  "calendar.autoExportPath": null,
  "calendar.dayStart": 7,
  "calendar.dayEnd": 21,

  "rundown.enabled": true,
  "rundown.time": "09:00",
  "rundown.notify": true,
  "rundown.autoOpen": false,
  "rundown.includeOverdue": true,
  "rundown.includeUpcoming": true,
  "rundown.includeCompleted": true,
  "rundown.includeProjects": true,
  "rundown.maxTasks": 6,
  "rundown.upcomingDays": 7,
  "rundown.projectIds": null,
  "rundown.eveningEnabled": false,
  "rundown.eveningTime": "18:00",
  "rundown.eveningNotify": true,

  "focus.focusMinutes": 25,
  "focus.shortBreakMinutes": 5,
  "focus.longBreakMinutes": 15,
  "focus.longBreakEvery": 4,
  "focus.autoStartBreaks": false,
  "focus.autoStartFocus": false,
  "focus.trackHistory": true,

  "keyboard.shortcuts": {},

  "backups.frequency": "daily",
  "backups.dir": null,
  "backups.keep": 10,
  "data.trashRetentionDays": 30,
  "data.activityRetentionDays": 180,
  "data.linkPreviews": true,
  "storage.includeLinkedFolders": false,

  "cloud.enabled": false,
  "cloud.sharePresence": true,
  "cloud.showCursors": true,
  "cloud.streamToasts": true,

  "privacy.network": true,
  "privacy.favicons": true,
  "privacy.aiProjectContent": false,
  "privacy.aiLinkedFolders": false,
  "privacy.pluginDownloads": true,
  "privacy.notificationDetails": true,
  "privacy.blurOnUnfocus": false,
  "privacy.trustExpiryDays": 0,
  "privacy.recordRecents": true,
  "privacy.passkeyRelockMinutes": 0,

  "ai.routingMode": "failover",
  "ai.crossProvider": false,
  "ai.maxAttempts": 3,
  "ai.maxRetryWaitSeconds": 20,
  "ai.notifySwitch": true,
  "ai.usageRetentionDays": 90,
  "ai.modelPrices": {},

  "mcp.enabled": false,
  "mcp.maxCallsPerMinute": 120,
  "mcp.auditDays": 30,

  "github.auth": "auto",
  "github.autoSync": true,
  "github.pushOnEdit": true,

  "dev.editor": "",
  "terminal.shell": "",
  "terminal.defaultCwd": "",
  "terminal.fontSize": 12.5,
  "terminal.scope": "all",
  "services.pollWhileOpen": true,
  "search.indexFiles": true,
  "search.codeSearch": true,
  "sessions.gapPrompt": true,

  "performance.reduceBackground": false,
  "performance.cacheMinutes": 5,
  "lite.alwaysOnTop": false,
  "lite.showDone": true,
  "lite.celebrate": true,
};

export type SettingKey = keyof Settings;
