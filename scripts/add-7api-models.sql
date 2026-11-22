-- Add 6 missing 7API models and wire them to studio-7a/coding-7a pools
-- Run: psql $(gcloud secrets versions access latest --secret=PP_DIRECT_URL --project=texhub-cloud) -f scripts/add-7api-models.sql

BEGIN;

SET search_path TO provider_proxy;

-- Get 7api provider ID
DO $$
DECLARE
  v_provider_id TEXT;
  v_model_id TEXT;
BEGIN
  SELECT id INTO v_provider_id FROM "Provider" WHERE slug = '7api';
  IF v_provider_id IS NULL THEN
    RAISE EXCEPTION '7api provider not found';
  END IF;

  RAISE NOTICE 'Provider 7api: %', v_provider_id;

  -- Model: gpt-6.2-astra
  INSERT INTO "Model" (slug, "displayName", vendor, status, "inputPrice", "outputPrice", "contextWindow", "maxOutput", capabilities)
  VALUES ('gpt-6.2-astra', 'GPT-6.2 Astra', 'openai', 'ACTIVE', 0.65, 0.65, 1050000, 128000, ARRAY['chat', 'responses'])
  ON CONFLICT (slug) DO UPDATE SET
    "inputPrice" = 0.65, "outputPrice" = 0.65, "contextWindow" = 1050000, "maxOutput" = 128000, capabilities = ARRAY['chat', 'responses']
  RETURNING id INTO v_model_id;
  RAISE NOTICE 'Model gpt-6.2-astra: %', v_model_id;

  INSERT INTO "ModelRoute" ("modelId", "providerId", "upstreamModel", "groupSlugs", enabled)
  VALUES (v_model_id, v_provider_id, 'gpt-6.2-astra', ARRAY['studio-7a', 'coding-7a'], true)
  ON CONFLICT ("modelId", "providerId") DO UPDATE SET "groupSlugs" = ARRAY['studio-7a', 'coding-7a'], enabled = true;

  -- Model: gpt-6.2-sol
  INSERT INTO "Model" (slug, "displayName", vendor, status, "inputPrice", "outputPrice", "contextWindow", "maxOutput", capabilities)
  VALUES ('gpt-6.2-sol', 'GPT-6.2 Sol', 'openai', 'ACTIVE', 0.15, 0.15, 1050000, 128000, ARRAY['chat', 'responses'])
  ON CONFLICT (slug) DO UPDATE SET
    "inputPrice" = 0.15, "outputPrice" = 0.15, "contextWindow" = 1050000, "maxOutput" = 128000, capabilities = ARRAY['chat', 'responses']
  RETURNING id INTO v_model_id;
  RAISE NOTICE 'Model gpt-6.2-sol: %', v_model_id;

  INSERT INTO "ModelRoute" ("modelId", "providerId", "upstreamModel", "groupSlugs", enabled)
  VALUES (v_model_id, v_provider_id, 'gpt-6.2-sol', ARRAY['studio-7a', 'coding-7a'], true)
  ON CONFLICT ("modelId", "providerId") DO UPDATE SET "groupSlugs" = ARRAY['studio-7a', 'coding-7a'], enabled = true;

  -- Model: gpt-6-luna (exists, just wire route)
  SELECT id INTO v_model_id FROM "Model" WHERE slug = 'gpt-6-luna';
  IF v_model_id IS NOT NULL THEN
    UPDATE "Model" SET "inputPrice" = 0.05, "outputPrice" = 0.05, "contextWindow" = 1050000, "maxOutput" = 128000, capabilities = ARRAY['chat', 'responses']
    WHERE id = v_model_id;

    INSERT INTO "ModelRoute" ("modelId", "providerId", "upstreamModel", "groupSlugs", enabled)
    VALUES (v_model_id, v_provider_id, 'gpt-6-luna', ARRAY['studio-7a', 'coding-7a'], true)
    ON CONFLICT ("modelId", "providerId") DO UPDATE SET "groupSlugs" = ARRAY['studio-7a', 'coding-7a'], enabled = true;
    RAISE NOTICE 'Model gpt-6-luna: %', v_model_id;
  END IF;

  -- Model: gpt-5.6-luna (exists, just wire route)
  SELECT id INTO v_model_id FROM "Model" WHERE slug = 'gpt-5.6-luna';
  IF v_model_id IS NOT NULL THEN
    UPDATE "Model" SET "inputPrice" = 0.45, "outputPrice" = 0.45, "contextWindow" = 1000000, "maxOutput" = 128000, capabilities = ARRAY['chat', 'responses']
    WHERE id = v_model_id;

    INSERT INTO "ModelRoute" ("modelId", "providerId", "upstreamModel", "groupSlugs", enabled)
    VALUES (v_model_id, v_provider_id, 'gpt-5.6-luna', ARRAY['studio-7a', 'coding-7a'], true)
    ON CONFLICT ("modelId", "providerId") DO UPDATE SET "groupSlugs" = ARRAY['studio-7a', 'coding-7a'], enabled = true;
    RAISE NOTICE 'Model gpt-5.6-luna: %', v_model_id;
  END IF;

  -- Model: gpt-5.5
  INSERT INTO "Model" (slug, "displayName", vendor, status, "inputPrice", "outputPrice", "contextWindow", "maxOutput", capabilities)
  VALUES ('gpt-5.5', 'GPT-5.5', 'openai', 'ACTIVE', 0.45, 0.45, 1000000, 128000, ARRAY['chat', 'responses'])
  ON CONFLICT (slug) DO UPDATE SET
    "inputPrice" = 0.45, "outputPrice" = 0.45, "contextWindow" = 1000000, "maxOutput" = 128000, capabilities = ARRAY['chat', 'responses']
  RETURNING id INTO v_model_id;
  RAISE NOTICE 'Model gpt-5.5: %', v_model_id;

  INSERT INTO "ModelRoute" ("modelId", "providerId", "upstreamModel", "groupSlugs", enabled)
  VALUES (v_model_id, v_provider_id, 'gpt-5.5', ARRAY['studio-7a', 'coding-7a'], true)
  ON CONFLICT ("modelId", "providerId") DO UPDATE SET "groupSlugs" = ARRAY['studio-7a', 'coding-7a'], enabled = true;

  -- Model: claude-opus-5-5-max
  INSERT INTO "Model" (slug, "displayName", vendor, status, "inputPrice", "outputPrice", "contextWindow", "maxOutput", capabilities)
  VALUES ('claude-opus-5-5-max', 'Claude Opus 5.5 Max', 'anthropic', 'ACTIVE', 0.7, 0.7, 1000000, 128000, ARRAY['chat', 'responses'])
  ON CONFLICT (slug) DO UPDATE SET
    "inputPrice" = 0.7, "outputPrice" = 0.7, "contextWindow" = 1000000, "maxOutput" = 128000, capabilities = ARRAY['chat', 'responses']
  RETURNING id INTO v_model_id;
  RAISE NOTICE 'Model claude-opus-5-5-max: %', v_model_id;

  INSERT INTO "ModelRoute" ("modelId", "providerId", "upstreamModel", "groupSlugs", enabled)
  VALUES (v_model_id, v_provider_id, 'claude-opus-5-5-max', ARRAY['studio-7a', 'coding-7a'], true)
  ON CONFLICT ("modelId", "providerId") DO UPDATE SET "groupSlugs" = ARRAY['studio-7a', 'coding-7a'], enabled = true;

  -- Audit log
  INSERT INTO "AuditLog" (action, actor, target, details)
  VALUES ('model.bulk_update', 'admin@texhub.ai', '7api',
    jsonb_build_object(
      'added', ARRAY['gpt-6.2-astra', 'gpt-6.2-sol', 'gpt-6-luna', 'gpt-5.6-luna', 'gpt-5.5', 'claude-opus-5-5-max'],
      'pools', ARRAY['studio-7a', 'coding-7a'],
      'timestamp', now()
    )
  );

  RAISE NOTICE 'All models added and wired to studio-7a/coding-7a';
END $$;

COMMIT;
