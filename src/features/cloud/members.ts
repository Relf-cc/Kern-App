/**
 * @Author Christian Relf
 * @Date 2026-10-19
 */

// The members of the active workspace, for anything that shows who did what:
// comment authors, task creators, mention pickers. Personal and offline
// spaces have no members, so the list is empty and callers show nothing.

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Member } from "@/lib/types";
import { api } from "@/lib/ipc";
import { useActiveSpace } from "./store";

export function useMembers(): Member[] {
  const space = useActiveSpace();
  const { data } = useQuery({
    queryKey: ["cloud", "members", space?.id],
    queryFn: () => api.cloud.request<Member[]>("GET", `/workspaces/${space!.id}/members`),
    enabled: space?.kind === "workspace",
    staleTime: 5 * 60_000,
  });
  return data ?? [];
}

/** The same list by user id, for looking a name and picture up per row. */
export function useMemberMap(): Map<string, Member> {
  const members = useMembers();
  return useMemo(() => new Map(members.map((m) => [m.userId, m])), [members]);
}
