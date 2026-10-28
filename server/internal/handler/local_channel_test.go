package handler

import (
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func resetLocalChannelCache() {
	localChannelMu.Lock()
	localChannelCachedAt = time.Time{}
	localChannelCached = LocalChannel{}
	localChannelMu.Unlock()
}

func TestPickLANIPv4SkipsLoopbackAndVirtualInterfaces(t *testing.T) {
	got := pickLANIPv4([]lanAddress{
		{iface: "lo0", ip: net.ParseIP("127.0.0.1")},
		{iface: "utun3", ip: net.ParseIP("100.64.1.2")},
		{iface: "awdl0", ip: net.ParseIP("fe80::1234")},
		{iface: "en0", ip: net.ParseIP("192.168.71.124")},
		{iface: "en1", ip: net.ParseIP("10.0.0.9")},
	})

	// en0 wins over the other physical candidate regardless of list order.
	if got != "192.168.71.124" {
		t.Fatalf("want en0 address, got %q", got)
	}
}

func TestPickLANIPv4FallsBackToAnyRoutableAddress(t *testing.T) {
	// 30.x is a public block: machines on corp/tailnet ranges still need a
	// dialable address, so private-ness only breaks ties.
	got := pickLANIPv4([]lanAddress{
		{iface: "lo0", ip: net.ParseIP("127.0.0.1")},
		{iface: "en0", ip: net.ParseIP("30.71.188.107")},
	})

	if got != "30.71.188.107" {
		t.Fatalf("want en0 public address, got %q", got)
	}
}

func TestPickLANIPv4ReturnsEmptyWhenOnlyLoopbackExists(t *testing.T) {
	got := pickLANIPv4([]lanAddress{
		{iface: "lo0", ip: net.ParseIP("127.0.0.1")},
		{iface: "lo0", ip: net.ParseIP("::1")},
	})

	if got != "" {
		t.Fatalf("want no address, got %q", got)
	}
}

const psSample = `  431 npx --yes localtunnel --port 18227 --subdomain multica-hmr-l44
 93134 node /Users/eleme/.npm/_npx/abc/node_modules/.bin/lt --port 18227 --subdomain multica-hmr-l44
  512 ps -axo pid=,command=
`

func TestParseLocaltunnelProcessesMatchesForwardedPort(t *testing.T) {
	proc, ok := parseLocaltunnelProcesses(psSample, 18227)

	if !ok {
		t.Fatal("expected a match")
	}
	if proc.subdomain != "multica-hmr-l44" {
		t.Fatalf("want subdomain multica-hmr-l44, got %q", proc.subdomain)
	}
	if proc.pid != 431 && proc.pid != 93134 {
		t.Fatalf("want a real pid, got %d", proc.pid)
	}
}

func TestParseLocaltunnelProcessesIgnoresOtherPorts(t *testing.T) {
	if _, ok := parseLocaltunnelProcesses(psSample, 9999); ok {
		t.Fatal("a tunnel for another port is not this backend's channel")
	}
}

func TestParseLocaltunnelProcessesIgnoresUnrelatedProcesses(t *testing.T) {
	if _, ok := parseLocaltunnelProcesses("777 vim server/config.go\n", 18227); ok {
		t.Fatal("unrelated processes must not be reported as a tunnel")
	}
}

func TestWSURLFromHTTP(t *testing.T) {
	cases := map[string]string{
		"https://multica-hmr-l44.loca.lt": "wss://multica-hmr-l44.loca.lt/ws",
		"http://192.168.71.124:18227":     "ws://192.168.71.124:18227/ws",
		"http://192.168.71.124:18227/":    "ws://192.168.71.124:18227/ws",
		"http://192.168.71.124:18227/api": "ws://192.168.71.124:18227/api/ws",
		"multica-hmr-l44.loca.lt":         "",
	}

	for in, want := range cases {
		if got := wsURLFromHTTP(in); got != want {
			t.Fatalf("wsURLFromHTTP(%q): want %q, got %q", in, want, got)
		}
	}
}

func TestTunnelBaseURL(t *testing.T) {
	cases := map[string]string{
		"multica-hmr-l44":                 "https://multica-hmr-l44.loca.lt",
		"multica-hmr-l44.loca.lt":         "https://multica-hmr-l44.loca.lt",
		"https://multica-hmr-l44.loca.lt": "https://multica-hmr-l44.loca.lt",
		"":                                "",
	}

	for in, want := range cases {
		if got := tunnelBaseURL(in); got != want {
			t.Fatalf("tunnelBaseURL(%q): want %q, got %q", in, want, got)
		}
	}
}

func TestBuildLocalChannelUsesTunnelFromEnvironment(t *testing.T) {
	env := func(key string) string {
		if key == "MULTICA_TUNNEL_URL" {
			return "https://multica-hmr-l44.loca.lt/"
		}
		return ""
	}

	ch := buildLocalChannel(localChannelInput{
		port:     18227,
		secure:   false,
		lanIP:    "192.168.71.124",
		psOutput: psSample,
		getenv:   env,
	})

	if ch.LANURL != "http://192.168.71.124:18227" {
		t.Fatalf("lan url: %q", ch.LANURL)
	}
	if ch.LANWSURL != "ws://192.168.71.124:18227/ws" {
		t.Fatalf("lan ws url: %q", ch.LANWSURL)
	}
	if ch.TunnelURL != "https://multica-hmr-l44.loca.lt" {
		t.Fatalf("tunnel url: %q", ch.TunnelURL)
	}
	if ch.TunnelWSURL != "wss://multica-hmr-l44.loca.lt/ws" {
		t.Fatalf("tunnel ws url: %q", ch.TunnelWSURL)
	}
	if !ch.Tunnel.Detected || ch.Tunnel.Source != "env" {
		t.Fatalf("tunnel status: %+v", ch.Tunnel)
	}
}

func TestBuildLocalChannelDetectsLocaltunnelProcess(t *testing.T) {
	ch := buildLocalChannel(localChannelInput{
		port:     18227,
		secure:   true,
		lanIP:    "192.168.71.124",
		psOutput: psSample,
		getenv:   func(string) string { return "" },
	})

	if ch.TunnelURL != "https://multica-hmr-l44.loca.lt" {
		t.Fatalf("tunnel url: %q", ch.TunnelURL)
	}
	if ch.Tunnel.Source != "process" || ch.Tunnel.PID == 0 {
		t.Fatalf("tunnel status: %+v", ch.Tunnel)
	}
	// The request arrived over TLS (reverse proxy), so client-facing URLs follow it.
	if ch.LANURL != "https://192.168.71.124:18227" {
		t.Fatalf("lan url: %q", ch.LANURL)
	}
}

func TestBuildLocalChannelWithoutTunnelOrLAN(t *testing.T) {
	ch := buildLocalChannel(localChannelInput{
		port:     18227,
		lanIP:    "",
		psOutput: "",
		getenv:   func(string) string { return "" },
	})

	if ch.TunnelURL != "" || ch.LANURL != "" {
		t.Fatalf("expected no addresses, got %+v", ch)
	}
	if ch.Tunnel.Detected {
		t.Fatal("no tunnel should be reported")
	}
	if !ch.Available {
		t.Fatal("the channel endpoint itself is still available")
	}
}

func TestGetLocalChannelRefusesOnManagedCloud(t *testing.T) {
	// multica.ai is the managed cloud: the API node's private network is not
	// something a tenant can dial into, so the panel stays hidden there.
	t.Setenv("MULTICA_APP_URL", "https://multica.ai")
	t.Setenv("FRONTEND_ORIGIN", "")
	resetLocalChannelCache()

	rec := httptest.NewRecorder()
	newTestHandler(Config{}).GetLocalChannel(
		rec,
		httptest.NewRequest(http.MethodGet, "http://localhost:18227/api/local-channel", nil),
	)

	if rec.Code != http.StatusOK {
		t.Fatalf("status: %d", rec.Code)
	}
	var got LocalChannel
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if got.Available {
		t.Fatalf("the managed cloud must refuse: %+v", got)
	}
	if got.LANURL != "" || got.TunnelURL != "" {
		t.Fatalf("the managed cloud must not leak addresses: %+v", got)
	}
}

// Exercises the real probe (interfaces, process table, cache) rather than the
// pure helpers: the addresses the panel shows come out of this path.
func TestGetLocalChannelReportsThisMachine(t *testing.T) {
	t.Setenv("MULTICA_APP_URL", "")
	t.Setenv("FRONTEND_ORIGIN", "")
	t.Setenv("MULTICA_TUNNEL_URL", "")
	resetLocalChannelCache()
	t.Cleanup(resetLocalChannelCache)

	rec := httptest.NewRecorder()
	newTestHandler(Config{}).GetLocalChannel(
		rec,
		httptest.NewRequest(http.MethodGet, "http://192.168.71.124:18227/api/local-channel", nil),
	)

	if rec.Code != http.StatusOK {
		t.Fatalf("status: %d, body: %s", rec.Code, rec.Body.String())
	}
	var got LocalChannel
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if !got.Available {
		t.Fatalf("a self-hosted deployment is available: %+v", got)
	}
	if got.Port != 18227 {
		t.Fatalf("port comes from the request host: %+v", got)
	}
	// A machine with no network has no LAN pair; that is reported, not faked.
	if got.LANURL != "" {
		if !strings.HasSuffix(got.LANURL, ":18227") || !strings.HasPrefix(got.LANURL, "http://") {
			t.Fatalf("lan url: %q", got.LANURL)
		}
		host := strings.TrimSuffix(strings.TrimPrefix(got.LANURL, "http://"), ":18227")
		if parsed := net.ParseIP(host); parsed == nil || parsed.IsLoopback() {
			t.Fatalf("lan url must name a real interface address: %q", host)
		}
		if got.LANWSURL != strings.Replace(got.LANURL, "http://", "ws://", 1)+"/ws" {
			t.Fatalf("lan ws url: %q", got.LANWSURL)
		}
	}
	// The probe caches for 10s, so a second call answers from memory.
	resetLocalChannelCache()
	cached := probeLocalChannel(httptest.NewRequest(http.MethodGet, "http://192.168.71.124:18227/api/local-channel", nil))
	if cached.Port != 18227 {
		t.Fatalf("cached probe: %+v", cached)
	}
}
