import { describe, expect, it } from "vitest";
import {
  normalizeLocalChannel,
  replaceLoopbackHost,
  tunnelStartCommand,
} from "./local-channel";
import { localChannelOptions } from "./queries";

describe("normalizeLocalChannel", () => {
  it("keeps a fully populated self-hosted payload", () => {
    const channel = normalizeLocalChannel({
      available: true,
      port: 18227,
      lan_url: "http://192.168.71.124:18227",
      lan_ws_url: "ws://192.168.71.124:18227/ws",
      tunnel_url: "https://multica-hmr-l44.loca.lt",
      tunnel_ws_url: "wss://multica-hmr-l44.loca.lt/ws",
      tunnel: {
        detected: true,
        healthy: true,
        pid: 431,
        subdomain: "multica-hmr-l44",
        source: "process",
      },
    });

    expect(channel).toEqual({
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
    });
  });

  it("drops malformed fields instead of throwing", () => {
    const channel = normalizeLocalChannel({
      available: true,
      port: "18227",
      lan_url: 42,
      tunnel_url: "https://multica-hmr-l44.loca.lt",
      tunnel: { detected: "yes", pid: "431" },
    });

    expect(channel.available).toBe(true);
    expect(channel.port).toBeUndefined();
    expect(channel.lanURL).toBeUndefined();
    expect(channel.tunnelURL).toBe("https://multica-hmr-l44.loca.lt");
    // A payload without the ws pair still derives one from the http URL.
    expect(channel.tunnelWSURL).toBe("wss://multica-hmr-l44.loca.lt/ws");
    expect(channel.tunnel.detected).toBe(false);
    expect(channel.tunnel.pid).toBeUndefined();
  });

  it("treats a non-object body as unavailable rather than crashing the page", () => {
    expect(normalizeLocalChannel(null).available).toBe(false);
    expect(normalizeLocalChannel("nope").available).toBe(false);
  });

  it("reads the managed-cloud refusal as unavailable", () => {
    expect(normalizeLocalChannel({ available: false }).available).toBe(false);
  });
});

describe("replaceLoopbackHost", () => {
  const lan = "http://192.168.71.124:18227";

  it("swaps localhost for the LAN IP and keeps the port", () => {
    expect(replaceLoopbackHost("http://localhost:18227", lan)).toBe(
      "http://192.168.71.124:18227",
    );
    expect(replaceLoopbackHost("http://localhost:13147", lan)).toBe(
      "http://192.168.71.124:13147",
    );
  });

  it("swaps every loopback spelling", () => {
    expect(replaceLoopbackHost("http://127.0.0.1:18227", lan)).toBe(
      "http://192.168.71.124:18227",
    );
    expect(replaceLoopbackHost("http://[::1]:18227", lan)).toBe(
      "http://192.168.71.124:18227",
    );
    expect(replaceLoopbackHost("http://localhost:18227/api", lan)).toBe(
      "http://192.168.71.124:18227/api",
    );
  });

  it("leaves an address another device can already reach alone", () => {
    expect(
      replaceLoopbackHost("https://api.example.com", lan),
    ).toBe("https://api.example.com");
    expect(replaceLoopbackHost("http://30.71.188.107:18227", lan)).toBe(
      "http://30.71.188.107:18227",
    );
  });

  it("returns the input when the LAN address or the URL is unusable", () => {
    expect(replaceLoopbackHost("http://localhost:18227", undefined)).toBe(
      "http://localhost:18227",
    );
    expect(replaceLoopbackHost("", lan)).toBe("");
    expect(replaceLoopbackHost("not a url", lan)).toBe("not a url");
  });
});

describe("tunnelStartCommand", () => {
  it("builds a localtunnel command for the probed port", () => {
    expect(tunnelStartCommand(18227)).toBe(
      "npx --yes localtunnel --port 18227 --subdomain multica-hmr-l44",
    );
  });

  it("falls back to an ephemeral subdomain flag when asked for none", () => {
    expect(tunnelStartCommand(18227, "")).toBe(
      "npx --yes localtunnel --port 18227",
    );
  });

  it("returns an empty string without a port to forward", () => {
    expect(tunnelStartCommand(undefined)).toBe("");
  });
});

describe("localChannelOptions", () => {
  it("uses a deployment-scoped key, not a workspace one", () => {
    // The channel describes this backend, so switching workspace must not
    // refetch or, worse, serve another workspace's stale addresses.
    expect(localChannelOptions().queryKey).toEqual(["local-channel"]);
  });
});
