package handler

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/multica-ai/multica/server/internal/auth"
)

// 原型预览 HTML 里带着境外依赖：Tailwind Play CDN（脚本）、Google Fonts 的
// 样式与字体文件、Google 头像图。国内客户端直连这些域名会挂到二三十秒才超时，
// 而 <link rel=stylesheet> 是渲染阻塞资源 —— 「功能模块 → 原型图」一打开就是
// 十几秒白屏，样式到齐之前整块区域都是空的。
//
// 这里由服务器代取一次并缓存，预览 HTML 里的引用改写成同源路径，浏览器于是只
// 连本机站点。白名单是精确 host 匹配（不做后缀匹配），避免这个端点变成通用
// 代理。
// 端点本身是不鉴权的，签名就是凭证 —— 和 /api/avatars/<sig>/* 同一套理由：预览
// iframe 是 sandbox="allow-scripts" 的 srcdoc 文档，属于不透明源，它发出的
// <script>/<link>/<img> 子资源请求既不带 multica_auth（SameSite=Strict）cookie
// 也不带 Authorization 头。鉴权路由在这里只会 401，Tailwind 与字体一个都进不来。
const (
	previewAssetMaxBytes = 8 << 20
	previewAssetTimeout  = 8 * time.Second
	previewAssetTTL      = 24 * time.Hour
	previewAssetFailTTL  = 2 * time.Minute
	previewAssetPath     = "/api/preview-assets"
	// 一次签发请求最多带多少个地址。原型页通常十来个，留足余量即可。
	previewAssetSignMaxURLs = 64
)

var previewAssetHosts = map[string]struct{}{
	"cdn.tailwindcss.com":       {},
	"fonts.googleapis.com":      {},
	"fonts.gstatic.com":         {},
	"lh3.googleusercontent.com": {},
	// 镜像域名。原型引用里永远不会出现它们，是代理内部换上游时取到的地址；
	// 镜像返回的 CSS 里字体仍指向镜像自己，所以重写后的路径也必须能签发。
	"fonts.googleapis.cn": {},
	"fonts.gstatic.cn":    {},
}

// previewAssetMirror 是「原站 → 可达镜像」的固定映射。
//
// fonts.googleapis.com / fonts.gstatic.com 在国内整体不可达（实测 IPv4 也是
// 12s 超时），而同一套字体在 .cn 镜像上 0.3s 就返回，字体文件还带
// Access-Control-Allow-Origin: *。代理直接走镜像，浏览器侧拿到的是同一份内容；
// HTML 与签名都不需要知道这件事。
var previewAssetMirror = map[string]string{
	"fonts.googleapis.com": "fonts.googleapis.cn",
	"fonts.gstatic.com":    "fonts.gstatic.cn",
}

// previewAssetUpstream 把白名单里的原站换成镜像；没有镜像的 host 原样返回。
func previewAssetUpstream(target string) string {
	parsed, err := url.Parse(target)
	if err != nil {
		return target
	}
	mirror, ok := previewAssetMirror[strings.ToLower(parsed.Hostname())]
	if !ok {
		return target
	}
	parsed.Host = mirror
	return parsed.String()
}

var (
	previewAssetSigningKeyOnce sync.Once
	previewAssetSigningKey     []byte
)

// previewAssetURLSigningKey 从 JWT_SECRET 派生一个本用途专用的 HMAC key，避免
// 与会话 token、头像 URL 共用同一把钥匙（同 avatarURLSigningKey 的做法）。
func previewAssetURLSigningKey() []byte {
	previewAssetSigningKeyOnce.Do(func() {
		sum := sha256.Sum256(append([]byte("preview-asset:"), auth.JWTSecret()...))
		previewAssetSigningKey = sum[:]
	})
	return previewAssetSigningKey
}

