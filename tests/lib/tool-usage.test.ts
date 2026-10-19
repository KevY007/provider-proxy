import { describe, expect, it } from "vitest";
import { formatToolUsage, toolUsageCsv, toolUsageMap } from "@/lib/tool-usage";

describe("tool usage display", () => {
  it("toolUsageMap keeps positive numbers only, keys sorted", () => {
    expect(toolUsageMap({ web_search_request: 2, code_execution_hour: "0.0833", zero: 0, neg: -1, bad: "x" })).toEqual({ code_execution_hour: 0.0833, web_search_request: 2 });
    expect(Object.keys(toolUsageMap({ b: 1, a: 1 }))).toEqual(["a", "b"]);
    expect(toolUsageMap(null)).toEqual({});
    expect(toolUsageMap([1])).toEqual({});
  });

  it("formats for the UI and CSV", () => {
    const m = toolUsageMap({ web_search_request: 2, code_execution_hour: 5 / 60 });
    expect(formatToolUsage(m)).toBe("code_execution_hour ×0.08333, web_search_request ×2");
    expect(toolUsageCsv(m)).toBe("code_execution_hour=0.08333; web_search_request=2");
    expect(formatToolUsage({})).toBe("");
    expect(toolUsageCsv({})).toBe("");
  });
});
