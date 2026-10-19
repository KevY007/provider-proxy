/**
 * Regression tests for the Phase 6 security audit (docs/SECURITY-AUDIT.md). Each `describe` names the finding id.
 */
import { brotliCompressSync } from "node:zlib";
import * as OTPAuth from "otpauth";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, dbOk, sleep } from "../gateway/harness";
import { ChartStyle } from "@/components/ui/chart";
import { ensureMetered } from "@/gateway/batches";
import { inboundBody } from "@/gateway/bodyin";
import { invalidateGatewayConfig } from "@/gateway/cache";
import { GatewayError } from "@/gateway/errors";
import { enqueueMeter, flushMeter } from "@/gateway/meter-writer";
import { MultipartError, parseMultipart } from "@/gateway/multipart";
import { rememberResponse } from "@/gateway/responses-sticky";
import { scrubText } from "@/gateway/shape";
import { assertPublicUrl, isPrivateAddress } from "@/gateway/ssrf";
import { collectText, estimateInputTokens } from "@/gateway/tokenizer";
import { describeNetworkError } from "@/gateway/util";
import { grantTrialCredit } from "@/lib/auth/service";
import { consumeRecoveryCode, newRecoveryCodes, verifyUserTotp } from "@/lib/auth/totp";
import { ipBucket } from "@/gateway/limits";
import { MASKED, maskHeaders, openHeaders, sealHeaders } from "@/lib/secret-headers";
import { encrypt } from "@/lib/crypto";
import { db } from "@/lib/db";
import { safeNextPath } from "@/lib/http";
import { Decimal } from "@/lib/money";

describe("W1 open redirect: safeNextPath", () => {
  it("rejects control characters that URL parsers drop (/\\t/evil.com == //evil.com)", () => {
    for (const bad of ["/\t/evil.com", "/\n/evil.com", "/\r/evil.com", "//evil.com", "/\\evil.com", "https://evil.com", "evil.com", "/%0d"]) {
      const out = safeNextPath(bad);
      expect(new URL(out, "https://app.example").origin, bad).toBe("https://app.example");
    }
    expect(safeNextPath("/\t/evil.com")).toBe("/dashboard");
  });
  it("keeps normal paths with query and hash", () => {
    expect(safeNextPath("/admin/customers/1?tab=keys#x")).toBe("/admin/customers/1?tab=keys#x");
  });
});

describe("S2 secrets in URLs: describeNetworkError", () => {
  it("redacts ?key= query credentials and userinfo in error text", () => {
    const err = new TypeError("Failed to parse URL from https://[x/v1beta/models/m:generateContent?key=AIzaSECRETSECRET123&alt=sse");
    const out = describeNetworkError(err);
    expect(out).not.toContain("AIzaSECRETSECRET123");
    expect(out).toContain("key=[redacted]");
    expect(describeNetworkError(new Error("connect to https://user:pa55word@host/x failed"))).not.toContain("pa55word");
  });
});

describe("G7 upstream identity in mirrored errors: scrubText", () => {
  it("redacts organization / project ids, UUIDs and dated upstream model variants", () => {
    const t = scrubText("Rate limit for org-AbCdEf123456 proj_Xyz12345678 organization (3f9a2b1c-1111-2222-3333-444455556666) on astra-2024-08-06", {
      upstreamModel: "astra",
      publicModel: "pub",
      providerName: "Prov",
      providerSlug: "prov",
      baseUrl: "https://api.example",
    });
    expect(t).not.toMatch(/org-AbCd|proj_Xyz|3f9a2b1c|astra/);
    expect(t).toContain("pub");
  });
});

describe("G8 SSRF guard", () => {
  it("classifies private / reserved addresses", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1"]) expect(isPrivateAddress(ip), ip).toBe(true);
    for (const ip of ["8.8.8.8", "1.1.1.1", "2606:4700::1111"]) expect(isPrivateAddress(ip), ip).toBe(false);
  });
  it("refuses metadata / loopback URLs unless the host is the provider's own", async () => {
    await expect(assertPublicUrl("http://169.254.169.254/computeMetadata/v1/")).rejects.toThrow();
    await expect(assertPublicUrl("http://localhost:4010/x")).rejects.toThrow();
    await expect(assertPublicUrl("file:///etc/passwd")).rejects.toThrow();
    await expect(assertPublicUrl("http://127.0.0.1:4010/x", ["127.0.0.1"])).resolves.toBeUndefined();
  });
});

