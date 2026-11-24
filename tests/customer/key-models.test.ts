import { describe, expect, it } from "vitest";
import { modelsForKey, modelCopyValue, type PoolModel } from "@/components/customer/key-models";

const model = (slug: string, poolSlugs: string[], capabilities = ["chat"]): PoolModel => ({ slug, displayName: slug, vendor: "example", poolSlugs, capabilities });
const a = model("gpt-6.2-astra", ["coding", "studio"], ["responses"]);
const o = model("claude-opus-5-5-max", ["coding"]);
const img = model("image-model", ["studio"], ["images"]);
const all = [a, o, img];
describe("key model preview and commands", () => {
  it("changes with the selected pool and fails closed without one", () => {
    expect(modelsForKey(all, "coding")).toEqual([a, o]);
    expect(modelsForKey(all, "studio")).toEqual([a, img]);
    expect(modelsForKey(all, undefined)).toEqual([]);
  });
  it("does not broaden an explicit key restriction when the pool changes", () => {
    expect(modelsForKey(all, "coding", [a.slug, img.slug])).toEqual([a]);
    expect(modelsForKey(all, "studio", [o.slug])).toEqual([]);
  });
  it("copies Claude commands for text models and raw IDs for API clients and non-chat models", () => {
    expect(modelCopyValue(o, true)).toBe("/model claude-opus-5-5-max");
    expect(modelCopyValue(a, true)).toBe("/model gpt-6.2-astra");
    expect(modelCopyValue(img, true)).toBe(img.slug);
    const alias = { ...a, claudeCodeAlias: "claude-gpt-6.2-astra" };
    expect(modelCopyValue(alias, true)).toBe("/model claude-gpt-6.2-astra");
    expect(modelCopyValue(alias, false)).toBe(a.slug);
  });
});
