/**
 * @Author Christian Relf
 * @Date 2026-10-24
 */

import { create } from "zustand";

export const useBugReport = create<{ open: boolean }>(() => ({ open: false }));

/** Opens the bug report dialog (its code loads on first open). */
export function openBugReport() {
  useBugReport.setState({ open: true });
}

export function closeBugReport() {
  useBugReport.setState({ open: false });
}