describe("G2 multipart: the field name comes from Content-Disposition only, routing fields are unique", () => {
  const b = "XyZb0undary";
  const form = (parts: string[]) => Buffer.from(parts.map((p) => `--${b}\r\n${p}\r\n`).join("") + `--${b}--\r\n`);
  it("a name= parameter in another header does not name the part", async () => {
    const body = form(['Content-Type: text/plain; name="x"\r\nContent-Disposition: form-data; name="model"\r\n\r\nEXPENSIVE', 'Content-Disposition: form-data; name="prompt"\r\n\r\nhi']);
    const f = await parseMultipart(body, `multipart/form-data; boundary=${b}`);
    expect(f.fields.find((x) => x.name === "model")?.value).toBe("EXPENSIVE");
    expect(f.fields.some((x) => x.name === "x")).toBe(false);
    await f.spool.dispose();
  });
  it("two `model` fields are rejected", async () => {
    const body = form(['Content-Disposition: form-data; name="model"\r\n\r\ncheap', 'Content-Disposition: form-data; name="model"\r\n\r\nEXPENSIVE']);
    await expect(parseMultipart(body, `multipart/form-data; boundary=${b}`)).rejects.toBeInstanceOf(MultipartError);
  });
});

describe("G3 hold estimates cannot be dodged with documents / base64-looking text", () => {
  it("Anthropic plain-text documents count as text", () => {
    const data = "word ".repeat(200_000);
    const est = estimateInputTokens({ messages: [{ role: "user", content: [{ type: "document", source: { type: "text", media_type: "text/plain", data } }] }] });
    expect(est).toBeGreaterThan(200_000);
  });
  it("base64-looking text is text, not a 1000-token image", () => {
    const text = "QUJD".repeat(300_000);
    expect(estimateInputTokens({ messages: [{ role: "user", content: text }] })).toBeGreaterThan(300_000);
  });
  it("encoded PDFs and file references are reserved for, images stay at the flat estimate", () => {
    const pdf = "JVBERi0".repeat(100_000);
    const doc = collectText({ messages: [{ role: "user", content: [{ type: "document", source: { type: "base64", media_type: "application/pdf", data: pdf } }] }] });
    expect(doc.extraTokens).toBeGreaterThan(50_000);
    const ref = collectText({ messages: [{ role: "user", content: [{ type: "document", source: { type: "file", file_id: "file_1" } }] }] });
    expect(ref.extraTokens).toBeGreaterThan(10_000);
    const img = collectText({ messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "iVBOR".repeat(100_000) } }] }] });
    expect(img.images).toBe(1);
    expect(img.extraTokens).toBe(0);
  });
});

