package handler

import (
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

// LocalChannel answers "how does another device reach this backend?" for the
// Settings → Runtimes "phone channel" panel and the add-computer dialog.
//
// Two paths matter in practice: same Wi-Fi (the machine's routable IPv4) and
// over the internet (a tunnel process the operator runs on the same host,
// because this server has no public ingress of its own).
type LocalChannel struct {
	// Available is false on the managed cloud, where the API node's private
	// network is operator infrastructure rather than something a tenant can
	// dial into.
	Available   bool         `json:"available"`
	Port        int          `json:"port,omitempty"`
	LANURL      string       `json:"lan_url,omitempty"`
	LANWSURL    string       `json:"lan_ws_url,omitempty"`
	TunnelURL   string       `json:"tunnel_url,omitempty"`
	TunnelWSURL string       `json:"tunnel_ws_url,omitempty"`
	Tunnel      TunnelStatus `json:"tunnel"`
}

type TunnelStatus struct {
	Detected bool `json:"detected"`
	// Healthy is the result of GET <tunnel>/health, i.e. the address is
	// currently reachable rather than a leftover from a dead process.
	Healthy   bool   `json:"healthy"`
	PID       int    `json:"pid,omitempty"`
	Subdomain string `json:"subdomain,omitempty"`
	// Source is "env" when MULTICA_TUNNEL_URL configured the address, or
	// "process" when a localtunnel process forwarding this port was found.
	Source string `json:"source,omitempty"`
}

type tunnelProcess struct {
	pid       int
	subdomain string
}

type localChannelInput struct {
	port     int
	secure   bool
	lanIP    string
	psOutput string
	getenv   func(string) string
}

// buildLocalChannel is the pure half of the probe: everything is passed in so
// the address composition can be tested without a real network or process table.
func buildLocalChannel(in localChannelInput) LocalChannel {
	ch := LocalChannel{Available: true, Port: in.port}

	scheme, wsScheme := "http", "ws"
	if in.secure {
		scheme, wsScheme = "https", "wss"
	}
	if in.lanIP != "" && in.port > 0 {
		ch.LANURL = fmt.Sprintf("%s://%s:%d", scheme, in.lanIP, in.port)
		ch.LANWSURL = fmt.Sprintf("%s://%s:%d/ws", wsScheme, in.lanIP, in.port)
	}

	// An explicit operator setting wins: it survives a tunnel restarted under a
	// different process shape (docker, systemd unit, different CLI).
	if base := normalizePublicURL(in.getenv("MULTICA_TUNNEL_URL")); base != "" {
		ch.TunnelURL = tunnelBaseURL(base)
		ch.Tunnel = TunnelStatus{
			Detected:  ch.TunnelURL != "",
			Source:    "env",
			Subdomain: tunnelSubdomain(ch.TunnelURL),
		}
	} else if proc, ok := parseLocaltunnelProcesses(in.psOutput, in.port); ok {
		ch.TunnelURL = tunnelBaseURL(proc.subdomain)
		ch.Tunnel = TunnelStatus{
			Detected:  ch.TunnelURL != "",
			Source:    "process",
			PID:       proc.pid,
			Subdomain: proc.subdomain,
		}
	}

	if ch.TunnelURL != "" {
		ch.TunnelWSURL = wsURLFromHTTP(ch.TunnelURL)
	}
	return ch
}

var (
	tunnelPortFlagRe  = regexp.MustCompile(`--port[=\s]+(\d+)`)
	tunnelSubdomainRe = regexp.MustCompile(`--subdomain[=\s]+([A-Za-z0-9-]+)`)
	// Hostname charset only — the probe performs an outbound request to whatever
	// it resolves, so anything outside a plain DNS label is rejected.
	tunnelHostRe = regexp.MustCompile(`^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*$`)
)

// parseLocaltunnelProcesses finds a localtunnel process forwarding `port`.
// A tunnel for a *different* port is not this backend's channel, so it is
// skipped rather than reported as stale.
func parseLocaltunnelProcesses(psOutput string, port int) (tunnelProcess, bool) {
	for _, line := range strings.Split(psOutput, "\n") {
		line = strings.TrimSpace(line)
		if line == "" || !strings.Contains(line, "localtunnel") {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) < 2 {
			continue
		}
		pid, err := strconv.Atoi(fields[0])
		if err != nil {
			continue
		}

		portMatch := tunnelPortFlagRe.FindStringSubmatch(line)
		if portMatch == nil {
			continue
		}
		forwardedPort, err := strconv.Atoi(portMatch[1])
		if err != nil || forwardedPort != port {
			continue
		}

		subdomain := ""
		if subMatch := tunnelSubdomainRe.FindStringSubmatch(line); subMatch != nil {
			subdomain = strings.Trim(subMatch[1], ".")
		}
		return tunnelProcess{pid: pid, subdomain: subdomain}, true
	}
	return tunnelProcess{}, false
}

// tunnelBaseURL normalizes the three shapes operators write: a bare subdomain,
// a bare host, or a full URL.
func tunnelBaseURL(raw string) string {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return ""
	}
	if strings.HasPrefix(raw, "http://") || strings.HasPrefix(raw, "https://") {
		u, err := url.Parse(raw)
		if err != nil || u.Host == "" || !tunnelHostRe.MatchString(u.Hostname()) {
			return ""
		}
		return strings.TrimRight(raw, "/")
	}
	raw = strings.TrimRight(raw, "/")
	if !tunnelHostRe.MatchString(raw) {
		return ""
	}
	if strings.Contains(raw, ".") {
		return "https://" + raw
	}
	return "https://" + raw + ".loca.lt"
}

