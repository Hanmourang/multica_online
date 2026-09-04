/**
 * localtunnel (the selfhost tunnel option) serves an HTML interstitial to any
 * request that lacks the `bypass-tunnel-reminder` header. The ApiClient
 * (data/api.ts) and the WebSocket (data/realtime/ws-client.ts) already send it,
 * but RN's native image loaders — `expo-image`, `Image.getSizeWithHeaders`, and
 * `react-native-image-viewing` — bypass that fetch chain entirely, so without
 * the header they receive the interstitial HTML instead of image bytes and the
 * picture fails to decode (the "chat images won't load" symptom).
 *
 * Attach these headers to every remote image source. The header is ignored by
 * any non-localtunnel host (LAN-direct via the login-screen server override,
 * prod CDN, signed CloudFront URLs), so sending it unconditionally is safe.
 */
export const TUNNEL_BYPASS_HEADERS: Record<string, string> = {
  "bypass-tunnel-reminder": "1",
};
