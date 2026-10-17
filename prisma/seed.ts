import "dotenv/config";
import { db } from "../src/lib/db";
import { env, isProd } from "../src/lib/env";
import { encrypt, secretHint, sha256 } from "../src/lib/crypto";
import { hashPassword } from "../src/lib/auth/password";
import { Decimal } from "../src/lib/money";
import { SETTING_KEYS, SETTING_DEFS } from "../src/lib/settings";
import { lookupKnownPrice } from "../src/gateway/price-catalog";
import { knownCostFields, knownOfficialFields, knownSellFields, toDec } from "../src/server/pricing/fields";
import { defaultRuleForKnown, migrateSeededMarkupRules } from "../src/server/pricing/default-policy";
import { LEGACY_SELL_FACTOR, MODELS, PROVIDERS, SEED_MARKUP_PERCENT, SELL_FACTOR } from "./seed-data";

/**
 * Idempotent seed. Re-running never overwrites values an admin may have edited
 * (settings, groups, providers, models, routes use create-if-missing semantics).
 */
const legacySell = (official: string) => new Decimal(official).times(LEGACY_SELL_FACTOR).toFixed(12);
const money = (v: string | Decimal) => new Decimal(v).toFixed(12);

async function seedSettings() {
  for (const key of SETTING_KEYS) {
    await db.setting.upsert({
      where: { key },
      create: { key, value: SETTING_DEFS[key].default as never },
      update: {},
    });
  }
  console.log(`settings: ${SETTING_KEYS.length} keys ensured`);
}

async function seedGroups() {
  const groups = [
    { slug: "standard", name: "Standard", description: "Default pool.", priceMultiplier: "1", isDefault: true, isPublic: true, sortOrder: 0 },
    { slug: "pro", name: "Pro", description: "Discounted pool for high-volume customers.", priceMultiplier: "0.8", isDefault: false, isPublic: true, sortOrder: 10 },
    { slug: "enterprise", name: "Enterprise", description: "Negotiated pricing; assigned by an admin.", priceMultiplier: "0.6", isDefault: false, isPublic: false, sortOrder: 20 },
  ];
  for (const g of groups) {
    await db.group.upsert({ where: { slug: g.slug }, create: g, update: {} });
  }
  console.log("groups: standard / pro / enterprise");
}

async function seedUsers() {
  const standard = await db.group.findUniqueOrThrow({ where: { slug: "standard" } });

  const adminEmail = (env.ADMIN_EMAIL ?? (isProd ? "" : "admin@example.com")).toLowerCase();
  const adminPassword = env.ADMIN_PASSWORD ?? (isProd ? "" : "change-me-now-please");
  if (adminEmail && adminPassword) {
    const existing = await db.user.findUnique({ where: { email: adminEmail } });
    if (!existing) {
      await db.user.create({
        data: {
          email: adminEmail,
          name: "Admin",
          passwordHash: await hashPassword(adminPassword),
          role: "ADMIN",
          status: "ACTIVE",
          emailVerifiedAt: new Date(),
          groupId: standard.id,
        },
      });
      console.log(`admin user created: ${adminEmail}`);
    } else {
      console.log(`admin user exists: ${adminEmail}`);
    }
  } else {
    console.warn("ADMIN_EMAIL / ADMIN_PASSWORD not set - skipping admin user");
  }

  if (!isProd) {
    const demo = await db.user.findUnique({ where: { email: "demo@example.com" } });
    if (!demo) {
      const created = await db.user.create({
        data: {
          email: "demo@example.com",
          name: "Demo Customer",
          passwordHash: await hashPassword("demo-password-123"),
          role: "CUSTOMER",
          status: "ACTIVE",
          emailVerifiedAt: new Date(),
          groupId: standard.id,
          balance: money("25"),
          trialGrantedAt: new Date(),
        },
      });
      await db.ledgerEntry.create({
        data: { userId: created.id, type: "ADJUSTMENT", amount: money("25"), balanceAfter: money("25"), description: "Seed credit (dev)" },
      });
      console.log("demo customer created: demo@example.com / demo-password-123 ($25)");
    }
    // Fixed dev API key so gateway work can start before the dashboard's key UI exists.
    const demoUser = await db.user.findUniqueOrThrow({ where: { email: "demo@example.com" } });
    const devKey = "sk-pp-" + "devdemo".padEnd(40, "0");
    await db.apiKey.upsert({
      where: { keyHash: sha256(devKey) },
      create: { userId: demoUser.id, name: "Dev demo key", prefix: devKey.slice(0, 12), keyHash: sha256(devKey) },
      update: {},
    });
    console.log(`dev API key for demo user: ${devKey}`);
  }
}

