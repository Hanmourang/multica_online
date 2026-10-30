import { describe, expect, it } from "vitest";
import {
  archiveFileUrl,
  collectRelativeScripts,
  collectRelativeStylesheets,
  inlineHtmlRelativeAssets,
  isContractPrototypeHtml,
  withContractPrototypeChrome,
  inlineRelativeScripts,
  inlineRelativeStylesheets,
  isRelativeAssetHref,
  preparePreviewAssets,
  preparePreviewAssetsSigned,
  resolveRelativeRelPath,
} from "./archive-html-preview";

describe("archiveFileUrl", () => {
  it("builds a posix file URL", () => {
    expect(
      archiveFileUrl(
        "/Users/eleme/Documents/workspace/projects_mgmt/projects/dsh_desktop",
        "overview/product-design/prototype/index.html",
      ),
    ).toBe(
      "file:///Users/eleme/Documents/workspace/projects_mgmt/projects/dsh_desktop/overview/product-design/prototype/index.html",
    );
  });

  it("builds a windows file URL", () => {
    expect(archiveFileUrl("C:\\archive", "overview\\a.html")).toBe(
      "file:///C:/archive/overview/a.html",
    );
  });
});

describe("relative html assets", () => {
  it("keeps http(s) and data URLs out of the relative set", () => {
    expect(isRelativeAssetHref("./shared.css")).toBe(true);
    expect(isRelativeAssetHref("https://cdn.tailwindcss.com")).toBe(false);
    expect(isRelativeAssetHref("data:text/css,body{}")).toBe(false);
  });

  it("resolves sibling and parent hrefs", () => {
    expect(
      resolveRelativeRelPath("overview/product-design/prototype/index.html", "./shared.css"),
    ).toBe("overview/product-design/prototype/shared.css");
    expect(
      resolveRelativeRelPath("overview/product-design/prototype/index.html", "../tokens.css"),
    ).toBe("overview/product-design/tokens.css");
  });

  it("inlines relative stylesheets and leaves CDN links", () => {
    const html = [
      '<link href="https://fonts.googleapis.com/css2?family=Work+Sans" rel="stylesheet">',
      '<link rel="stylesheet" href="./shared.css">',
    ].join("\n");
    expect(collectRelativeStylesheets(html)).toEqual(["./shared.css"]);
    const next = inlineRelativeStylesheets(html, {
      "./shared.css": ".card-shadow{box-shadow:0 1px 2px #0003}",
    });
    expect(next).toContain("data-archive-inline=\"./shared.css\"");
    expect(next).toContain(".card-shadow{box-shadow:0 1px 2px #0003}");
    expect(next).toContain("https://fonts.googleapis.com/css2?family=Work+Sans");
  });

  it("inlines relative scripts", () => {
    const html = '<script src="./icons.js"></script><script src="https://cdn.tailwindcss.com"></script>';
    expect(collectRelativeScripts(html)).toEqual(["./icons.js"]);
    const next = inlineRelativeScripts(html, { "./icons.js": "window.__icons=1;" });
    expect(next).toContain("data-archive-inline=\"./icons.js\"");
    expect(next).toContain("window.__icons=1;");
    expect(next).toContain("https://cdn.tailwindcss.com");
  });

  it("routes Tailwind CDN and Google Fonts through the preview asset proxy", () => {
    // 这两类远程依赖在国内客户端直连是 25s 超时（样式表还阻塞渲染），曾经
    // 一打开原型就是十几秒白屏。现在改由服务端代取，HTML 里只留同源代理路径。
    const html = [
      '<script src="https://cdn.tailwindcss.com?plugins=forms"></script>',
      '<link href="https://fonts.googleapis.com/css2?family=Work+Sans&amp;display=swap" rel="stylesheet">',
      '<link rel="stylesheet" href="./shared.css">',
    ].join("\n");
    const next = preparePreviewAssets(html);
    expect(next).not.toContain("cdn.tailwindcss.com\"");
    expect(next).toContain(
      "/api/preview-assets?u=https%3A%2F%2Fcdn.tailwindcss.com%3Fplugins%3Dforms",
    );
    // `&amp;` 必须先还原成 `&` 再编码，否则上游拿到的是个假的 amp; 参数。
    expect(next).toContain(
      "/api/preview-assets?u=https%3A%2F%2Ffonts.googleapis.com%2Fcss2%3Ffamily%3DWork%2BSans%26display%3Dswap",
    );
    // 相对路径仍由 inlineHtmlRelativeAssets 处理，这里不能动。
    expect(next).toContain("./shared.css");
  });

  it("rewrites allowed image hosts, honours assetBase and leaves other hosts alone", () => {
    const html = [
      '<img src="https://lh3.googleusercontent.com/aida-public/abc">',
      '<img src="https://cdn.example.com/cover.png">',
      '<link rel="preconnect" href="https://fonts.gstatic.com">',
      "<style>.x{background:url('https://fonts.gstatic.com/s/a.woff2')}</style>",
    ].join("\n");
    const next = preparePreviewAssets(html, "http://127.0.0.1:18227");
    expect(next).toContain(
      "http://127.0.0.1:18227/api/preview-assets?u=https%3A%2F%2Flh3.googleusercontent.com%2Faida-public%2Fabc",
    );
    expect(next).toContain("https://cdn.example.com/cover.png");
    // preconnect 不是资源，重写只会多一次无效请求。
    expect(next).toContain('<link rel="preconnect" href="https://fonts.gstatic.com">');
    expect(next).toContain(
      "url('http://127.0.0.1:18227/api/preview-assets?u=https%3A%2F%2Ffonts.gstatic.com%2Fs%2Fa.woff2')",
    );
  });

  it("inlines sibling css and js resolved from the html path", async () => {
    const html = [
      '<link rel="stylesheet" href="./shared.css">',
      '<script src="./icons.js"></script>',
      "<h1>市场</h1>",
    ].join("");
    const next = await inlineHtmlRelativeAssets(
      html,
      "projects/dsh_desktop/overview/product-design/prototype/market.html",
      async (resolved) => {
        if (resolved.endsWith("/shared.css")) return ".card{color:red}";
        if (resolved.endsWith("/icons.js")) return "window.__icons=1;";
        return null;
      },
    );
    expect(next).toContain(".card{color:red}");
    expect(next).toContain("window.__icons=1;");
    expect(next).not.toContain('href="./shared.css"');
  });

  it("signs the proxy paths so the sandboxed iframe can load them", async () => {
    // srcdoc iframe 是不透明源，子资源请求不带 cookie，未签名路径会被 403，
    // Tailwind 与字体一个都进不来 —— 必须换成服务端签好的 HMAC 路径。
    const html = [
      '<script src="https://cdn.tailwindcss.com?plugins=forms"></script>',
      '<link href="https://fonts.googleapis.com/css2?family=Work+Sans&amp;display=swap" rel="stylesheet">',
    ].join("\n");
    const asked: string[][] = [];
    const next = await preparePreviewAssetsSigned(html, "", async (urls) => {
      asked.push(urls);
      return Object.fromEntries(urls.map((url) => [url, `/api/preview-assets/SIG?u=x`]));
    });
    // `&amp;` 必须先还原再交给服务端，否则签的是一个带 amp; 的假参数。
    expect(asked).toHaveLength(1);
    expect([...(asked[0] ?? [])].sort()).toEqual([
      "https://cdn.tailwindcss.com?plugins=forms",
      "https://fonts.googleapis.com/css2?family=Work+Sans&display=swap",
    ]);
    expect(next.match(/\/api\/preview-assets\/SIG\?u=x/g)).toHaveLength(2);
  });

  it("falls back to the unsigned proxy path when signing fails", async () => {
    const html = '<script src="https://cdn.tailwindcss.com"></script>';
    const next = await preparePreviewAssetsSigned(html, "", async () => {
      throw new Error("offline");
    });
    // 快速 403 远好于退回境外直连的二十多秒白屏。
    expect(next).toContain("/api/preview-assets?u=https%3A%2F%2Fcdn.tailwindcss.com");
  });

  it("treats a data-fp stub as a contract and leaves styled pages alone", () => {
    const stub = `<!doctype html><html><body><div data-fp="fp.graph.list" data-title="社区列表">社区列表</div></body></html>`;
    expect(isContractPrototypeHtml(stub)).toBe(true);
    const dressed = withContractPrototypeChrome(stub);
    expect(dressed).toContain("data-contract-prototype");
    expect(dressed).toContain('data-fp="fp.graph.list"');
    expect(isContractPrototypeHtml('<link rel="stylesheet" href="./shared.css"><div data-fp="a">x</div>')).toBe(false);
  });
});
