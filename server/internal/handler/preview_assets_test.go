package handler

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
)

func TestNormalizePreviewAssetTarget(t *testing.T) {
	cases := []struct {
		name    string
		raw     string
		wantErr bool
	}{
		{"tailwind", "https://cdn.tailwindcss.com/3.4.17?plugins=forms", false},
		{"google fonts", "https://fonts.googleapis.com/css2?family=Work+Sans", false},
		{"gstatic font", "https://fonts.gstatic.com/s/worksans/v23/x.woff2", false},
		{"google avatar", "https://lh3.googleusercontent.com/aida-public/abc", false},
		{"fonts mirror", "https://fonts.googleapis.cn/css2?family=Work+Sans", false},
		{"gstatic mirror", "https://fonts.gstatic.cn/s/worksans/v23/x.woff2", false},
		{"empty", "", true},
		{"plain http", "http://cdn.tailwindcss.com/3.4.17", true},
		{"not in allowlist", "https://evil.example.com/steal", true},
		{"allowlist suffix trick", "https://cdn.tailwindcss.com.evil.example/x", true},
		{"relative", "/api/attachments/1/content", true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := normalizePreviewAssetTarget(tc.raw)
			if tc.wantErr && err == nil {
				t.Fatalf("expected %q to be rejected", tc.raw)
			}
			if !tc.wantErr && err != nil {
				t.Fatalf("expected %q to be accepted, got %v", tc.raw, err)
			}
		})
	}
}

func TestPreviewAssetProxyPathIsSignedAndEscaped(t *testing.T) {
	target := "https://fonts.googleapis.com/css2?family=Work+Sans&display=swap"
	got := PreviewAssetProxyPath(target)
	rest, ok := strings.CutPrefix(got, previewAssetPath+"/")
	if !ok {
		t.Fatalf("PreviewAssetProxyPath = %q, want a %s/<sig> path", got, previewAssetPath)
	}
	sig, query, ok := strings.Cut(rest, "?")
	if !ok || sig == "" {
		t.Fatalf("expected a signature segment before the query, got %q", got)
	}
	if !previewAssetSignatureValid(target, sig) {
		t.Fatalf("signature %q does not verify against %q", sig, target)
	}
	if want := "u=" + url.QueryEscape(target); query != want {
		t.Fatalf("query = %q, want %q", query, want)
	}
}

func TestPreviewAssetSignatureIsBoundToTheTarget(t *testing.T) {
	a := PreviewAssetProxyPath("https://cdn.tailwindcss.com/3.4.17")
	sig, _, _ := strings.Cut(strings.TrimPrefix(a, previewAssetPath+"/"), "?")
	if previewAssetSignatureValid("https://fonts.googleapis.com/css2", sig) {
		t.Fatal("a signature minted for one URL must not validate for another")
	}
	tampered := sig[:len(sig)-1] + "A"
	if previewAssetSignatureValid("https://cdn.tailwindcss.com/3.4.17", tampered) {
		t.Fatal("a tampered signature must be rejected")
	}
}

func TestGetPreviewAssetRejectsBadSignature(t *testing.T) {
	r := chi.NewRouter()
	r.Get(previewAssetPath+"/{sig}", (&Handler{}).GetPreviewAsset)
	req := httptest.NewRequest(
		http.MethodGet,
		previewAssetPath+"/deadbeef?u="+url.QueryEscape("https://cdn.tailwindcss.com/3.4.17"),
		nil,
	)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusForbidden)
	}
}

func TestSignPreviewAssetsSkipsNonAllowlistedHosts(t *testing.T) {
	body := `{"urls":["https://cdn.tailwindcss.com/3.4.17","https://evil.example.com/x"]}`
	req := httptest.NewRequest(http.MethodPost, previewAssetPath+"/sign", strings.NewReader(body))
	rec := httptest.NewRecorder()
	(&Handler{}).SignPreviewAssets(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusOK)
	}
	var resp signPreviewAssetsResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if len(resp.URLs) != 1 {
		t.Fatalf("expected only the allowlisted url to be signed, got %+v", resp.URLs)
	}
	// `url` must echo the caller's exact input so the client can map it back.
	if resp.URLs[0].URL != "https://cdn.tailwindcss.com/3.4.17" {
		t.Fatalf("unexpected echoed url %q", resp.URLs[0].URL)
	}
	if !strings.HasPrefix(resp.URLs[0].Path, previewAssetPath+"/") {
		t.Fatalf("unexpected signed path %q", resp.URLs[0].Path)
	}
}

func TestRewritePreviewAssetCSSPointsFontsAtProxy(t *testing.T) {
	css := []byte(`@font-face{font-family:'Work Sans';src:url(https://fonts.gstatic.com/s/worksans/v23/x.woff2) format('woff2');}`)
	out := string(rewritePreviewAssetCSS(css, "text/css; charset=utf-8"))
	if strings.Contains(out, "https://fonts.gstatic.com/s/worksans") {
		t.Fatalf("font url was not proxied: %s", out)
	}
	if !strings.Contains(out, `url("`+previewAssetPath+`/`) {
		t.Fatalf("unexpected rewrite: %s", out)
	}
	if !strings.Contains(out, `?u=https%3A%2F%2Ffonts.gstatic.com%2Fs%2Fworksans%2Fv23%2Fx.woff2`) {
		t.Fatalf("escaped target missing: %s", out)
	}
}