async function seedProviders() {
  for (const p of PROVIDERS) {
    await db.provider.upsert({
      where: { slug: p.slug },
      create: {
        slug: p.slug,
        name: p.name,
        preset: p.preset,
        baseUrl: p.baseUrl,
        authStyle: p.authStyle,
        formats: p.formats,
        tags: p.tags,
        settings: p.settings as never,
        status: "DISABLED", // no keys yet - admin enables after adding upstream keys
        notes: p.notes,
        priority: p.priority ?? 0,
      },
      update: {},
    });
  }
  console.log(`providers: ${PROVIDERS.length} presets (disabled, no keys)`);
}

async function seedModels() {
  let created = 0;
  let ruled = 0;
  let backfilled = 0;
  for (const m of MODELS) {
    const provider = await db.provider.findUniqueOrThrow({ where: { slug: m.provider } });
    const upstream = m.upstream ?? m.slug;
    const known = lookupKnownPrice(provider.preset, upstream);
    if (!known) throw new Error(`seed model ${m.slug}: no known price for ${provider.preset}/${upstream} (src/gateway/price-catalog.ts)`);
    const official = knownOfficialFields(known);
    const cost = knownCostFields(known);
    // owner policy: sell at the official price ("match official") where one exists, +30% over cost otherwise
    const rule = defaultRuleForKnown(known);
    const sellNew = knownSellFields(known, rule);
    // what older seeds wrote (cost x 1.3): a row that still carries it was never touched by an admin
    const sellOldSeed = knownSellFields(known, { mode: "MARKUP_OVER_COST", value: SEED_MARKUP_PERCENT });
    const aliases = (known.aliases ?? []).filter((a) => a !== m.slug);

    let model = await db.model.findUnique({ where: { slug: m.slug } });
    if (!model) {
      model = await db.model.create({
        data: {
          slug: m.slug,
          aliases,
          displayName: m.displayName,
          vendor: m.vendor,
          description: m.description,
          capabilities: known.capabilities ?? ["chat"],
          contextWindow: known.contextWindow || null,
          maxOutput: known.maxOutput || null,
          sortOrder: m.sortOrder,
          longContextThreshold: known.longContext?.threshold ?? null,
          longContextMultiplier: known.longContext ? String(known.longContext.multiplier) : null,
          retiresAt: known.retiresAt ? new Date(known.retiresAt) : null,
          ...official,
          ...sellNew,
          pricingMode: rule.mode,
          pricingValue: String(rule.value),
        },
      });
      created++;
    } else {
      // Backfill for rows created by older seeds. Never overwrites anything an admin may have edited:
      //  - official prices (and official tool prices) only where still NULL / empty,
      //  - catalog aliases are only ADDED,
      //  - the pricing rule only where the sell prices still equal the old seed-derived values (cost x 1.3) - then the
      //    prices are re-derived under the default rule.
      const row = model as unknown as Record<string, unknown>;
      const data: Record<string, unknown> = {};
      for (const [col, v] of Object.entries(official)) {
        if (typeof v === "object" && v !== null) {
          const cur = row[col];
          if ((!cur || Object.keys(cur as object).length === 0) && Object.keys(v).length) data[col] = v;
        } else if (row[col] === null && v !== null) data[col] = v;
      }
      // server-tool sell prices did not exist before: fill them in at the model's own ratio to the official price
      const knownTools = (official.officialToolPrices ?? {}) as Record<string, string>;
      const hasTools = row.toolPrices && Object.keys(row.toolPrices as object).length > 0;
      if (!hasTools && Object.keys(knownTools).length) {
        const f =
          model.pricingMode === "PERCENT_OF_OFFICIAL" && model.pricingValue
            ? new Decimal(model.pricingValue.toString()).div(100)
            : model.pricingMode === "MARKUP_OVER_COST" && model.pricingValue
              ? new Decimal(model.pricingValue.toString()).div(100).plus(1)
              : new Decimal(1);
        data.toolPrices = Object.fromEntries(Object.entries(knownTools).map(([k, v]) => [k, new Decimal(v).times(f).toFixed(12)]));
      }
      const missingAliases = aliases.filter((a) => !model!.aliases.includes(a));
      if (missingAliases.length) data.aliases = [...model.aliases, ...missingAliases];
      if (model.retiresAt === null && known.retiresAt) data.retiresAt = new Date(known.retiresAt);
      if (model.pricingMode === "FIXED" && model.pricingValue === null) {
        const untouchedSeedPrices = Object.entries(sellOldSeed).every(([col, v]) => typeof v !== "string" || (toDec(row[col])?.equals(new Decimal(v)) ?? false));
        // a dev DB seeded under the old policy (official x 0.5) would sell BELOW cost: re-price rows that still carry it
        const legacy = !!known.official.input && new Decimal(model.inputPrice.toString()).equals(legacySell(String(known.official.input)));
        if (untouchedSeedPrices || legacy) {
          Object.assign(data, sellNew);
          data.pricingMode = rule.mode;
          data.pricingValue = String(rule.value);
          ruled++;
        }
      }
      if (Object.keys(data).length) {
        model = await db.model.update({ where: { id: model.id }, data });
        backfilled++;
      }
    }
    await db.modelRoute.upsert({
      where: { modelId_providerId_upstreamModel: { modelId: model.id, providerId: provider.id, upstreamModel: upstream } },
      create: { modelId: model.id, providerId: provider.id, upstreamModel: upstream, label: provider.name, ...cost },
      update: {},
    });
    // server-tool costs of routes created before tool metering existed
    const route = await db.modelRoute.findUnique({ where: { modelId_providerId_upstreamModel: { modelId: model.id, providerId: provider.id, upstreamModel: upstream } }, select: { id: true, toolCosts: true } });
    const toolCosts = cost.toolCosts;
    if (route && toolCosts && typeof toolCosts === "object" && Object.keys(toolCosts).length && Object.keys((route.toolCosts as object | null) ?? {}).length === 0) {
      await db.modelRoute.update({ where: { id: route.id }, data: { toolCosts } });
    }
  }
  // models seeded under the previous default (+30% over cost) that an admin never touched: "match official"
  const migration = await migrateSeededMarkupRules();
  console.log(
    `models: ${MODELS.length} catalog entries with routes (default price rule: match official = 100% of the official price, +${SEED_MARKUP_PERCENT}% over cost where there is none [cost x ${SELL_FACTOR}]; ${created} created, ${ruled} re-ruled, ${backfilled} backfilled, ${migration.migrated.length} moved from the old +${SEED_MARKUP_PERCENT}% default)`,
  );
}

