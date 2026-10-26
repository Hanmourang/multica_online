import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { I18nProvider } from "@multica/core/i18n/react";
import type { ChatSession } from "@multica/core/types";
import enConversations from "../../locales/en/conversations.json";

// --- hoisted state the vi.mock factories can reach --------------------------
const h = vi.hoisted(() => {
  const members = [] as {
    user_id: string;
    name: string;
    email: string;
  }[];
  return {
    members,
    // The dialog calls mutate(memberId, { onSuccess, onError }); we replay
    // onSuccess with a server session so the test can assert the callback.
    mutate: vi.fn((memberId: string, opts?: { onSuccess?: (s: ChatSession) => void }) => {
      opts?.onSuccess?.({ id: `dm-for-${memberId}` } as ChatSession);
    }),
    toastError: vi.fn(),
  };
});

vi.mock("@multica/core/hooks", () => ({ useWorkspaceId: () => "ws-1" }));
vi.mock("@multica/core/workspace/queries", () => ({
  memberListOptions: () => ({ queryKey: ["members"] }),
}));
vi.mock("@multica/core/chat/dm", () => ({
  useCreateDMChatSession: () => ({ mutate: h.mutate, isPending: false }),
}));
vi.mock("../../common/actor-avatar", () => ({
  ActorAvatar: ({ actorId }: { actorId: string }) => (
    <span data-testid={`avatar-${actorId}`} />
  ),
}));
vi.mock("../../editor/extensions/pinyin-match", () => ({
  matchesPinyin: () => false,
}));
vi.mock("sonner", () => ({ toast: { error: h.toastError, success: vi.fn() } }));
vi.mock("@tanstack/react-query", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-query")>();
  return {
    ...actual,
    useQuery: () => ({ data: h.members }),
  };
});

import { DmCreateDialog } from "./dm-create-dialog";

const TEST_RESOURCES = { en: { conversations: enConversations } };
const TRIGGER_LABEL = enConversations.dm.trigger_tooltip;

function openDialog(onCreated = vi.fn()) {
  render(
    <I18nProvider locale="en" resources={TEST_RESOURCES}>
      <DmCreateDialog userId="user-me" onCreated={onCreated} />
    </I18nProvider>,
  );
  fireEvent.click(screen.getByLabelText(TRIGGER_LABEL));
  return onCreated;
}

describe("DmCreateDialog (plan 20261025)", () => {
  beforeEach(() => {
    h.mutate.mockClear();
    h.toastError.mockClear();
    h.members = [
      { user_id: "user-me", name: "Me", email: "me@corp.test" },
      { user_id: "user-bob", name: "Bob", email: "bob@corp.test" },
      { user_id: "user-alice", name: "Alice", email: "alice@corp.test" },
    ];
  });

  it("hides the current user from the picker", () => {
    openDialog();
    expect(screen.queryByText("Me")).not.toBeInTheDocument();
    expect(screen.getByText("Bob")).toBeInTheDocument();
    expect(screen.getByText("Alice")).toBeInTheDocument();
  });

  it("filters the roster by name or email substring", () => {
    openDialog();
    fireEvent.change(screen.getByPlaceholderText(enConversations.dm.search_placeholder), {
      target: { value: "alice@corp" },
    });
    expect(screen.queryByText("Bob")).not.toBeInTheDocument();
    expect(screen.getByText("Alice")).toBeInTheDocument();
  });

  it("creates a DM with the chosen member's user id and reports the server session id", () => {
    const onCreated = openDialog();
    fireEvent.click(screen.getByText("Bob"));

    expect(h.mutate).toHaveBeenCalledWith(
      "user-bob",
      expect.objectContaining({ onSuccess: expect.any(Function) }),
    );
    // Navigation follows the server-returned id (idempotent reuse), never a
    // client-synthesised one.
    expect(onCreated).toHaveBeenCalledWith("dm-for-user-bob");
  });
});
