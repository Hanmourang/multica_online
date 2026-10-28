// "How does another device reach this backend?" — the shape behind
// Settings → Runtimes → Phone channel and the Add-a-computer dialog.
//
// The server probes two very different paths: the same-Wi-Fi IPv4 (always
// available when the machine has a network) and a tunnel process the operator
// runs on that same host (only sometimes). Everything here is pure so the
// address rewriting can be tested without a network.

export interface TunnelStatus {
  detected: boolean;
  /** GET <tunnel>/health succeeded when the server answered, i.e. live. */
  healthy: boolean;
  pid?: number;
  subdomain?: string;
  /** "env" = MULTICA_TUNNEL_URL, "process" = a localtunnel CLI was found. */
  source?: "env" | "process";
}

export interface LocalChannel {
  /** False on the managed cloud, where the API node is not tenant-reachable. */
  available: boolean;
  port?: number;
  lanURL?: string;
  lanWSURL?: string;
  tunnelURL?: string;
  tunnelWSURL?: string;
  tunnel: TunnelStatus;
}

const EMPTY_CHANNEL: LocalChannel = {
  available: false,
  tunnel: { detected: false, healthy: false },
};

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function positiveInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.trunc(value)
    : undefined;
}

/** Mirrors the operator's own tunnel so a phone's saved address keeps working. */
export const DEFAULT_TUNNEL_SUBDOMAIN = "multica-hmr-l44";

/**
 * Lenient reader for `GET /api/local-channel`. A self-hosted server that
 * predates this endpoint 404s and a skewed one could send anything; the panel
 * degrades to "nothing to show" rather than taking the Runtimes page down.
 */
export function normalizeLocalChannel(raw: unknown): LocalChannel {
  if (!raw || typeof raw !== "object") return EMPTY_CHANNEL;
  const body = raw as Record<string, unknown>;

  const tunnelRaw =
    body.tunnel && typeof body.tunnel === "object"
      ? (body.tunnel as Record<string, unknown>)
      : {};
  const source = tunnelRaw.source;
  const tunnel: TunnelStatus = {
    detected: tunnelRaw.detected === true,
    healthy: tunnelRaw.healthy === true,
    pid: positiveInt(tunnelRaw.pid),
    subdomain: nonEmptyString(tunnelRaw.subdomain),
    source: source === "env" || source === "process" ? source : undefined,
  };

  const tunnelURL = nonEmptyString(body.tunnel_url);
  const lanURL = nonEmptyString(body.lan_url);

  return {
    available: body.available === true,
    port: positiveInt(body.port),
    lanURL,
    // Older payloads may omit the ws pair; the path is always `<base>/ws`.
    lanWSURL: nonEmptyString(body.lan_ws_url) ?? wsURLFromHTTP(lanURL),
    tunnelURL,
    tunnelWSURL: nonEmptyString(body.tunnel_ws_url) ?? wsURLFromHTTP(tunnelURL),
    tunnel,
  };
}

function wsURLFromHTTP(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    if (url.protocol === "https:") url.protocol = "wss:";
    else if (url.protocol === "http:") url.protocol = "ws:";
    else return undefined;
    url.pathname = `${url.pathname.replace(/\/+$/, "")}/ws`;
    return url.toString();
  } catch {
    return undefined;
  }
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "0.0.0.0"]);

/**
 * Points a `localhost` command URL at the machine's LAN address, keeping the
 * scheme, port, and path.
 *
 * The add-a-computer command runs on a *different* computer, so `localhost`
 * there means that computer — the daemon would talk to nothing. Only loopback
 * hosts are rewritten: an operator who already configured a public domain must
 * keep it, and so must a non-loopback LAN address the server already reported.
 */
export function replaceLoopbackHost(
  url: string | undefined,
  lanURL: string | undefined,
): string | undefined {
  if (!url || !lanURL) return url;

  let lanHost: string;
  try {
    lanHost = new URL(lanURL).hostname;
  } catch {
    return url;
  }
  if (!lanHost) return url;

  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return url;
  }
  if (!LOOPBACK_HOSTS.has(target.hostname.toLowerCase())) return url;

  target.hostname = lanHost;
  const rewritten = target.toString();
  return url.endsWith("/") ? rewritten : rewritten.replace(/\/+$/, "");
}

/**
 * The command that brings the public half of the channel up. `subdomain` is
 * what the operator's setup already uses; pass "" to let localtunnel pick one.
 */
export function tunnelStartCommand(
  port: number | undefined,
  subdomain: string = DEFAULT_TUNNEL_SUBDOMAIN,
): string {
  if (!port) return "";
  const base = `npx --yes localtunnel --port ${port}`;
  return subdomain ? `${base} --subdomain ${subdomain}` : base;
}
