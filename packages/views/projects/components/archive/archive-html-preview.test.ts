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

  it("keeps Tailwind CDN and Google Fonts so CDN-based prototypes still render", () => {
    // 早期会剥掉这两个远程依赖，结果全靠 utility 类的原型退化成无样式文本堆叠、
    // Material Symbols 把字形名当文字显示 —— 预览看上去像坏了。
    const html = [
      '<script src="https://cdn.tailwindcss.com"></script>',
      '<link href="https://fonts.googleapis.com/css2?family=Work+Sans" rel="stylesheet">',
      '<link rel="stylesheet" href="./shared.css">',
    ].join("\n");
    const next = preparePreviewAssets(html);
    expect(next).toContain("cdn.tailwindcss.com");
    expect(next).toContain("fonts.googleapis.com");
    expect(next).toContain("./shared.css");
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

  it("treats a data-fp stub as a contract and leaves styled pages alone", () => {
    const stub = `<!doctype html><html><body><div data-fp="fp.graph.list" data-title="社区列表">社区列表</div></body></html>`;
    expect(isContractPrototypeHtml(stub)).toBe(true);
    const dressed = withContractPrototypeChrome(stub);
    expect(dressed).toContain("data-contract-prototype");
    expect(dressed).toContain('data-fp="fp.graph.list"');
    expect(isContractPrototypeHtml('<link rel="stylesheet" href="./shared.css"><div data-fp="a">x</div>')).toBe(false);
  });
});
