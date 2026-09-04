/**
 * @vitest-environment jsdom
 */
import { act, render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setApiInstance } from "../api";
import { ApiError, type ApiClient } from "../api/client";
import {
  createAuthStore,
  registerAuthStore,
  useAuthStore,
} from "../auth";
import type { StorageAdapter, User, Workspace } from "../types";
import { workspaceKeys } from "../workspace/queries";
import { AuthInitializer } from "./auth-initializer";
import type { DevAutoLoginConfig } from "./dev-auto-login";

const logger = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock("../logger", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../logger")>();
  return { ...actual, createLogger: () => logger };
});

vi.mock("../analytics", () => ({
  captureSignupSource: vi.fn(),
  identify: vi.fn(),
  initAnalytics: vi.fn(),
  resetAnalytics: vi.fn(),
}));

const fakeUser = {
  id: "user-1",
  name: "Alice",
  email: "alice@example.com",
  avatar_url: null,
} as User;

const fakeWorkspaces = [{ id: "ws-1", slug: "acme" }] as Workspace[];

function makeStorage(initial: Record<string, string> = {}): StorageAdapter & {
  snapshot: () => Record<string, string>;
} {
  const values = { ...initial };
  return {
    getItem: (key) => values[key] ?? null,
    setItem: (key, value) => {
      values[key] = value;
    },
    removeItem: (key) => {
      delete values[key];
    },
    snapshot: () => ({ ...values }),
  };
}

function makeApi(overrides: Partial<ApiClient> = {}): ApiClient {
  return {
    getConfig: vi.fn().mockResolvedValue({}),
    getMe: vi.fn().mockResolvedValue(fakeUser),
    listWorkspaces: vi.fn().mockResolvedValue(fakeWorkspaces),
    sendCode: vi.fn().mockResolvedValue(undefined),
    verifyCode: vi
      .fn()
      .mockResolvedValue({ token: "token-dev", user: fakeUser }),
    setToken: vi.fn(),
    ...overrides,
  } as unknown as ApiClient;
}

function renderInitializer({
  api,
  storage = makeStorage({ multica_token: "token-1" }),
  cookieAuth = false,
  platform = "desktop",
  devAutoLogin,
}: {
  api: ApiClient;
  storage?: StorageAdapter;
  cookieAuth?: boolean;
  platform?: "desktop" | "web";
  devAutoLogin?: DevAutoLoginConfig | null;
}) {
  const onLogin = vi.fn();
  const onLogout = vi.fn();
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  setApiInstance(api);
  registerAuthStore(
    createAuthStore({ api, storage, cookieAuth, onLogin, onLogout }),
  );

  const result = render(
    <QueryClientProvider client={queryClient}>
      <AuthInitializer
        cookieAuth={cookieAuth}
        devAutoLogin={devAutoLogin}
        identity={{ platform }}
        onLogin={onLogin}
        onLogout={onLogout}
        storage={storage}
      >
        <div>child</div>
      </AuthInitializer>
    </QueryClientProvider>,
  );

  return { ...result, onLogin, onLogout, queryClient };
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("AuthInitializer recovery", () => {
  it("keeps the token and recovers on the online event after a network failure", async () => {
    const storage = makeStorage({ multica_token: "token-1" });
    const getMe = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValue(fakeUser);
    const api = makeApi({ getMe });
    const { onLogout } = renderInitializer({ api, storage });

    await waitFor(() => {
      expect(useAuthStore.getState().status).toBe("recovering");
    });
    expect(storage.snapshot().multica_token).toBe("token-1");
    expect(onLogout).not.toHaveBeenCalled();

    act(() => window.dispatchEvent(new Event("online")));

    await waitFor(() => {
      expect(useAuthStore.getState().user).toEqual(fakeUser);
    });
    expect(getMe).toHaveBeenCalledTimes(2);
    expect(onLogout).not.toHaveBeenCalled();
  });

  it("lets a manual retry restart a recoverable auth attempt", async () => {
    const getMe = vi
      .fn()
      .mockRejectedValueOnce(new ApiError("unavailable", 503, "Unavailable"))
      .mockResolvedValue(fakeUser);
    const api = makeApi({ getMe });
    const { onLogout } = renderInitializer({ api });

    await waitFor(() => {
      expect(useAuthStore.getState().status).toBe("recovering");
    });
    act(() => useAuthStore.getState().retryAuthentication());

    await waitFor(() => {
      expect(useAuthStore.getState().status).toBe("authenticated");
    });
    expect(getMe).toHaveBeenCalledTimes(2);
    expect(onLogout).not.toHaveBeenCalled();
  });

  it("continues automatic retries at the capped backoff interval", async () => {
    vi.useFakeTimers();
    const getMe = vi.fn().mockRejectedValue(new TypeError("still offline"));
    const api = makeApi({ getMe });
    const { onLogout } = renderInitializer({ api });

    await act(async () => {
      await Promise.resolve();
    });
    expect(useAuthStore.getState().status).toBe("recovering");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(31_000);
    });
    expect(getMe).toHaveBeenCalledTimes(6);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(getMe).toHaveBeenCalledTimes(7);
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(onLogout).not.toHaveBeenCalled();
  });

  it("does not invalidate a verified desktop session when workspace loading fails", async () => {
    const listWorkspaces = vi
      .fn()
      .mockRejectedValue(new TypeError("network unavailable"));
    const api = makeApi({ listWorkspaces });
    const { onLogout, queryClient } = renderInitializer({ api });

    await waitFor(() => {
      expect(useAuthStore.getState().status).toBe("authenticated");
      expect(
        queryClient.getQueryState(workspaceKeys.list())?.status,
      ).toBe("error");
    });
    expect(useAuthStore.getState().user).toEqual(fakeUser);
    expect(onLogout).not.toHaveBeenCalled();
  });

  it("publishes web auth independently when workspace loading fails", async () => {
    const listWorkspaces = vi
      .fn()
      .mockRejectedValue(new TypeError("backend restarting"));
    const api = makeApi({ listWorkspaces });
    const { onLogout, queryClient } = renderInitializer({
      api,
      cookieAuth: true,
      platform: "web",
    });

    await waitFor(() => {
      expect(useAuthStore.getState().status).toBe("authenticated");
      expect(queryClient.getQueryState(workspaceKeys.list())?.status).toBe(
        "error",
      );
    });
    expect(useAuthStore.getState().user).toEqual(fakeUser);
    expect(onLogout).not.toHaveBeenCalled();
  });

  it("reloads app config after auth recovers from a transient failure", async () => {
    const getConfig = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("network unavailable"))
      .mockResolvedValue({ feature_flags: { recovered: true } });
    const getMe = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("network unavailable"))
      .mockResolvedValue(fakeUser);
    const api = makeApi({ getConfig, getMe });
    renderInitializer({ api });

    await waitFor(() => {
      expect(useAuthStore.getState().status).toBe("recovering");
    });
    act(() => useAuthStore.getState().retryAuthentication());

    await waitFor(() => {
      expect(useAuthStore.getState().status).toBe("authenticated");
      expect(getConfig).toHaveBeenCalledTimes(2);
    });
  });

  it("keeps retrying app config until it loads", async () => {
    vi.useFakeTimers();
    const getConfig = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("network unavailable"))
      .mockRejectedValueOnce(new TypeError("still unavailable"))
      .mockResolvedValue({ feature_flags: { recovered: true } });
    const api = makeApi({ getConfig });
    renderInitializer({ api });

    await act(async () => {
      await Promise.resolve();
    });
    expect(getConfig).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });
    expect(getConfig).toHaveBeenCalledTimes(3);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(getConfig).toHaveBeenCalledTimes(3);
  });

  it("publishes a definitive logout for a genuine 401", async () => {
    const storage = makeStorage({ multica_token: "token-1" });
    const getMe = vi.fn().mockImplementation(() => {
      storage.removeItem("multica_token");
      return Promise.reject(new ApiError("unauthorized", 401, "Unauthorized"));
    });
    const api = makeApi({ getMe });
    const { onLogout } = renderInitializer({ api, storage });

    await waitFor(() => {
      expect(useAuthStore.getState().status).toBe("unauthenticated");
    });
    expect(storage.snapshot().multica_token).toBeUndefined();
    expect(onLogout).toHaveBeenCalledOnce();
  });
});