func signPreviewAssetTarget(target string) string {
	mac := hmac.New(sha256.New, previewAssetURLSigningKey())
	mac.Write([]byte(target))
	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

func previewAssetSignatureValid(target, sig string) bool {
	return hmac.Equal([]byte(sig), []byte(signPreviewAssetTarget(target)))
}

// previewAssetSignedPath 是「规范化目标 → 同源路径」的唯一入口：路径里的签名只
// 覆盖规范化后的 URL，所以签发与校验两侧必须先走同一个 normalize。
func previewAssetSignedPath(target string) string {
	return previewAssetPath + "/" + signPreviewAssetTarget(target) + "?u=" + url.QueryEscape(target)
}

// PreviewAssetProxyPath 返回某个绝对 URL 对应的同源代理路径（已签名）。前端
// 重写 HTML 里的远程引用时用同一份规则，两侧必须保持一致。
func PreviewAssetProxyPath(raw string) string {
	target, err := normalizePreviewAssetTarget(raw)
	if err != nil {
		// 前端只会传白名单地址；万一传了别的，也给出代理路径让浏览器快速失败，
		// 而不是退回境外直连（那才是十几秒白屏）。
		target = raw
	}
	return previewAssetSignedPath(target)
}

func isPreviewAssetHost(host string) bool {
	_, ok := previewAssetHosts[strings.ToLower(host)]
	return ok
}

// normalizePreviewAssetTarget 只放行 https + 白名单 host 的绝对地址。
func normalizePreviewAssetTarget(raw string) (string, error) {
	if raw == "" {
		return "", errors.New("missing u parameter")
	}
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Scheme != "https" || parsed.Host == "" {
		return "", errors.New("u must be an absolute https URL")
	}
	if !isPreviewAssetHost(parsed.Hostname()) {
		return "", fmt.Errorf("host %q is not a preview asset host", parsed.Hostname())
	}
	return parsed.String(), nil
}

type previewAssetEntry struct {
	body        []byte
	contentType string
	expiresAt   time.Time
	// failed marks a negative cache entry: the upstream did not answer (or
	// answered non-200) last time, so stop paying the timeout on every open.
	failed bool
}

// previewAssetCall deduplicates concurrent fetches of the same upstream URL:
// one prototype can ask for a dozen font files at once, and the first open of
// a cold cache would otherwise fetch each of them twice.
type previewAssetCall struct {
	done  chan struct{}
	entry previewAssetEntry
	err   error
}

type previewAssetCache struct {
	mu       sync.Mutex
	entries  map[string]previewAssetEntry
	inflight map[string]*previewAssetCall
}

var previewAssets = &previewAssetCache{
	entries:  map[string]previewAssetEntry{},
	inflight: map[string]*previewAssetCall{},
}

func previewAssetKey(target string) string {
	sum := sha256.Sum256([]byte(target))
	return hex.EncodeToString(sum[:])
}

func (c *previewAssetCache) lookup(key string) (previewAssetEntry, bool) {
	entry, ok := c.entries[key]
	if !ok {
		return previewAssetEntry{}, false
	}
	if time.Now().After(entry.expiresAt) {
		delete(c.entries, key)
		return previewAssetEntry{}, false
	}
	return entry, true
}

// getOrFetch serves from cache or fetches once for all concurrent callers.
func (c *previewAssetCache) getOrFetch(
	ctx context.Context,
	key string,
	target string,
) (previewAssetEntry, error) {
	c.mu.Lock()
	if entry, ok := c.lookup(key); ok {
		c.mu.Unlock()
		return entry, nil
	}
	if call, ok := c.inflight[key]; ok {
		c.mu.Unlock()
		select {
		case <-call.done:
			return call.entry, call.err
		case <-ctx.Done():
			return previewAssetEntry{}, ctx.Err()
		}
	}
	call := &previewAssetCall{done: make(chan struct{})}
	c.inflight[key] = call
	c.mu.Unlock()

	body, contentType, err := fetchPreviewAsset(ctx, target)

	c.mu.Lock()
	if err != nil {
		call.err = err
		c.entries[key] = previewAssetEntry{failed: true, expiresAt: time.Now().Add(previewAssetFailTTL)}
	} else {
		call.entry = previewAssetEntry{
			body:        body,
			contentType: contentType,
			expiresAt:   time.Now().Add(previewAssetTTL),
		}
		c.entries[key] = call.entry
	}
	delete(c.inflight, key)
	c.mu.Unlock()
	close(call.done)
	return call.entry, call.err
}

// GetPreviewAsset 代理一个白名单远程资源。路由是公开的（见 cmd/server/router.go），
// 校验的是路径里的 HMAC：签名覆盖规范化后的目标 URL，只对白名单 host 签发过，
// 所以这个端点无法被当成通用代理使用。
func (h *Handler) GetPreviewAsset(w http.ResponseWriter, r *http.Request) {
	target, err := normalizePreviewAssetTarget(r.URL.Query().Get("u"))
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if !previewAssetSignatureValid(target, chi.URLParam(r, "sig")) {
		writeError(w, http.StatusForbidden, "invalid preview asset signature")
		return
	}
	entry, err := previewAssets.getOrFetch(r.Context(), previewAssetKey(target), target)
	if err != nil {
		slog.Warn("preview asset upstream failed", "url", target, "error", err)
	}
	if err != nil || entry.failed {
		// Don't let a browser cache a negative answer for a day; the negative
		// entry in the server-side cache already keeps repeat opens cheap.
		w.Header().Set("Cache-Control", "no-store")
		writeError(w, http.StatusBadGateway, "preview asset unavailable")
		return
	}
	writePreviewAsset(w, entry)
}

// signPreviewAssetsRequest/Response 的 `url` 是调用方的原始输入，原样回显，前端
// 据此把「HTML 里那一串」映射到「签好名的路径」，不依赖两侧对同一 URL 的规范化
// 结果完全一致。
type signPreviewAssetsRequest struct {
	URLs []string `json:"urls"`
}

type signedPreviewAsset struct {
	URL  string `json:"url"`
	Path string `json:"path"`
}

type signPreviewAssetsResponse struct {
	URLs []signedPreviewAsset `json:"urls"`
}

// SignPreviewAssets 为原型预览用到的远程资源签发同源代理路径。放在鉴权组里：
// 只有登录会话能签发，而签发出来的路径本身可以匿名 GET（iframe 拿它当 src）。
func (h *Handler) SignPreviewAssets(w http.ResponseWriter, r *http.Request) {
	var req signPreviewAssetsRequest
	if err := json.NewDecoder(io.LimitReader(r.Body, 64<<10)).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid body")
		return
	}
	if len(req.URLs) > previewAssetSignMaxURLs {
		writeError(w, http.StatusBadRequest, "too many urls")
		return
	}
	out := make([]signedPreviewAsset, 0, len(req.URLs))
	for _, raw := range req.URLs {
		target, err := normalizePreviewAssetTarget(raw)
		if err != nil {
			// 非白名单地址不签发；前端会退回未签名路径（快速 403），不会退回直连。
			continue
		}
		out = append(out, signedPreviewAsset{URL: raw, Path: previewAssetSignedPath(target)})
	}
	// 签名只取决于 JWT_SECRET，响应可以安全地不缓存。
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, signPreviewAssetsResponse{URLs: out})
}

