/**
 * appRoutes — 桌面端独立路由表（web 用 Next 文件路由，不走这里）。
 * 每注册一个工作区级页面，两边路由表都必须有入口，否则桌面端命中
 * DesktopRouteErrorPage（「This page doesn't exist」）。
 */
import { describe, expect, it } from "vitest";
import { matchRoutes } from "react-router-dom";
import { appRoutes } from "./routes";

function matchedPaths(url: string): (string | undefined)[] {
  return (matchRoutes(appRoutes, url) ?? []).map((m) => m.route.path);
}

describe("appRoutes", () => {
  it("matches /:workspaceSlug/calendar to the calendar page", () => {
    expect(matchedPaths("/acme/calendar")).toContain("calendar");
  });

  it("matches /:workspaceSlug/issues to the issues page (regression anchor)", () => {
    expect(matchedPaths("/acme/issues")).toContain("issues");
  });
});