describe("G1 decompression bombs", () => {
  it("a tiny brotli body that expands far beyond the allowed ratio fails with 413", async () => {
    const bomb = brotliCompressSync(Buffer.alloc(80 * 1024 * 1024));
    expect(bomb.length).toBeLessThan(100_000);
    const req = new Request("http://gw.test/v1/chat/completions", { method: "POST", headers: { "content-encoding": "br" }, body: bomb });
    const reader = inboundBody(req)!.getReader();
    let err: unknown;
    try {
      for (;;) if ((await reader.read()).done) break;
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(GatewayError);
    expect((err as GatewayError).status).toBe(413);
  });
  it("normally compressed bodies still decode", async () => {
    const plain = Buffer.from(JSON.stringify({ text: "hello ".repeat(1000) }));
    const req = new Request("http://gw.test/x", { method: "POST", headers: { "content-encoding": "br" }, body: brotliCompressSync(plain) });
    expect(Buffer.from(await new Response(inboundBody(req)).arrayBuffer()).equals(plain)).toBe(true);
  });
});

describe("W4 chart style injection", () => {
  it("data-derived keys / colours cannot break out of the <style> element", () => {
    const html = renderToStaticMarkup(createElement(ChartStyle, { id: "c1", config: { "</style><base href=//x.yz>": { label: "x", color: "red;}</style><script>alert(1)</script>" } } }));
    expect(html).not.toContain("</style><");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<base");
  });
});

describe("S4 credential-like admin headers are encrypted at rest and masked", () => {
  it("seal -> open round trip; masked for admins; MASKED keeps the stored value", () => {
    const stored = sealHeaders({ Authorization: "Bearer real-secret", "X-Team": "blue" });
    expect(String(stored.Authorization)).toMatch(/^enc:/);
    expect(JSON.stringify(stored)).not.toContain("real-secret");
    expect(stored["X-Team"]).toBe("blue");
    expect(openHeaders(stored)).toEqual({ authorization: "Bearer real-secret", "x-team": "blue" });
    expect(maskHeaders(stored)).toEqual({ Authorization: MASKED, "X-Team": "blue" });
    const resaved = sealHeaders({ Authorization: MASKED, "X-Team": "red" }, stored);
    expect(openHeaders(resaved).authorization).toBe("Bearer real-secret");
    // legacy plain values keep working
    expect(openHeaders({ "x-api-key": "plain" })).toEqual({ "x-api-key": "plain" });
  });
});

describe("G9 throttle buckets", () => {
  it("IPv6 addresses of one /64 share a bucket; IPv4 and mapped IPv4 stay exact", () => {
    expect(ipBucket("2001:db8:1:2:aaaa::1")).toBe(ipBucket("2001:db8:1:2:ffff:1:2:3"));
    expect(ipBucket("2001:db8:1:2::1")).not.toBe(ipBucket("2001:db8:1:3::1"));
    expect(ipBucket("1.2.3.4")).toBe("1.2.3.4");
    expect(ipBucket("::ffff:1.2.3.4")).toBe("1.2.3.4");
  });
});

// ------------------------------------------------------------------ database-backed
const h = createHarness("sec");

describe.skipIf(!dbOk)("database-backed regressions", () => {
  let alice = { userId: "", key: "" };
  let bob = { userId: "", key: "" };
  let anSlug = "";
  let oaSlug = "";
  let oaProvider = "";

  beforeAll(async () => {
    await h.start();
    const a = await h.makeUser("alice", { balance: "50" });
    const b = await h.makeUser("bob", { balance: "50" });
    alice = { userId: a.id, key: (await h.makeKey("alice", a.id)).key };
    bob = { userId: b.id, key: (await h.makeKey("bob", b.id)).key };
    const an = await h.makeProvider("an", { formats: ["anthropic_messages"], authStyle: "X_API_KEY", baseUrl: h.base, keys: [{ s: "an1" }] });
    const oa = await h.makeProvider("oa", { formats: ["openai_chat", "openai_responses"], keys: [{ s: "oa1" }] });
    oaProvider = oa.id;
    anSlug = (await h.makeModel("an", { caps: ["chat"], providerId: an.id, maxOutput: 4096 })).slug;
    oaSlug = (await h.makeModel("oa", { caps: ["chat", "responses"], providerId: oa.id, maxOutput: 4096 })).slug;
    await invalidateGatewayConfig("all");
  }, 60_000);

  afterAll(async () => {
    await db.upstreamObject.deleteMany({ where: { userId: { in: h.ids.users } } }).catch(() => undefined);
    await h.cleanup();
  }, 60_000);

  it("B1: a Claude stream closed before message_delta is billed for what was delivered, not 1 token", async () => {
    const ac = new AbortController();
    const res = await h.call(
      "/v1/messages",
      alice.key,
      { model: anSlug, max_tokens: 2000, stream: true, messages: [{ role: "user", content: "write [[words:400]]" }] },
      { headers: { "anthropic-version": "2023-06-01", "x-mock-delay-ms": "2" }, signal: ac.signal },
    );
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let text = "";
    let textBlocks = 0;
    while (textBlocks < 1) {
      const r = await reader.read();
      if (r.done) break;
      text += dec.decode(r.value, { stream: true });
      textBlocks = (text.match(/content_block_stop/g) ?? []).length;
      if (text.includes("message_delta")) break;
    }
    expect(text).not.toContain("message_delta");
    ac.abort();
    await reader.cancel().catch(() => undefined);
    const log = await h.logOf(res);
    expect(log.status).toBe("CANCELLED");
    expect(log.outputTokens).toBeGreaterThan(300);
    expect(Number(log.price)).toBeGreaterThan((300 * 15) / 1e6);
  });

  it("G6: another customer's previous_response_id answers 404 (it is never continued)", async () => {
    await rememberResponse(`resp_bob_${h.sfx}`, { userId: bob.userId, providerId: oaProvider, providerKeyId: "x", routeId: "x", modelId: "x" });
    const res = await h.call("/v1/responses", alice.key, { model: oaSlug, input: "hi", previous_response_id: `resp_bob_${h.sfx}` });
    expect(res.status).toBe(404);
  });

  it("B2: a batch that has not ended cannot have its results deleted (409, nothing is lost)", async () => {
    const pk = await db.providerKey.findFirstOrThrow({ where: { providerId: oaProvider } });
    const row = await db.upstreamObject.create({
      data: { kind: "batch", upstreamId: `batch_sec_${h.sfx}`, providerId: oaProvider, providerKeyId: pk.id, userId: alice.userId, status: "in_progress", meta: { fmt: "openai_batches", models: [], multiplier: "1", groupSlug: null, holdId: null, holdAmount: "0" } },
    });
    const err = await ensureMetered(row).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GatewayError);
    expect((err as GatewayError).status).toBe(409);
  });

  it("B8: two meter entries with the same id in one flush are charged once", async () => {
    const u = await h.makeUser("dup", { balance: "10" });
    const id = `sec-dup-${h.sfx}`;
    h.ids.logs.push(id);
    const entry = () => ({
      log: { id, userId: u.id, endpoint: "/v1/messages/batches", inboundFormat: "anthropic_batches", status: "SUCCESS" as const, httpStatus: 200, price: "1", cost: "0.5", profit: "0.5", officialPrice: "1", createdAt: new Date() },
      userId: u.id,
      apiKeyId: null,
      providerKeyId: null,
      price: new Decimal(1),
      cost: new Decimal("0.5"),
      countForKey: false,
      keyHealthy: false,
      createdAt: new Date(),
    });
    enqueueMeter(entry());
    enqueueMeter(entry());
    await flushMeter();
    expect(Number(await h.balanceOf(u.id))).toBeCloseTo(9, 9);
  });

  it("W7: a TOTP code is good for one sign-in only (no replay)", async () => {
    const secret = new OTPAuth.Secret({ size: 20 });
    const u = await h.makeUser("totp", { balance: "0" });
    await db.user.update({ where: { id: u.id }, data: { totpSecret: encrypt(secret.base32), totpEnabled: true } });
    const code = new OTPAuth.TOTP({ secret, digits: 6, period: 30, algorithm: "SHA1" }).generate();
    expect((await verifyUserTotp(u.id, code)).ok).toBe(true);
    expect((await verifyUserTotp(u.id, code)).ok).toBe(false);
  });

  it("B5: one card unlocks the trial credit only once across accounts", async () => {
    const before = await db.setting.findUnique({ where: { key: "trialCredit" } });
    await db.setting.upsert({ where: { key: "trialCredit" }, create: { key: "trialCredit", value: 5 }, update: { value: 5 } });
    const { invalidateSettingsCache } = await import("@/lib/settings");
    invalidateSettingsCache();
    try {
      const fp = `fp_${h.sfx}`;
      const a = await h.makeUser("tr1", { balance: "0" });
      const b = await h.makeUser("tr2", { balance: "0" });
      expect((await grantTrialCredit(a.id, { cardFingerprint: fp })).granted).toBe(true);
      expect(await grantTrialCredit(b.id, { cardFingerprint: fp })).toMatchObject({ granted: false, reason: "card_already_used" });
      expect((await grantTrialCredit(b.id, { cardFingerprint: `${fp}-other` })).granted).toBe(true);
    } finally {
      if (before) await db.setting.update({ where: { key: "trialCredit" }, data: { value: before.value as never } });
      else await db.setting.delete({ where: { key: "trialCredit" } });
      invalidateSettingsCache();
    }
  });

  it("W12: recovery codes sign in once each", async () => {
    const u = await h.makeUser("rec", { balance: "0" });
    const { codes, hashes } = newRecoveryCodes();
    await db.user.update({ where: { id: u.id }, data: { totpEnabled: true, totpRecoveryCodes: hashes } });
    expect((await consumeRecoveryCode(u.id, codes[0].toUpperCase())).ok).toBe(true);
    expect((await consumeRecoveryCode(u.id, codes[0])).ok).toBe(false);
    expect((await consumeRecoveryCode(u.id, "aaaaa-bbbbb")).ok).toBe(false);
    expect((await consumeRecoveryCode(u.id, codes[1])).remaining).toBe(8);
  });

  it("(sanity) the gateway still serves normal requests", async () => {
    const res = await h.call("/v1/chat/completions", alice.key, { model: oaSlug, messages: [{ role: "user", content: "hi" }] });
    expect(res.status).toBe(200);
    await sleep(1);
  });
});