func writePreviewAsset(w http.ResponseWriter, entry previewAssetEntry) {
	// 字体文件是跨源加载（桌面端 API 域名与页面不同源），必须放行 CORS；
	// 同源场景下这个头无副作用。
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Cache-Control", "public, max-age=86400")
	w.Header().Set("Content-Type", entry.contentType)
	w.WriteHeader(http.StatusOK)
	if _, err := w.Write(entry.body); err != nil {
		slog.Debug("failed to write preview asset body", "error", err)
	}
}

// Google Fonts 按 UA 决定发哪种字体格式：Go 默认 UA 拿到的是 ~1MB/字重的 TTF，
// 现代浏览器 UA 才是几十 KB 的 woff2。一个 Material Symbols 原型要七个字重的
// 字体文件，不装 UA 就是首次加载多传约 7MB（实测 1.0MB/个）。
const previewAssetUserAgent = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
	"AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36"

func fetchPreviewAsset(ctx context.Context, target string) ([]byte, string, error) {
	// 取的是镜像地址，缓存键与响应仍挂在原站 URL 上：下游（Cache-Control、浏览器）
	// 看到的就是「原站资源」，签名也不必跟着换。
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, previewAssetUpstream(target), nil)
	if err != nil {
		return nil, "", err
	}
	req.Header.Set("User-Agent", previewAssetUserAgent)
	req.Header.Set("Accept", "*/*")
	client := &http.Client{
		Timeout: previewAssetTimeout,
		// 重定向也必须落在白名单里，否则白名单形同虚设。
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) >= 5 {
				return errors.New("too many redirects")
			}
			if !isPreviewAssetHost(req.URL.Hostname()) {
				return fmt.Errorf("redirect to disallowed host %q", req.URL.Hostname())
			}
			return nil
		},
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, "", fmt.Errorf("upstream status %d", resp.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, previewAssetMaxBytes+1))
	if err != nil {
		return nil, "", err
	}
	if len(body) > previewAssetMaxBytes {
		return nil, "", fmt.Errorf("upstream body exceeds %d bytes", previewAssetMaxBytes)
	}
	contentType := resp.Header.Get("Content-Type")
	if contentType == "" {
		contentType = "application/octet-stream"
	}
	return rewritePreviewAssetCSS(body, contentType), contentType, nil
}

// Go 的 RE2 不支持反向引用，所以这里只把可选引号吃掉，不校验配对。
var previewAssetCSSURL = regexp.MustCompile(
	`url\(\s*['"]?(https://(?:cdn\.tailwindcss\.com|fonts\.googleapis\.com|fonts\.gstatic\.com|lh3\.googleusercontent\.com|fonts\.googleapis\.cn|fonts\.gstatic\.cn)/[^)'"\s]+)['"]?\s*\)`,
)

// rewritePreviewAssetCSS 把样式表里引用的远程字体/图片也指回本代理：Google
// Fonts 返回的 css 里全是 fonts.gstatic.com 的绝对地址，不重写的话浏览器拿到
// 样式后仍会直连境外取字体，白屏问题只是从 CSS 挪到了字体。
func rewritePreviewAssetCSS(body []byte, contentType string) []byte {
	if !strings.Contains(strings.ToLower(contentType), "text/css") {
		return body
	}
	return previewAssetCSSURL.ReplaceAllFunc(body, func(match []byte) []byte {
		groups := previewAssetCSSURL.FindSubmatch(match)
		if len(groups) < 2 {
			return match
		}
		return []byte(`url("` + PreviewAssetProxyPath(string(groups[1])) + `")`)
	})
}