describe("AuthInitializer dev auto-login", () => {
  const devAutoLogin = { email: "dev@localhost", code: "888888" };

  it("signs in without the login screen when no token is stored", async () => {
    const storage = makeStorage();
    const sendCode = vi.fn().mockResolvedValue(undefined);
    const verifyCode = vi
      .fn()
      .mockResolvedValue({ token: "token-dev", user: fakeUser });
    const setToken = vi.fn();
    const api = makeApi({ sendCode, verifyCode, setToken });
    const { onLogin, onLogout } = renderInitializer({
      api,
      storage,
      devAutoLogin,
    });

    await waitFor(() => {
      expect(useAuthStore.getState().status).toBe("authenticated");
    });
    expect(sendCode).toHaveBeenCalledWith("dev@localhost");
    expect(verifyCode).toHaveBeenCalledWith("dev@localhost", "888888");
    // Desktop reads the token back from storage to start the daemon.
    expect(storage.snapshot().multica_token).toBe("token-dev");
    expect(setToken).toHaveBeenCalledWith("token-dev");
    expect(useAuthStore.getState().user).toEqual(fakeUser);
    expect(onLogin).toHaveBeenCalledOnce();
    expect(onLogout).not.toHaveBeenCalled();
  });

  it("exchanges a stale token for a fresh session exactly once", async () => {
    const storage = makeStorage({ multica_token: "token-stale" });
    const getMe = vi
      .fn()
      .mockRejectedValue(new ApiError("unauthorized", 401, "Unauthorized"));
    const verifyCode = vi
      .fn()
      .mockResolvedValue({ token: "token-dev", user: fakeUser });
    const api = makeApi({ getMe, verifyCode });
    const { onLogin, onLogout } = renderInitializer({
      api,
      storage,
      devAutoLogin,
    });

    await waitFor(() => {
      expect(useAuthStore.getState().status).toBe("authenticated");
    });
    expect(storage.snapshot().multica_token).toBe("token-dev");
    // A repeated verify-code call can lock the account, so the shortcut must
    // not run again once it has produced a session.
    expect(verifyCode).toHaveBeenCalledOnce();
    expect(onLogin).toHaveBeenCalledOnce();
    expect(onLogout).not.toHaveBeenCalled();
  });

  it("falls back to the login screen when the shortcut is rejected", async () => {
    const storage = makeStorage();
    const verifyCode = vi
      .fn()
      .mockRejectedValue(new ApiError("invalid_code", 400, "Invalid code"));
    const api = makeApi({ verifyCode });
    const { onLogout } = renderInitializer({
      api,
      storage,
      devAutoLogin: { email: "dev@localhost", code: "000000" },
    });

    await waitFor(() => {
      expect(useAuthStore.getState().status).toBe("unauthenticated");
    });
    expect(verifyCode).toHaveBeenCalledOnce();
    expect(storage.snapshot().multica_token).toBeUndefined();
    expect(onLogout).toHaveBeenCalledOnce();
    expect(logger.error).toHaveBeenCalled();
  });
});
