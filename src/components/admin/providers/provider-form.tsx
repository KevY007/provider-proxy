"use client";

import { MultiSelectField, NumberField, SelectField, TagsField, TextAreaField, JsonField } from "@/components/admin/fields";
import { TextField } from "@/components/common/form-fields";
import { UserAgentSelect } from "@/components/common/user-agent-select";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { isPassthrough } from "@/lib/user-agents";

export interface ProviderFormState {
  name: string;
  slug: string;
  preset: string;
  baseUrl: string;
  authStyle: string;
  formats: string[];
  tags: string[];
  extraHeaders: string;
  settings: string;
  status: string;
  timeoutMs: string;
  priority: string;
  maxConcurrency: string;
  notes: string;
}

export const AUTH_STYLE_OPTIONS = [
  { value: "BEARER", label: "Bearer token (Authorization)" },
  { value: "X_API_KEY", label: "x-api-key header (Anthropic)" },
  { value: "X_GOOG_API_KEY", label: "x-goog-api-key header (Google)" },
  { value: "AZURE_API_KEY", label: "api-key header (Azure)" },
  { value: "QUERY_KEY", label: "?key= query parameter" },
];

// keep in sync with ENDPOINT_FORMATS (gateway/providers/presets); duplicated so client bundles don't import gateway code
export const FORMAT_OPTIONS = [
  ["openai_chat", "Chat Completions"],
  ["openai_completions", "legacy Completions"],
  ["openai_responses", "Responses API"],
  ["openai_embeddings", "Embeddings"],
  ["openai_images", "Images"],
  ["openai_audio", "Speech / transcription"],
  ["openai_moderations", "Moderations"],
  ["openai_videos", "Videos"],
  ["openai_files", "Files + Uploads (/v1/files)"],
  ["openai_batches", "Batch API (/v1/batches)"],
  ["anthropic_messages", "Messages API"],
  ["anthropic_files", "Files API (/v1/files)"],
  ["anthropic_batches", "Message Batches (/v1/messages/batches)"],
  ["gemini", "generateContent"],
  ["gemini_files", "Files API (resumable upload)"],
].map(([value, hint]) => ({ value, label: value, hint }));

export function emptyProviderForm(): ProviderFormState {
  return {
    name: "", slug: "", preset: "custom", baseUrl: "", authStyle: "BEARER", formats: ["openai_chat"], tags: [],
    extraHeaders: "{}", settings: "{}", status: "ACTIVE", timeoutMs: "600000", priority: "0", maxConcurrency: "", notes: "",
  };
}

/** Payload sent to the createProvider / updateProvider actions. */
export function providerPayload(s: ProviderFormState) {
  return { ...s, slug: s.slug.trim() };
}

