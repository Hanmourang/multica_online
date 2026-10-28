import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@multica/core/i18n/react";
import type { LocalChannel } from "@multica/core/runtimes/local-channel";
import enCommon from "../../locales/en/common.json";
import enRuntimes from "../../locales/en/runtimes.json";
import { PhoneChannelDialog } from "./phone-channel-dialog";

const TEST_RESOURCES = { en: { common: enCommon, runtimes: enRuntimes } };

const channelState = vi.hoisted(() => ({ value: null as LocalChannel | Error | null }));

vi.mock("@multica/core/api", () => ({
  api: {
    getLocalChannel: () =>
      channelState.value instanceof Error
        ? Promise.reject(channelState.value)
        : Promise.resolve(channelState.value),
  },
}));

function renderDialog(channel: LocalChannel | Error | null) {
  channelState.value = channel;
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <I18nProvider locale="en" resources={TEST_RESOURCES}>
        <PhoneChannelDialog onClose={vi.fn()} />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

const FULL_CHANNEL: LocalChannel = {
  available: true,
  port: 18227,
  lanURL: "http://192.168.71.124:18227",
  lanWSURL: "ws://192.168.71.124:18227/ws",
  tunnelURL: "https://multica-hmr-l44.loca.lt",
  tunnelWSURL: "wss://multica-hmr-l44.loca.lt/ws",
  tunnel: {
    detected: true,
    healthy: true,
    pid: 431,
    subdomain: "multica-hmr-l44",
    source: "process",
  },
};

describe("PhoneChannelDialog", () => {
  beforeEach(() => {
    channelState.value = null;
  });

  it("lists the public pair and the same-Wi-Fi pair", async () => {
    renderDialog(FULL_CHANNEL);

    expect(
      await screen.findByText("https://multica-hmr-l44.loca.lt"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("wss://multica-hmr-l44.loca.lt/ws"),
    ).toBeInTheDocument();
    // The LAN pair must come from the same probe, never from localhost.
    expect(screen.getByText("http://192.168.71.124:18227")).toBeInTheDocument();
    expect(
      screen.getByText("ws://192.168.71.124:18227/ws"),
    ).toBeInTheDocument();
    expect(screen.queryByText(/localhost/)).not.toBeInTheDocument();
  });

  it("reports the tunnel process and whether it answers", async () => {
    renderDialog(FULL_CHANNEL);

    expect(await screen.findByText("reachable")).toBeInTheDocument();
    expect(screen.getByText("Tunnel running (PID 431)")).toBeInTheDocument();
  });

  it("flags a tunnel that no longer answers instead of hiding it", async () => {
    renderDialog({
      ...FULL_CHANNEL,
      tunnel: { ...FULL_CHANNEL.tunnel, healthy: false },
    });

    expect(await screen.findByText("not answering")).toBeInTheDocument();
  });

  it("offers the command that brings the tunnel up", async () => {
    renderDialog({
      available: true,
      port: 18227,
      lanURL: "http://192.168.71.124:18227",
      tunnel: { detected: false, healthy: false },
    });

    expect(await screen.findByText("No tunnel running")).toBeInTheDocument();
    expect(
      screen.getByText(
        "npx --yes localtunnel --port 18227 --subdomain multica-hmr-l44",
      ),
    ).toBeInTheDocument();
  });

  it("says so when the machine has no LAN address", async () => {
    renderDialog({
      available: true,
      port: 18227,
      tunnel: { detected: false, healthy: false },
    });

    expect(
      await screen.findByText(/No LAN address/),
    ).toBeInTheDocument();
  });

  it("survives a server that has no such endpoint", async () => {
    // A real ApiError carries `status`; localChannelOptions skips its retries
    // on 404/405 so the degraded view shows up immediately.
    renderDialog(Object.assign(new Error("404"), { status: 404 }));

    // Still renders the two sections rather than a blank dialog.
    expect(await screen.findByText("Over the internet")).toBeInTheDocument();
    expect(screen.getByText("Same Wi-Fi")).toBeInTheDocument();
  });
});