func TestRewritePreviewAssetCSSIgnoresOtherContentTypes(t *testing.T) {
	body := []byte(`url(https://fonts.gstatic.com/s/x.woff2)`)
	if got := string(rewritePreviewAssetCSS(body, "application/javascript")); got != string(body) {
		t.Fatalf("non-css body was rewritten: %q", got)
	}
}

func TestPreviewAssetCacheHonoursTTL(t *testing.T) {
	cache := &previewAssetCache{
		entries:  map[string]previewAssetEntry{},
		inflight: map[string]*previewAssetCall{},
	}
	cache.entries["k"] = previewAssetEntry{
		body:        []byte("body"),
		contentType: "text/css",
		expiresAt:   time.Now().Add(time.Minute),
	}
	entry, ok := cache.lookup("k")
	if !ok || entry.contentType != "text/css" {
		t.Fatalf("expected a live cache entry, got %v %q", ok, entry.contentType)
	}
	cache.entries["k"] = previewAssetEntry{expiresAt: time.Now().Add(-time.Second)}
	if _, ok := cache.lookup("k"); ok {
		t.Fatal("expired entry must miss")
	}
	if _, ok := cache.lookup("k"); ok {
		t.Fatal("expired entry must be dropped from the map")
	}
}

func TestPreviewAssetCacheServesNegativeEntryWithoutRefetching(t *testing.T) {
	cache := &previewAssetCache{
		entries:  map[string]previewAssetEntry{},
		inflight: map[string]*previewAssetCall{},
	}
	// Unreachable upstream (lh3 in mainland) should not pay an 8s timeout on
	// every prototype open; the negative entry short-circuits it.
	cache.entries["k"] = previewAssetEntry{failed: true, expiresAt: time.Now().Add(time.Minute)}
	entry, err := cache.getOrFetch(context.Background(), "k", "https://lh3.googleusercontent.com/x")
	if err != nil {
		t.Fatalf("negative entry must not fetch: %v", err)
	}
	if !entry.failed {
		t.Fatal("expected the negative entry to be returned as-is")
	}
}

// Google 字体原站在国内整体不可达（实测 IPv4 也是 12s 超时），代理必须换成可
// 达的 .cn 镜像去取，否则每次打开原型都要在字体样式表上阻塞满 8s 再失败。
func TestPreviewAssetUpstreamUsesMirror(t *testing.T) {
	cases := []struct {
		name   string
		target string
		want   string
	}{
		{
			"google fonts css",
			"https://fonts.googleapis.com/css2?family=Work+Sans&display=swap",
			"https://fonts.googleapis.cn/css2?family=Work+Sans&display=swap",
		},
		{
			"gstatic font file",
			"https://fonts.gstatic.com/s/worksans/v23/x.woff2",
			"https://fonts.gstatic.cn/s/worksans/v23/x.woff2",
		},
		{
			"tailwind is reachable as-is",
			"https://cdn.tailwindcss.com/3.4.17",
			"https://cdn.tailwindcss.com/3.4.17",
		},
		{
			"an avatar host has no mirror",
			"https://lh3.googleusercontent.com/aida-public/abc",
			"https://lh3.googleusercontent.com/aida-public/abc",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := previewAssetUpstream(tc.target); got != tc.want {
				t.Fatalf("upstream = %q, want %q", got, tc.want)
			}
		})
	}
}

// 镜像返回的 CSS 里字体指向 fonts.gstatic.cn；不重写的话浏览器会从 iframe 的
// 不透明源直连镜像（不在代理白名单内），字体就又绕回外网。
func TestRewritePreviewAssetCSSProxiesMirroredFonts(t *testing.T) {
	css := []byte(`@font-face{src:url(https://fonts.gstatic.cn/s/materialsymbols/v382/k.woff2) format('woff2');}`)
	out := string(rewritePreviewAssetCSS(css, "text/css"))
	if strings.Contains(out, "fonts.gstatic.cn/s/materialsymbols") {
		t.Fatalf("mirrored font url was not proxied: %s", out)
	}
	// 代理路径必须真能通过签名校验，否则字体仍然 403。
	target := "https://fonts.gstatic.cn/s/materialsymbols/v382/k.woff2"
	sig, _, _ := strings.Cut(strings.TrimPrefix(PreviewAssetProxyPath(target), previewAssetPath+"/"), "?")
	if !previewAssetSignatureValid(target, sig) {
		t.Fatal("mirror target must be signable after being added to the allowlist")
	}
	if !strings.Contains(out, `url("`+previewAssetPath+`/`) {
		t.Fatalf("unexpected rewrite: %s", out)
	}
}
