import { create } from "zustand";
import type { Agent, Attachment } from "@multica/core/types";
import type { PageSurfaceContext } from "./page-surface-context";
import { preparePageSurfaceSend } from "./page-surface-context";

type FanoutStore = {
  extraAgentIds: string[];
  toggle: (id: string, primaryId: string | undefined) => void;
  reset: () => void;
};

/** 当前会话主智能体之外、下一条消息要并行发给的智能体。不落盘。 */
export const useChatFanout = create<FanoutStore>((set, get) => ({
  extraAgentIds: [],
  toggle: (id, primaryId) => {
    if (!id || id === primaryId) return;
    const current = get().extraAgentIds;
    set({
      extraAgentIds: current.includes(id)
        ? current.filter((row) => row !== id)
        : [...current, id],
    });
  },
  reset: () => set({ extraAgentIds: [] }),
}));

export function selectedSendAgentIds(
  primaryId: string | undefined,
  extraAgentIds: string[],
): string[] {
  if (!primaryId) return extraAgentIds;
  return [primaryId, ...extraAgentIds.filter((id) => id !== primaryId)];
}

type FanoutApi = {
  sendChatMessage: (
    sessionId: string,
    content: string,
    attachmentIds?: string[],
  ) => Promise<unknown>;
  uploadFile: (
    file: File,
    opts?: { chatSessionId?: string },
  ) => Promise<Attachment>;
};

export async function fanOutChatMessage(opts: {
  extraAgentIds: string[];
  agents: Agent[];
  content: string;
  projectId: string | null;
  pageSurface: PageSurfaceContext | null;
  api: FanoutApi;
  createSession: (data: {
    agent_id: string;
    title?: string;
    project_id?: string | null;
  }) => Promise<{ id: string }>;
}): Promise<{ sent: number; failed: number; sessionIds: string[] }> {
  const extras = opts.extraAgentIds
    .map((id) => opts.agents.find((agent) => agent.id === id))
    .filter((agent): agent is Agent => Boolean(agent));
  let sent = 0;
  let failed = 0;
  const sessionIds: string[] = [];
  for (const agent of extras) {
    try {
      const session = await opts.createSession({
        agent_id: agent.id,
        title: opts.content.trim().slice(0, 50),
        project_id: opts.projectId,
      });
      const prepared = await preparePageSurfaceSend(
        opts.api,
        opts.content,
        opts.pageSurface,
        session.id,
      );
      await opts.api.sendChatMessage(
        session.id,
        prepared.content,
        prepared.attachmentIds.length > 0 ? prepared.attachmentIds : undefined,
      );
      sessionIds.push(session.id);
      sent += 1;
    } catch {
      failed += 1;
    }
  }
  return { sent, failed, sessionIds };
}
