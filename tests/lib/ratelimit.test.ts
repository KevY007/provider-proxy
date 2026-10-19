import { describe, expect, it } from "vitest";
import { rateLimit } from "@/lib/ratelimit";

describe("rateLimit (memory fallback)", () => {
  it("allows up to the limit then blocks with retry info", async () => {
    const key = `t:${Math.random()}`;
    for (let i = 0; i < 3; i++) expect((await rateLimit(key, { limit: 3, windowSec: 60 })).ok).toBe(true);
    const blocked = await rateLimit(key, { limit: 3, windowSec: 60 });
    expect(blocked.ok).toBe(false);
    expect(blocked.retryAfterSec).toBeGreaterThan(0);
  });
  it("keys are independent", async () => {
    expect((await rateLimit(`a:${Math.random()}`, { limit: 1, windowSec: 60 })).ok).toBe(true);
    expect((await rateLimit(`b:${Math.random()}`, { limit: 1, windowSec: 60 })).ok).toBe(true);
  });
});
