import { describe, expect, it } from "vitest";
import {
  archiveFileUrl,
  collectRelativeScripts,
  collectRelativeStylesheets,
  inlineRelativeScripts,
  inlineRelativeStylesheets,
  isRelativeAssetHref,
  resolveRelativeRelPath,
  stripRemotePreviewAssets,
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

  it("strips Tailwind CDN and Google Fonts", () => {
    const html = [
      '<script src="https://cdn.tailwindcss.com"></script>',
      '<link href="https://fonts.googleapis.com/css2?family=Work+Sans" rel="stylesheet">',
      '<link rel="stylesheet" href="./shared.css">',
    ].join("\n");
    const next = stripRemotePreviewAssets(html);
    expect(next).not.toContain("cdn.tailwindcss.com");
    expect(next).not.toContain("fonts.googleapis.com");
    expect(next).toContain("./shared.css");
  });
});
