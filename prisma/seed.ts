import "dotenv/config";
import { db } from "../src/lib/db";
import { env, isProd } from "../src/lib/env";
import { encrypt, secretHint, sha256 } from "../src/lib/crypto";
import { hashPassword } from "../src/lib/auth/password";
import { Decimal } from "../src/lib/money";
import { SETTING_KEYS, SETTING_DEFS } from "../src/lib/settings";
import { MODELS, PROVIDERS, SELL_FACTOR } from "./seed-data";

/**
 * Idempotent seed. Re-running never overwrites values an admin may have edited
 * (settings, groups, providers, models, routes use create-if-missing semantics).
 */
const sell = (official: string) => new Decimal(official).times(SELL_FACTOR).toFixed(12);
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
  for (const m of MODELS) {
    const provider = await db.provider.findUniqueOrThrow({ where: { slug: m.provider } });
    const input = m.input ? new Decimal(m.input) : null;
    const cacheWrite = input && m.cacheWriteMult ? input.times(m.cacheWriteMult) : null;
    const cacheWrite1h = input && m.cacheWrite1hMult ? input.times(m.cacheWrite1hMult) : null;
    const sellInput = input ? sell(m.input!) : money("0");
    const model = await db.model.upsert({
      where: { slug: m.slug },
      create: {
        slug: m.slug,
        displayName: m.displayName,
        vendor: m.vendor,
        description: m.description,
        capabilities: m.capabilities,
        contextWindow: m.contextWindow,
        maxOutput: m.maxOutput || null,
        sortOrder: m.sortOrder,
        inputPrice: sellInput,
        outputPrice: m.output ? sell(m.output) : money("0"),
        cachedInputPrice: m.cached ? sell(m.cached) : null,
        cacheWritePrice: cacheWrite ? sell(cacheWrite.toString()) : null,
        cacheWrite1hPrice: cacheWrite1h ? sell(cacheWrite1h.toString()) : null,
        imagePrice: m.image ? sell(m.image) : null,
        longContextThreshold: m.longContext?.threshold ?? null,
        longContextMultiplier: m.longContext?.multiplier ?? null,
        officialInputPrice: m.input ? money(m.input) : null,
        officialOutputPrice: m.output ? money(m.output) : null,
        officialCachedPrice: m.cached ? money(m.cached) : null,
      },
      update: {},
    });
    await db.modelRoute.upsert({
      where: { modelId_providerId_upstreamModel: { modelId: model.id, providerId: provider.id, upstreamModel: m.slug } },
      create: {
        modelId: model.id,
        providerId: provider.id,
        upstreamModel: m.slug,
        label: provider.name,
        inputCost: m.input ? money(m.input) : money("0"),
        outputCost: m.output ? money(m.output) : money("0"),
        cachedInputCost: m.cached ? money(m.cached) : null,
        cacheWriteCost: cacheWrite ? money(cacheWrite) : null,
        cacheWrite1hCost: cacheWrite1h ? money(cacheWrite1h) : null,
        imageCost: m.image ? money(m.image) : null,
      },
      update: {},
    });
  }
  console.log(`models: ${MODELS.length} catalog entries with routes`);
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

  const mocks = [
    { slug: "mock-gpt", name: "Mock GPT", upstream: "gpt-mock", caps: ["chat", "completions", "responses", "vision", "tools"], inP: "1", outP: "2", cachedP: "0.5", inC: "0.5", outC: "1", cachedC: "0.25", sort: 900 },
    { slug: "mock-claude", name: "Mock Claude", upstream: "claude-mock", caps: ["chat", "vision", "tools"], inP: "3", outP: "15", cachedP: "0.3", inC: "1.5", outC: "7.5", cachedC: "0.15", sort: 910 },
    { slug: "mock-embed", name: "Mock Embeddings", upstream: "embed-mock", caps: ["embeddings"], inP: "0.1", outP: "0", cachedP: null, inC: "0.05", outC: "0", cachedC: null, sort: 920 },
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
      },
      update: {},
    });
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
    create: { slug: "mock-image", displayName: "Mock Image", vendor: "mock", description: "Mock image generation (dev only).", capabilities: ["images"], sortOrder: 930, imagePrice: money("0.02") },
    update: {},
  });
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
