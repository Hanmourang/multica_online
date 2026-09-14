import { describe, expect, it, vi } from "vitest";
import type { Attachment } from "@multica/core/types";
import {
  PAGE_CONTEXT_MARK,
  PROTOTYPE_DIRECTORY_FILENAME,
  applyPageSurfaceContext,
  directoryFilesForPath,
  formatPageSurfaceContext,
  pageSurfaceChip,
  preparePageSurfaceSend,
  prototypeAttachmentFiles,
  prototypeDirectory,
  prototypeDirectoryListing,
  visiblePageSurfaceContent,
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
});