export function ProviderFormFields({
  state,
  set,
  errors,
  showSlug = true,
}: {
  state: ProviderFormState;
  set: (patch: Partial<ProviderFormState>) => void;
  errors: Record<string, string>;
  showSlug?: boolean;
}) {
  return (
    <div className="grid gap-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField label="Name" value={state.name} onChange={(e) => set({ name: e.target.value })} error={errors.name} placeholder="OpenAI" required />
        {showSlug && (
          <TextField label="Slug" value={state.slug} onChange={(e) => set({ slug: e.target.value })} error={errors.slug} description="Leave empty to derive from the name." placeholder="openai" />
        )}
      </div>
      <TextField
        label="Base URL"
        value={state.baseUrl}
        onChange={(e) => set({ baseUrl: e.target.value })}
        error={errors.baseUrl}
        placeholder="https://api.openai.com/v1"
        description="Upstream origin (OpenAI-style bases include /v1). Sent requests are built from this."
        required
      />
      <div className="grid gap-4 sm:grid-cols-2">
        <SelectField label="Auth style" value={state.authStyle} onChange={(v) => set({ authStyle: v })} options={AUTH_STYLE_OPTIONS} error={errors.authStyle} />
        <SelectField
          label="Status"
          value={state.status}
          onChange={(v) => set({ status: v })}
          options={[
            { value: "ACTIVE", label: "Active" },
            { value: "DISABLED", label: "Disabled" },
          ]}
        />
      </div>
      <MultiSelectField
        label="Native endpoint formats"
        values={state.formats}
        onChange={(v) => set({ formats: v })}
        options={FORMAT_OPTIONS}
        error={errors.formats}
        description="Formats this upstream accepts natively. Others are translated by the gateway where possible."
      />
      <TagsField label="Tags" values={state.tags} onChange={(v) => set({ tags: v })} description="Groups with provider tags only route to providers sharing a tag (e.g. official, reseller, cheap)." />
      <div className="grid gap-4 sm:grid-cols-3">
        <NumberField label="Timeout" suffix="ms" step="1000" value={state.timeoutMs} onChange={(v) => set({ timeoutMs: v })} error={errors.timeoutMs} />
        <NumberField label="Priority" step="1" value={state.priority} onChange={(v) => set({ priority: v })} error={errors.priority} description="Higher is tried first." />
        <NumberField label="Max concurrency" step="1" min={1} placeholder="unlimited" value={state.maxConcurrency} onChange={(v) => set({ maxConcurrency: v })} error={errors.maxConcurrency} description="Cap across all keys." />
      </div>
      <ProviderUserAgent settings={state.settings} onChange={(v) => set({ settings: v })} />
      <div className="grid gap-4 sm:grid-cols-2">
        <JsonField
          label="Extra headers (JSON)"
          value={state.extraHeaders}
          onChange={(v) => set({ extraHeaders: v })}
          error={errors.extraHeaders}
          description='Sent on every upstream request, e.g. { "OpenAI-Organization": "org-..." }'
        />
        <JsonField
          label="Settings (JSON)"
          value={state.settings}
          onChange={(v) => set({ settings: v })}
          error={errors.settings}
          description="anthropicVersion, azureApiVersion, stripFields, forceStreamUsage, anthropicBaseUrl, geminiBaseUrl, idleTimeoutSec (cut a silent stream), noCooldown (true: transient errors never pause this provider's keys), streamUpstream (true: send non-streaming requests upstream as streams and assemble the JSON reply), stripCacheHints (true: remove prompt_cache_breakpoint / prompt_cache_options for an upstream that rejects or ignores them), serviceTiers (a list of the tiers it really serves, e.g. auto and default; requests for other tiers go elsewhere or get a 400), enforceMaxOutputTokens (true: the upstream ignores max_output_tokens, the gateway ends the stream with response.incomplete), userAgent (set it with the Client identity selector above), pricingUrl (a URL where this provider publishes its prices, for Fetch pricing), http2 (OPT-IN, default off: true = HTTP/2 to this https upstream; enable only for providers known to speak h2)."
        />
      </div>
      <TextAreaField label="Notes" value={state.notes} onChange={(v) => set({ notes: v })} rows={2} description="Internal only." />
    </div>
  );
}

/**
 * Client identity selector for the provider: reads and writes `userAgent` inside the Settings JSON, so the saved
 * form is unchanged. Passthrough removes the key. Disabled while the JSON does not parse.
 */
function ProviderUserAgent({ settings, onChange }: { settings: string; onChange: (json: string) => void }) {
  let obj: Record<string, unknown> | null = null;
  try {
    const p = JSON.parse(settings || "{}");
    if (p && typeof p === "object" && !Array.isArray(p)) obj = p as Record<string, unknown>;
  } catch {
    obj = null;
  }
  const current = obj && typeof obj.userAgent === "string" ? obj.userAgent : "";
  return (
    <Field>
      <FieldLabel htmlFor="provider-ua">Client identity (user-agent)</FieldLabel>
      <UserAgentSelect
        id="provider-ua"
        value={current}
        disabled={!obj}
        passthroughLabel="Passthrough (default): the key's choice, else the caller's own"
        onChange={(v) => {
          if (!obj) return;
          const next = { ...obj };
          if (isPassthrough(v) && v !== " ") delete next.userAgent;
          else next.userAgent = v.trim() ? v : " ";
          onChange(JSON.stringify(next, null, 2));
        }}
      />
      <FieldDescription>
        {obj
          ? "What this provider tells the upstream the client is. Anything but passthrough overrides what customers set on their API keys. Needed by upstream groups that only accept one client."
          : "Fix the Settings JSON below to use this selector."}
      </FieldDescription>
    </Field>
  );
}
