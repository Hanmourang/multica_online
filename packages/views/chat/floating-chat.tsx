"use client";

import { useChatStore } from "@multica/core/chat";
import { useWorkspacePaths } from "@multica/core/paths";
import { useNavigation } from "../navigation";
import { ChatFab } from "./components/chat-fab";
import { ChatWindow } from "./components/chat-window";
import { isFloatingChatRouteSuppressed } from "./floating-chat-visibility";

/**
 * Mount point for the floating chat overlay (FAB + window). Rendered once in
 * each app shell's dashboard layout.
 *
 * The launcher is permanent: it mounts on every dashboard route, survives the
 * window being open, and stays put even when the floating window itself is
 * switched off. Unmounting it was how the entry point used to disappear with
 * nothing on screen explaining where Chat went. The two gates below therefore
 * decide only whether the *window* may exist here:
 *
 *  1. The Settings → Chat preference (`floatingChatEnabled`). When a user turns
 *     the floating window off, Chat lives only in its dedicated tab and the
 *     launcher becomes a shortcut to that tab.
 *  2. The Chat tab route itself. On `/:slug/chat` the full-page surface already
 *     owns the conversation, so a floating copy of the same `activeSessionId`
 *     would be pure duplication — the window is suppressed, the launcher hands
 *     focus to the page composer instead.
 */
export function FloatingChat() {
  const enabled = useChatStore((s) => s.floatingChatEnabled);
  const { pathname } = useNavigation();
  const wsPaths = useWorkspacePaths();

  const chatPath = wsPaths.chat();
  const windowAllowed = enabled && !isFloatingChatRouteSuppressed(pathname, chatPath);

  return (
    <>
      {windowAllowed ? <ChatWindow /> : null}
      <ChatFab windowAllowed={windowAllowed} chatPath={chatPath} />
    </>
  );
}
