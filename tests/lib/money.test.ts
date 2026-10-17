import { describe, expect, it } from "vitest";
import { formatUSD, perMillion, sum, toDbString, toDecimal, formatPricePerMillion } from "@/lib/money";

describe("money", () => {
  it("formats with smart precision", () => {
    expect(formatUSD(0)).toBe("$0.00");
    expect(formatUSD(1234.567)).toBe("$1,234.57");
    expect(formatUSD("0.5")).toBe("$0.50");
    expect(formatUSD("0.0421")).toBe("$0.0421");
    expect(formatUSD("0.000123456")).toBe("$0.000123");
    expect(formatUSD("-2.5")).toBe("-$2.50");
    expect(formatUSD("3", { signed: true })).toBe("+$3.00");
  });
  it("does decimal math without float error", () => {
    expect(sum(["0.1", "0.2"]).toString()).toBe("0.3");
    expect(perMillion(1500, "2").toString()).toBe("0.003");
    expect(toDecimal(null).toString()).toBe("0");
    expect(toDbString("1.5")).toBe("1.500000000000");
  });
  it("formats per-million prices", () => {
    expect(formatPricePerMillion("2")).toBe("$2.00");
    expect(formatPricePerMillion("0.075")).toBe("$0.075");
    expect(formatPricePerMillion("0.1")).toBe("$0.10");
  });
});
