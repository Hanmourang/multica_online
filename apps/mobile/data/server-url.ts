/**
 * Runtime server-URL override.
 *
 * `EXPO_PUBLIC_API_URL` is inlined at build time, which pins the app to a
 * single server (for selfhost, the tunnel URL baked into the APK). But a
 * phone that shares the desktop's Wi-Fi reaches the server far faster and
 * more reliably over the LAN address (http://<mac-ip>:18646) than through a
 * free public tunnel. This store lets the user switch the target at runtime
 * from the login screen; the choice persists in SecureStore and is hydrated
 * before the first request (see AuthInitializer in app/_layout.tsx).
 *
 * Both transports read from here so a switch applies everywhere:
 *   - HTTP: data/api.ts calls getApiUrl() per request.
 *   - WS:   data/realtime/realtime-provider.tsx subscribes to `url` and
 *           rebuilds the socket when it changes.
 *
 * When no override is set the value is exactly the build-time default, so
 * behaviour is unchanged for users who never touch the setting.
 */
import { create } from "zustand";

const STORAGE_KEY = "multica_server_url_override";

// expo-secure-store is a native module. Import it lazily — only inside the
// async read/persist paths — so importing this module (and thus getApiUrl())
// never pulls a native chain at module-evaluation time. lib/attachment-url.ts
// depends on getApiUrl() and is covered by a pure-function vitest suite that
// runs in a node environment with no native shims (apps/mobile/vitest.config.ts).
async function secureStore() {
  return import("expo-secure-store");
}

function normalize(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

const BUILD_DEFAULT = normalize(process.env.EXPO_PUBLIC_API_URL ?? "");

interface ServerUrlState {
  /** Active base URL, e.g. https://host or http://192.168.1.10:18646. */
  url: string;
  /** Build-time default (env) — used to reset a user override. */
  defaultUrl: string;
  /** True once the persisted override has been read from SecureStore. */
  hydrated: boolean;
  /** Read the persisted override. Call once at startup, before any request. */
  hydrate: () => Promise<void>;
  /** Persist a new base URL; empty/blank resets to the build default. */
  setUrl: (url: string | null) => Promise<void>;
}

export const useServerUrlStore = create<ServerUrlState>((set) => ({
  url: BUILD_DEFAULT,
  defaultUrl: BUILD_DEFAULT,
  hydrated: false,

  hydrate: async () => {
    try {
      const SecureStore = await secureStore();
      const saved = await SecureStore.getItemAsync(STORAGE_KEY);
      set(saved ? { url: normalize(saved), hydrated: true } : { hydrated: true });
    } catch {
      set({ hydrated: true });
    }
  },

  setUrl: async (url) => {
    const hasValue = !!url && !!url.trim();
    const next = hasValue ? normalize(url!) : BUILD_DEFAULT;
    // Apply in memory first so the next fetch/WS connect uses it immediately.
    set({ url: next });
    try {
      const SecureStore = await secureStore();
      if (hasValue) await SecureStore.setItemAsync(STORAGE_KEY, next);
      else await SecureStore.deleteItemAsync(STORAGE_KEY);
    } catch {
      // Persistence is best-effort; the in-memory value already applied.
    }
  },
}));

/** Synchronous accessor for non-React code (the ApiClient singleton). */
export function getApiUrl(): string {
  return useServerUrlStore.getState().url;
}
