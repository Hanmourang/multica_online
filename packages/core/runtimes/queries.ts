import { queryOptions } from "@tanstack/react-query";
import { api } from "../api";

export const runtimeKeys = {
  all: (wsId: string) => ["runtimes", wsId] as const,
  list: (wsId: string) => [...runtimeKeys.all(wsId), "list"] as const,
  listMine: (wsId: string) => [...runtimeKeys.all(wsId), "list", "mine"] as const,
  usage: (rid: string, days: number, tz: string) =>
    ["runtimes", "usage", rid, days, tz] as const,
  usageByAgent: (rid: string, days: number, tz: string) =>
    ["runtimes", "usage", "by-agent", rid, days, tz] as const,
  // by-hour now follows the viewer's tz, like the other reports.
  usageByHour: (rid: string, days: number, tz: string) =>
    ["runtimes", "usage", "by-hour", rid, days, tz] as const,
  // The phone channel describes this deployment, not a workspace, so it is
  // keyed on its own and stays valid when the viewer switches workspaces.
  localChannel: () => ["local-channel"] as const,
};

/**
 * The server probes a process table and calls the tunnel's /health, then
 * caches for 10s; matching that here keeps a reopened dialog honest about a
 * tunnel that just died without re-probing on every render.
 */
export function localChannelOptions() {
  return queryOptions({
    queryKey: runtimeKeys.localChannel(),
    queryFn: () => api.getLocalChannel(),
    staleTime: 10 * 1000,
    // A global `staleTime: Infinity` + `refetchOnWindowFocus: false` means a
    // single failed fetch would hide the entry for the rest of the session —
    // and the common failure is a server that is still booting. Retry briefly
    // instead of pinning the panel off.
    //
    // 404/405 is the exception: this deployment has no such endpoint (an older
    // server), so retrying cannot invent it. Answer at once and let the dialog
    // fall back to the degraded view instead of spinning for three seconds.
    retry: (failureCount, error) => {
      const status = (error as { status?: number }).status;
      if (status === 404 || status === 405) {
        return false;
      }
      return failureCount < 2;
    },
    retryDelay: 1500,
  });
}

// `tz` is the viewer's IANA name — all reports follow the viewer's tz.
export function runtimeUsageOptions(
  runtimeId: string,
  days: number,
  tz: string,
) {
  return queryOptions({
    queryKey: runtimeKeys.usage(runtimeId, days, tz),
    queryFn: () => api.getRuntimeUsage(runtimeId, { days, tz }),
    staleTime: 60 * 1000,
  });
}

export function runtimeUsageByAgentOptions(
  runtimeId: string,
  days: number,
  tz: string,
) {
  return queryOptions({
    queryKey: runtimeKeys.usageByAgent(runtimeId, days, tz),
    queryFn: () => api.getRuntimeUsageByAgent(runtimeId, { days, tz }),
    staleTime: 60 * 1000,
  });
}

export function runtimeUsageByHourOptions(runtimeId: string, days: number, tz: string) {
  return queryOptions({
    queryKey: runtimeKeys.usageByHour(runtimeId, days, tz),
    queryFn: () => api.getRuntimeUsageByHour(runtimeId, { days, tz }),
    staleTime: 60 * 1000,
  });
}

/**
 * `wsSlug` targets a workspace other than the active one. The server resolves
 * the workspace from the slug header before the `workspace_id` param, so the
 * param alone cannot reach a workspace the app has not navigated to — which is
 * exactly the create-workspace flow's situation.
 */
export function runtimeListOptions(wsId: string, owner?: "me", wsSlug?: string) {
  return queryOptions({
    queryKey: owner === "me" ? runtimeKeys.listMine(wsId) : runtimeKeys.list(wsId),
    queryFn: () => api.listRuntimes({ workspace_id: wsId, owner }, wsSlug),
  });
}