func tunnelSubdomain(base string) string {
	u, err := url.Parse(base)
	if err != nil {
		return ""
	}
	host := u.Hostname()
	if host == "" {
		return ""
	}
	return strings.Split(host, ".")[0]
}

// wsURLFromHTTP derives the websocket endpoint clients connect to (`<base>/ws`).
func wsURLFromHTTP(raw string) string {
	u, err := url.Parse(strings.TrimRight(strings.TrimSpace(raw), "/"))
	if err != nil || u.Scheme == "" || u.Host == "" {
		return ""
	}
	switch u.Scheme {
	case "https":
		u.Scheme = "wss"
	case "http":
		u.Scheme = "ws"
	default:
		return ""
	}
	u.Path = strings.TrimRight(u.Path, "/") + "/ws"
	u.RawQuery = ""
	u.Fragment = ""
	return u.String()
}

type lanAddress struct {
	iface string
	ip    net.IP
}

// Interfaces that are never reachable from another device on the LAN: tunnels
// (utun), peer-to-peer Wi-Fi (awdl), VM bridges, and the like.
var virtualInterfacePrefixes = []string{
	"utun", "awdl", "llw", "bridge", "anpi", "gif", "stf", "p2p", "ap",
}

// pickLANIPv4 chooses the address another device should dial. Corporate and
// tailnet ranges are not RFC1918, so public addresses are still eligible — the
// ordering only prefers a wired/wireless `en*` interface with a private address.
func pickLANIPv4(addrs []lanAddress) string {
	best := ""
	bestScore := 0

	for _, addr := range addrs {
		if addr.ip == nil {
			continue
		}
		ip4 := addr.ip.To4()
		if ip4 == nil || ip4.IsLoopback() || ip4.IsUnspecified() || ip4.IsLinkLocalUnicast() {
			continue
		}
		name := strings.ToLower(addr.iface)
		virtual := false
		for _, prefix := range virtualInterfacePrefixes {
			if strings.HasPrefix(name, prefix) {
				virtual = true
				break
			}
		}
		if virtual {
			continue
		}

		score := 4
		switch {
		case strings.HasPrefix(name, "en") && ip4.IsPrivate():
			score = 1
		case ip4.IsPrivate():
			score = 2
		case strings.HasPrefix(name, "en"):
			score = 3
		}
		if best == "" || score < bestScore {
			best = ip4.String()
			bestScore = score
		}
	}
	return best
}

