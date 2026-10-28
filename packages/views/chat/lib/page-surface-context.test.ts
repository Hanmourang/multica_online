import { describe, expect, it, vi } from "vitest";
import type { Attachment } from "@multica/core/types";
import {
  PAGE_CONTEXT_MARK,
  PROTOTYPE_DIRECTORY_FILENAME,
  applyPageSurfaceContext,
  directoryFilesForPath,
  formatModuleSurfaceContext,
  formatPageSurfaceContext,
  pageSurfaceChip,
  preparePageSurfaceSend,
  prototypeAttachmentFiles,
  prototypeDirectory,
  prototypeDirectoryListing,
  visiblePageSurfaceContent,
  type ModulePageSurfaceContext,
  type PageSurfaceContext,
} from "./page-surface-context";

const sample: PageSurfaceContext = {
  surface: "prototype",
  projectId: "p1",
  moduleName: "桌面工作台",
  version: 3,
  htmlPath: "overview/product-design/prototype/index.html",
  html: "<html><body>desk</body></html>",
  directoryFiles: [
    "overview/product-design/prototype/index.html",
    "overview/product-design/prototype/tokens.css",
  ],
};

describe("page surface context", () => {
  it("lists the archive directory without dumping extracted outline", () => {
    const listing = prototypeDirectoryListing(sample);
    expect(listing).toContain("overview/product-design/prototype/");
    expect(listing).toContain("- overview/product-design/prototype/tokens.css");
    expect(formatPageSurfaceContext(sample)).not.toContain("feature_points");
    expect(formatPageSurfaceContext(sample)).not.toContain("<html>");
  });

  it("builds the original html file and a directory listing file", () => {
    const files = prototypeAttachmentFiles(sample);
    expect(files.map((file) => file.name)).toEqual([
      PROTOTYPE_DIRECTORY_FILENAME,
      "index.html",
    ]);
  });

  it("hides the mount block from the user-visible bubble", () => {
    const packed = applyPageSurfaceContext("当前页面是干嘛的", sample);
    expect(packed).toContain(PAGE_CONTEXT_MARK);
    expect(visiblePageSurfaceContent(packed)).toBe("当前页面是干嘛的");
  });

  it("uploads attachments and keeps the user text unchanged", async () => {
    const uploadFile = vi.fn(async (file: File) => ({ id: `att-${file.name}` }) as Attachment);
    const prepared = await preparePageSurfaceSend(
      { uploadFile },
      "当前页面是干嘛的",
      sample,
      "session-1",
    );
    expect(prepared.content).toBe("当前页面是干嘛的");
    expect(prepared.attachmentIds).toEqual([
      `att-${PROTOTYPE_DIRECTORY_FILENAME}`,
      "att-index.html",
    ]);
    expect(uploadFile).toHaveBeenCalledTimes(2);
  });

  it("falls back to a path listing when upload fails", async () => {
    const prepared = await preparePageSurfaceSend(
      { uploadFile: async () => { throw new Error("upload failed"); } },
      "当前页面是干嘛的",
      sample,
      "session-1",
    );
    expect(prepared.content).toContain(PAGE_CONTEXT_MARK);
    expect(prepared.content).toContain("当前页面是干嘛的");
    expect(prepared.attachmentIds).toEqual([]);
  });

  it("lists sibling archive files in the same directory", () => {
    expect(prototypeDirectory("a/b/c.html")).toBe("a/b");
    expect(
      directoryFilesForPath("a/b/c.html", ["a/b/c.html", "a/b/d.css", "a/other.html"]),
    ).toEqual(["a/b/c.html", "a/b/d.css"]);
  });

  it("names the chip from the file", () => {
    expect(pageSurfaceChip(sample)).toBe("v3 · index.html");
  });

  describe("module surface", () => {
    const moduleContext: ModulePageSurfaceContext = {
      surface: "module",
      projectId: "p1",
      moduleId: "m1",
      moduleName: "申报清单页",
      specVersion: 3,
      canonicalPrototypeVersion: 2,
      coverage: 80,
      featurePointCount: 5,
    };

    it("carries the module id and hides prototype file affordances", () => {
      expect(pageSurfaceChip(moduleContext)).toBe("申报清单页 · v3");
      expect(prototypeAttachmentFiles(moduleContext)).toEqual([]);
      expect(prototypeDirectoryListing(moduleContext)).toBe("");
    });

    it("formats a compact module summary outside the html comment mark", () => {
      const packed = formatModuleSurfaceContext(moduleContext);
      expect(packed).toContain("module m1");
      expect(packed).toContain("spec v3");
      expect(packed).toContain("canonical prototype v2");
      expect(packed).toContain("coverage 80%");
      expect(formatPageSurfaceContext(moduleContext)).toBe(packed);
      expect(packed).not.toContain(PAGE_CONTEXT_MARK);
    });

    it("keeps send content untouched and falls back without attachments", async () => {
      const uploadFile = vi.fn(async (file: File) => ({ id: `att-${file.name}` }) as Attachment);
      const prepared = await preparePageSurfaceSend({ uploadFile }, "这个模块还差什么", moduleContext, "s1");
      expect(uploadFile).not.toHaveBeenCalled();
      expect(prepared.attachmentIds).toEqual([]);
      expect(prepared.content).toContain("这个模块还差什么");
      expect(applyPageSurfaceContext("这个模块还差什么", null)).toBe("这个模块还差什么");
    });
  });
});
