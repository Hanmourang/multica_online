import { describe, expect, it } from "vitest";
import { collapseHtmlDiff, diffHtmlLines, htmlDiffStats } from "./prototype-html-diff";
import { extractPrototypeModules } from "./module-feature-stats";

describe("diffHtmlLines", () => {
  it("marks added and removed lines", () => {
    const lines = diffHtmlLines("<h1>old</h1>\n<p>keep</p>\n", "<h1>new</h1>\n<p>keep</p>\n");
    expect(htmlDiffStats(lines)).toEqual({ added: 1, removed: 1, changed: 2 });
    expect(lines.filter((row) => row.kind !== "same").map((row) => `${row.kind}:${row.text}`)).toEqual([
      "removed:<h1>old</h1>",
      "added:<h1>new</h1>",
    ]);
  });

  it("returns no collapsed rows when files match", () => {
    const html = "<h1>same</h1>\n";
    expect(collapseHtmlDiff(diffHtmlLines(html, html))).toEqual([]);
  });
});

describe("extractPrototypeModules", () => {
  it("prefers data-fp when present", () => {
    const modules = extractPrototypeModules(`<div data-fp="fp.a" data-title="A">body</div><h2>Ignore</h2>`);
    expect(modules.map((row) => `${row.source}:${row.id}`)).toEqual(["fp:fp.a"]);
  });

  it("falls back to title, headings and nav", () => {
    const modules = extractPrototypeModules(`
      <title>生态总览</title>
      <nav><a href="./desktop.html">桌面工作台</a></nav>
      <h2>平台构成</h2>
    `);
    expect(modules.map((row) => `${row.source}:${row.title}`)).toEqual([
      "heading:生态总览",
      "heading:平台构成",
      "nav:桌面工作台",
    ]);
  });

  it("decodes entities in section titles", () => {
    const modules = extractPrototypeModules(`<h2>前后端开发流程[Aone&amp;O2]</h2>`);
    expect(modules.map((row) => row.title)).toEqual(["前后端开发流程[Aone&O2]"]);
  });

  it("skips template placeholders rendered inside scripts", () => {
    const modules = extractPrototypeModules(`
      <h1>开发流程</h1>
      <script>const row = \`<h3>\${esc(n.name)} \${n.goal}</h3>\`;</script>
    `);
    expect(modules.map((row) => row.title)).toEqual(["开发流程"]);
  });
});
