import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@multica/core/i18n/react";
import { configStore } from "@multica/core/config";
import enCommon from "../../locales/en/common.json";
import enRuntimes from "../../locales/en/runtimes.json";
import { ConnectRemoteDialog } from "./connect-remote-dialog";

const TEST_RESOURCES = { en: { common: enCommon, runtimes: enRuntimes } };

vi.mock("@multica/core/hooks", () => ({
  useWorkspaceId: () => "ws-test",
}));

vi.mock("@multica/core/paths", () => ({
  paths: {
    workspace: () => ({
      agents: () => "/agents",
      runtimeDetail: () => "/runtimes/rt-test",
    }),
  },
  useWorkspaceSlug: () => "workspace-test",
}));

const wsEventState = vi.hoisted(() => ({
  handler: null as ((payload: unknown) => void) | null,
}));

vi.mock("@multica/core/realtime", () => ({
  useWSEvent: (_event: string, handler: (payload: unknown) => void) => {
    wsEventState.handler = handler;
  },
}));

vi.mock("../../navigation", () => ({
  useNavigation: () => ({ push: vi.fn() }),
}));

const channelState = vi.hoisted(() => ({
  value: null as { available: boolean; lanURL?: string } | null,
}));

vi.mock("@multica/core/api", () => ({
  api: { getLocalChannel: () => Promise.resolve(channelState.value) },
}));

function resetConfigStore() {
  configStore.setState({
    cdnDomain: "",
    allowSignup: true,
    googleClientId: "",
    daemonServerUrl: "",
    daemonAppUrl: "",
    workspaceCreationDisabled: false,
  });
}

function renderDialog(
  config?: {
    daemonServerUrl?: string;
    daemonAppUrl?: string;
  },
  channel: { available: boolean; lanURL?: string } | null = null,
) {
  resetConfigStore();
  if (config) {
    configStore.getState().setDaemonConfig(config);
  }
  channelState.value = channel;
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <I18nProvider locale="en" resources={TEST_RESOURCES}>
        <ConnectRemoteDialog onClose={vi.fn()} />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

describe("ConnectRemoteDialog", () => {
  beforeEach(() => {
    wsEventState.handler = null;
    channelState.value = null;
  });

  it("uses cloud setup commands by default", () => {
    const { baseElement } = renderDialog();

    expect(baseElement).toHaveTextContent("multica setup");
    expect(baseElement).not.toHaveTextContent("multica setup self-host");
    expect(baseElement).toHaveTextContent(
      "multica config set server_url https://api.multica.ai",
    );
    expect(baseElement).toHaveTextContent(
      "multica config set app_url https://multica.ai",
    );
  });

  it("uses self-host daemon URLs from runtime config", () => {
    const { baseElement } = renderDialog({
      daemonServerUrl: "https://api.example.com/",
      daemonAppUrl: "https://app.example.com/",
    });

    expect(baseElement).toHaveTextContent(
      "multica setup self-host --server-url https://api.example.com --app-url https://app.example.com",
    );
    expect(baseElement).toHaveTextContent(
      "multica config set server_url https://api.example.com",
    );
    expect(baseElement).toHaveTextContent(
      "multica config set app_url https://app.example.com",
    );
  });

  it("points the self-host command at this computer's LAN address", async () => {
    const { baseElement } = renderDialog(
      {
        daemonServerUrl: "http://localhost:18227",
        daemonAppUrl: "http://localhost:13147",
      },
      { available: true, lanURL: "http://192.168.71.124:18227" },
    );

    // The command runs on another computer, where `localhost` is that
    // computer — it has to name the address this machine is reachable at.
    await waitFor(() => {
      expect(baseElement).toHaveTextContent(
        "multica setup self-host --server-url http://192.168.71.124:18227 --app-url http://192.168.71.124:13147",
      );
    });
    // No URL in either command still points at loopback (the hint below the
    // command is allowed to name it).
    expect(baseElement).not.toHaveTextContent("http://localhost");
    expect(baseElement).toHaveTextContent(
      "Other devices reach this computer at 192.168.71.124",
    );
  });

  it("keeps the addresses when the backend reports no LAN channel", () => {
    const { baseElement } = renderDialog(
      {
        daemonServerUrl: "http://localhost:18227",
        daemonAppUrl: "http://localhost:13147",
      },
      { available: false },
    );

    expect(baseElement).toHaveTextContent(
      "multica setup self-host --server-url http://localhost:18227 --app-url http://localhost:13147",
    );
  });

  it("transitions from setup instructions to the connected state", async () => {
    const { baseElement } = renderDialog();

    expect(baseElement).toHaveTextContent("multica setup");
    act(() => {
      wsEventState.handler?.({ runtime_id: "rt-test" });
    });

    await waitFor(() => {
      expect(screen.getByText("Computer connected")).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "Create an agent" }),
      ).toBeInTheDocument();
    });
    expect(baseElement).not.toHaveTextContent("multica setup");
  });
});