/** Fill official-price columns that are still NULL (never overwrites an admin's value). */
async function backfillOfficial(modelId: string, values: Record<string, string | null>) {
  const row = (await db.model.findUnique({ where: { id: modelId } })) as unknown as Record<string, unknown> | null;
  if (!row) return;
  const data: Record<string, string> = {};
  for (const [col, v] of Object.entries(values)) if (v !== null && row[col] === null) data[col] = v;
  if (Object.keys(data).length) await db.model.update({ where: { id: modelId }, data });
}

async function seedMock() {
  if (isProd) return;
  const root = env.MOCK_UPSTREAM_URL.replace(/\/+$/, "");
  const data = {
    name: "Mock Upstream",
    preset: "custom",
    baseUrl: `${root}/v1`,
    authStyle: "BEARER" as const,
    formats: ["openai_chat", "openai_completions", "openai_responses", "openai_embeddings", "openai_images", "openai_audio", "anthropic_messages", "gemini"],
    tags: ["mock"],
    settings: { anthropicBaseUrl: root, geminiBaseUrl: root },
    status: "ACTIVE" as const,
    notes: "Local fake upstream (pnpm mock:upstream). Dev only.",
  };
  const provider = await db.provider.upsert({
    where: { slug: "mock-upstream" },
    create: { slug: "mock-upstream", ...data },
    update: { baseUrl: data.baseUrl, formats: data.formats, settings: data.settings, status: "ACTIVE" },
  });

  for (let i = 1; i <= 3; i++) {
    const secret = `mock-key-${i}`;
    const label = `Mock key ${i}`;
    const exists = await db.providerKey.findFirst({ where: { providerId: provider.id, label } });
    if (!exists) {
      await db.providerKey.create({
        data: { providerId: provider.id, label, secretEncrypted: encrypt(secret), secretHint: secretHint(secret), maxConcurrency: 100, weight: 1, priority: 0 },
      });
    }
  }

  // "off*" = the pretend official list price, so the dev UI can show savings (the mock models sell below it)
  const mocks = [
    { slug: "mock-gpt", name: "Mock GPT", upstream: "gpt-mock", caps: ["chat", "completions", "responses", "vision", "tools"], inP: "1", outP: "2", cachedP: "0.5", inC: "0.5", outC: "1", cachedC: "0.25", offIn: "3", offOut: "6", offCached: "1.5", sort: 900 },
    { slug: "mock-claude", name: "Mock Claude", upstream: "claude-mock", caps: ["chat", "vision", "tools"], inP: "3", outP: "15", cachedP: "0.3", inC: "1.5", outC: "7.5", cachedC: "0.15", offIn: "5", offOut: "25", offCached: "0.5", sort: 910 },
    { slug: "mock-embed", name: "Mock Embeddings", upstream: "embed-mock", caps: ["embeddings"], inP: "0.1", outP: "0", cachedP: null, inC: "0.05", outC: "0", cachedC: null, offIn: "0.13", offOut: "0", offCached: null, sort: 920 },
  ];
  for (const m of mocks) {
    const model = await db.model.upsert({
      where: { slug: m.slug },
      create: {
        slug: m.slug,
        displayName: m.name,
        vendor: "mock",
        description: "Served by the local mock upstream (dev only).",
        capabilities: m.caps,
        contextWindow: 128_000,
        maxOutput: 16_000,
        sortOrder: m.sort,
        inputPrice: money(m.inP),
        outputPrice: money(m.outP),
        cachedInputPrice: m.cachedP ? money(m.cachedP) : null,
        officialInputPrice: money(m.offIn),
        officialOutputPrice: money(m.offOut),
        officialCachedPrice: m.offCached ? money(m.offCached) : null,
      },
      update: {},
    });
    await backfillOfficial(model.id, { officialInputPrice: money(m.offIn), officialOutputPrice: money(m.offOut), officialCachedPrice: m.offCached ? money(m.offCached) : null });
    await db.modelRoute.upsert({
      where: { modelId_providerId_upstreamModel: { modelId: model.id, providerId: provider.id, upstreamModel: m.upstream } },
      create: {
        modelId: model.id,
        providerId: provider.id,
        upstreamModel: m.upstream,
        label: "Mock",
        inputCost: money(m.inC),
        outputCost: money(m.outC),
        cachedInputCost: m.cachedC ? money(m.cachedC) : null,
      },
      update: {},
    });
  }
  // image model (flat per-image price)
  const img = await db.model.upsert({
    where: { slug: "mock-image" },
    create: { slug: "mock-image", displayName: "Mock Image", vendor: "mock", description: "Mock image generation (dev only).", capabilities: ["images"], sortOrder: 930, imagePrice: money("0.02"), officialImagePrice: money("0.04") },
    update: {},
  });
  await backfillOfficial(img.id, { officialImagePrice: money("0.04") });
  await db.modelRoute.upsert({
    where: { modelId_providerId_upstreamModel: { modelId: img.id, providerId: provider.id, upstreamModel: "image-mock" } },
    create: { modelId: img.id, providerId: provider.id, upstreamModel: "image-mock", label: "Mock", imageCost: money("0.01") },
    update: {},
  });
  console.log(`mock upstream: provider + 3 keys + models (mock-gpt, mock-claude, mock-embed, mock-image) -> ${root}`);
}

async function main() {
  await seedSettings();
  await seedGroups();
  await seedUsers();
  await seedProviders();
  await seedModels();
  await seedMock();
}

main()
  .then(() => db.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await db.$disconnect();
    process.exit(1);
  });