func detectLANIPv4() string {
	ifaces, err := net.Interfaces()
	if err != nil {
		return ""
	}
	var addrs []lanAddress
	for _, iface := range ifaces {
		if iface.Flags&net.FlagUp == 0 {
			continue
		}
		list, err := iface.Addrs()
		if err != nil {
			continue
		}
		for _, entry := range list {
			var ip net.IP
			switch v := entry.(type) {
			case *net.IPNet:
				ip = v.IP
			case *net.IPAddr:
				ip = v.IP
			}
			if ip != nil {
				addrs = append(addrs, lanAddress{iface: iface.Name, ip: ip})
			}
		}
	}
	return pickLANIPv4(addrs)
}

func readProcessTable() string {
	out, err := exec.Command("ps", "-axo", "pid=,command=").Output()
	if err != nil {
		return ""
	}
	return string(out)
}

// The first request through a freshly started localtunnel pays DNS, TLS, and
// proxy setup — measured at ~3s on a warm host, so a 3s budget reports a
// healthy tunnel as dead exactly once, right when the operator opened the
// panel to check it. The probe runs at most once per cache window.
const tunnelHealthTimeout = 5 * time.Second

func probeTunnelHealth(ctx context.Context, base string) bool {
	if base == "" {
		return false
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, base+"/health", nil)
	if err != nil {
		return false
	}
	client := &http.Client{
		Timeout: tunnelHealthTimeout,
		// A tunnel that answers with a redirect is not serving this API, and
		// following one would let the probe reach an address it never vetted.
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
	resp, err := client.Do(req)
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, resp.Body)
	return resp.StatusCode == http.StatusOK
}

func portFromRequest(r *http.Request) int {
	if _, portStr, err := net.SplitHostPort(r.Host); err == nil {
		if port, err := strconv.Atoi(portStr); err == nil && port > 0 {
			return port
		}
	}
	if port, err := strconv.Atoi(strings.TrimSpace(os.Getenv("PORT"))); err == nil && port > 0 {
		return port
	}
	if requestIsSecure(r) {
		return 443
	}
	return 80
}

func requestIsSecure(r *http.Request) bool {
	if r.TLS != nil {
		return true
	}
	return strings.EqualFold(strings.TrimSpace(r.Header.Get("X-Forwarded-Proto")), "https")
}

// The probe shells out to `ps` and calls the tunnel's /health endpoint; both
// are cached so a page that loads the dialog repeatedly does not pay for them
// on every request. The LAN address itself can change (Wi-Fi switch, VPN), so
// the cache stays short.
const localChannelCacheTTL = 10 * time.Second

var (
	localChannelMu       sync.Mutex
	localChannelCached   LocalChannel
	localChannelCachedAt time.Time
)

// GetLocalChannel reports the addresses other devices can use to reach this
// backend: the same-Wi-Fi IPv4 and, when a tunnel is running, its public
// https/wss pair. Requires auth and is disabled on the managed cloud.
func (h *Handler) GetLocalChannel(w http.ResponseWriter, r *http.Request) {
	if isOfficialCloudDeployment() {
		writeJSON(w, http.StatusOK, LocalChannel{
			Available: false,
			Tunnel:    TunnelStatus{},
		})
		return
	}
	writeJSON(w, http.StatusOK, probeLocalChannel(r))
}

func probeLocalChannel(r *http.Request) LocalChannel {
	localChannelMu.Lock()
	defer localChannelMu.Unlock()

	if !localChannelCachedAt.IsZero() && time.Since(localChannelCachedAt) < localChannelCacheTTL {
		return localChannelCached
	}

	ch := buildLocalChannel(localChannelInput{
		port:     portFromRequest(r),
		secure:   requestIsSecure(r),
		lanIP:    detectLANIPv4(),
		psOutput: readProcessTable(),
		getenv:   os.Getenv,
	})
	if ch.TunnelURL != "" {
		ctx, cancel := context.WithTimeout(r.Context(), tunnelHealthTimeout)
		ch.Tunnel.Healthy = probeTunnelHealth(ctx, ch.TunnelURL)
		cancel()
	}

	localChannelCached = ch
	localChannelCachedAt = time.Now()
	return ch
}
