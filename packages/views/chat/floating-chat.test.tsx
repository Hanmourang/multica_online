import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { FloatingChat } from "./floating-chat";

// The launcher is the only way into Chat from an ordinary page, so it must
// never be gated away: the two gates decide whether the *window* may exist,
// never whether the icon does. A regression here reads to the user as "Chat
// disappeared from the bottom-right corner".
const h = vi.hoisted(() => ({
  chat: { floatingChatEnabled: true },
  navigation: { pathname: "/acme/issues" },
}));

vi.mock("@multica/core/chat", () => ({
  useChatStore: (selector: (state: typeof h.chat) => unknown) => selector(h.chat),
}));
vi.mock("@multica/core/paths", () => ({
  useWorkspacePaths: () => ({ chat: () => "/acme/chat" }),
}));
vi.mock("../navigation", () => ({ useNavigation: () => h.navigation }));
vi.mock("./components/chat-window", () => ({
  ChatWindow: () => <div data-testid="chat-window" />,
}));
vi.mock("./components/chat-fab", () => ({
  ChatFab: ({ windowAllowed }: { windowAllowed: boolean }) => (
    <div data-testid="chat-fab" data-window-allowed={String(windowAllowed)} />
  ),
}));

beforeEach(() => {
  h.chat.floatingChatEnabled = true;
  h.navigation.pathname = "/acme/issues";
});

afterEach(cleanup);

describe("FloatingChat", () => {
  it("mounts both the launcher and the window on an ordinary route", () => {
    render(<FloatingChat />);
    expect(screen.getByTestId("chat-fab")).toHaveAttribute("data-window-allowed", "true");
    expect(screen.getByTestId("chat-window")).toBeInTheDocument();
  });

  it("keeps the launcher when the floating window is switched off", () => {
    h.chat.floatingChatEnabled = false;
    render(<FloatingChat />);
    expect(screen.getByTestId("chat-fab")).toHaveAttribute("data-window-allowed", "false");
    expect(screen.queryByTestId("chat-window")).toBeNull();
  });

  it("keeps the launcher on the Chat tab, where only the window is suppressed", () => {
    h.navigation.pathname = "/acme/chat";
    render(<FloatingChat />);
    expect(screen.getByTestId("chat-fab")).toHaveAttribute("data-window-allowed", "false");
    expect(screen.queryByTestId("chat-window")).toBeNull();
  });

  it("treats nested Chat tab routes like the Chat tab", () => {
    h.navigation.pathname = "/acme/chat/session-1";
    render(<FloatingChat />);
    expect(screen.getByTestId("chat-fab")).toHaveAttribute("data-window-allowed", "false");
    expect(screen.queryByTestId("chat-window")).toBeNull();
  });
});
