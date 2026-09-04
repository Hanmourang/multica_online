import { describe, expect, it } from "vitest";
import { resolveDevAutoLogin } from "./dev-auto-login";

describe("resolveDevAutoLogin", () => {
  it("returns null when the shortcut is not enabled", () => {
    expect(resolveDevAutoLogin({})).toBeNull();
    expect(resolveDevAutoLogin({ enabled: false })).toBeNull();
    expect(resolveDevAutoLogin({ enabled: "" })).toBeNull();
    expect(resolveDevAutoLogin({ enabled: "0" })).toBeNull();
    expect(resolveDevAutoLogin({ enabled: "false" })).toBeNull();
  });

  it("accepts every truthy enable spelling", () => {
    for (const enabled of [true, "1", "true", "TRUE", " yes ", "on"]) {
      expect(resolveDevAutoLogin({ enabled })).not.toBeNull();
    }
  });

  it("falls back to the local development account", () => {
    expect(resolveDevAutoLogin({ enabled: "1" })).toEqual({
      email: "dev@localhost",
      code: "888888",
    });
  });

  it("uses explicit credentials when provided", () => {
    expect(
      resolveDevAutoLogin({
        enabled: "1",
        email: " alice@example.com ",
        code: " 123456 ",
      }),
    ).toEqual({ email: "alice@example.com", code: "123456" });
  });

  it("ignores blank credentials and keeps the defaults", () => {
    expect(
      resolveDevAutoLogin({ enabled: "1", email: "  ", code: "" }),
    ).toEqual({ email: "dev@localhost", code: "888888" });
  });
});
