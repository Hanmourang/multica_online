import { describe, expect, it } from "vitest";
import { collectPlainFiles, validateFile } from "./batch-upload";

/** Build a File with an explicit size without allocating 20MB buffers. */
function makeFile(name: string, size = 10): File {
  return new File([new Uint8Array(size)], name);
}

describe("validateFile", () => {
  it("accepts common document types", () => {
    expect(validateFile(makeFile("spec.md"), "docs/spec.md")).toBeNull();
    expect(validateFile(makeFile("arch.pdf"), "docs/arch.pdf")).toBeNull();
    expect(validateFile(makeFile("proto.html"), "原型/proto.html")).toBeNull();
  });

  it("rejects hidden files by base name (dotfiles / dot directories)", () => {
    expect(validateFile(makeFile(".DS_Store"), "docs/.DS_Store")).toBe("hidden");
    expect(validateFile(makeFile("x.md"), ".hidden/x.md")).toBeNull(); // dir dot-prefix ok, file checked by base name
  });

  it("rejects files over the 20MB budget", () => {
    expect(validateFile(makeFile("big.pdf", 20 * 1024 * 1024 + 1), "big.pdf")).toBe("too_large");
    expect(validateFile(makeFile("edge.pdf", 20 * 1024 * 1024), "edge.pdf")).toBeNull();
  });

  it("rejects unsupported extensions", () => {
    expect(validateFile(makeFile("binary.exe"), "tools/binary.exe")).toBe("unsupported_type");
    expect(validateFile(makeFile("noext"), "build/noext")).toBe("unsupported_type");
  });
});

describe("collectPlainFiles", () => {
  function fakeInput(files: (File | null)[]): HTMLInputElement {
    const list = Object.assign(files.filter(Boolean), {
      item: (i: number) => (files as File[])[i] ?? null,
    }) as FileList;
    return { files: list } as unknown as HTMLInputElement;
  }

  it("collects non-empty files and falls back to the plain name as relPath", () => {
    const a = makeFile("one.md");
    const b = makeFile("two.pdf");
    const empty = makeFile("empty.md", 0);
    const out = collectPlainFiles(fakeInput([a, empty, b]));
    expect(out.map((p) => p.relPath)).toEqual(["one.md", "two.pdf"]);
  });

  it("returns nothing when the picker was cancelled", () => {
    expect(collectPlainFiles({ files: null } as unknown as HTMLInputElement)).toEqual([]);
  });
});
