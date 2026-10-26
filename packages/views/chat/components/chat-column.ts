/**
 * Conversation-column geometry — ONE definition shared by every layer of the
 * chat body (message rows, status banners, composer) so their left and right
 * edges line up exactly.
 *
 * The column is two nested boxes, and the nesting order is the point:
 *
 *   <div className={CHAT_GUTTER}>     // minimum distance from the surface edges
 *     <div className={CHAT_COLUMN}>   // the reading column itself
 *
 * Gutter OUTSIDE the column keeps a floor of space at the surface edges. The
 * column itself stays full width of the chat surface, so a viewer's own
 * messages can sit on the far right of the pane. A centered max-width cap
 * parked those bubbles in the middle of a wide chat page. The message list
 * used to nest gutter and cap the other way round (`mx-auto max-w-4xl px-5`
 * on a single element), which also made the text edges miss the composer.
 *
 * The gutter scales with the CONTAINER, never the viewport. These components
 * render in a resizable split pane (the chat tab), a 360px floating window, and
 * the agent builder — all of which are independent widths inside the same
 * browser window, so a `lg:` viewport variant would widen the floating window's
 * gutter just because the window behind it is wide. Hosts therefore have to mark
 * the chat column `@container`; ChatPage, ChatWindow, and the agent builder do.
 * Without that ancestor the `@` variants simply never match and the column keeps
 * the base 28px gutter.
 */
export const CHAT_GUTTER = "px-7 @2xl:px-8 @4xl:px-12";

/** The reading column: full width of the chat surface, inset only by the gutter. */
export const CHAT_COLUMN = "w-full";
