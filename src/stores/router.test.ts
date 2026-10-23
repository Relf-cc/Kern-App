/**
 * @Author Christian Relf
 * @Date 2026-10-12
 */

import { describe, expect, it } from "vitest";
import { pathOf, routeFromPath } from "./router";

describe("internal routes", () => {
  it("maps /api/accounts both ways", () => {
    expect(routeFromPath("/api/accounts")).toEqual({ name: "api", tab: "accounts" });
    expect(pathOf({ name: "api", tab: "usage" })).toBe("/api/usage");
    expect(routeFromPath("/api/nope")).toBeNull();
  });

  it("sends the old assistants tab to its own settings section", () => {
    expect(routeFromPath("/api/mcp")).toEqual({ name: "settings", section: "assistants" });
    expect(pathOf({ name: "settings", section: "assistants" })).toBe("/settings/assistants");
  });
});
