"use client";

import { useId, useMemo, useState } from "react";
import { Check, ChevronsUpDown, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

/** Radix Select can't take "" as a value, so "no selection" is encoded with this sentinel. */
const NONE = "__none__";

export interface Option {
  value: string;
  label: string;
  hint?: string;
}

export function SelectField({
  label,
  value,
  onChange,
  options,
  error,
  description,
  allowNone,
  noneLabel = "None",
  placeholder = "Select...",
  disabled,
  className,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: Option[];
  error?: string;
  description?: React.ReactNode;
  /** Adds a "None" item that maps to "". */
  allowNone?: boolean;
  noneLabel?: string;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
}) {
  const id = useId();
  return (
    <Field data-invalid={!!error} className={className}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Select value={value === "" ? (allowNone ? NONE : "") : value} onValueChange={(v) => onChange(v === NONE ? "" : v)} disabled={disabled}>
        <SelectTrigger id={id} className="w-full" aria-invalid={!!error}>
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <SelectContent>
          {allowNone && <SelectItem value={NONE}>{noneLabel}</SelectItem>}
          {options.map((o) => (
            <SelectItem key={o.value} value={o.value}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {description && !error && <FieldDescription>{description}</FieldDescription>}
      {error && <FieldError role="alert">{error}</FieldError>}
    </Field>
  );
}

export function SwitchField({
  label,
  checked,
  onChange,
  description,
  disabled,
  className,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  description?: React.ReactNode;
  disabled?: boolean;
  className?: string;
}) {
  const id = useId();
  return (
    <div className={cn("flex items-start justify-between gap-3 rounded-lg border p-3", className)}>
      <div className="space-y-0.5">
        <label htmlFor={id} className="text-sm font-medium leading-none">
          {label}
        </label>
        {description && <p className="text-xs text-muted-foreground">{description}</p>}
      </div>
      <Switch id={id} checked={checked} onCheckedChange={onChange} disabled={disabled} />
    </div>
  );
}

export function TextAreaField({
  label,
  value,
  onChange,
  error,
  description,
  rows = 4,
  mono,
  placeholder,
  className,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  error?: string;
  description?: React.ReactNode;
  rows?: number;
  mono?: boolean;
  placeholder?: string;
  className?: string;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <Field data-invalid={!!error} className={className}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Textarea
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={rows}
        placeholder={placeholder}
        disabled={disabled}
        aria-invalid={!!error}
        className={cn(mono && "font-mono text-xs")}
        spellCheck={false}
      />
      {description && !error && <FieldDescription>{description}</FieldDescription>}
      {error && <FieldError role="alert">{error}</FieldError>}
    </Field>
  );
}

/** Returns an error message when `text` is not a valid JSON object (empty is allowed). */
export function jsonObjectError(text: string): string | undefined {
  if (!text.trim()) return undefined;
  try {
    const v = JSON.parse(text);
    if (!v || typeof v !== "object" || Array.isArray(v)) return "Must be a JSON object, e.g. { \"key\": \"value\" }";
    return undefined;
  } catch (e) {
    return `Invalid JSON: ${e instanceof Error ? e.message : "parse error"}`;
  }
}

/** Monospace JSON object editor with live validation. */
export function JsonField({
  label,
  value,
  onChange,
  description,
  error,
  rows = 5,
  className,
  placeholder = "{}",
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  description?: React.ReactNode;
  error?: string;
  rows?: number;
  className?: string;
  placeholder?: string;
}) {
  const live = jsonObjectError(value);
  return (
    <TextAreaField
      label={label}
      value={value}
      onChange={onChange}
      rows={rows}
      mono
      placeholder={placeholder}
      description={description}
      error={error ?? live}
      className={className}
    />
  );
}

/** Number-ish input (keeps string state so blanks stay blank). */
export function NumberField({
  label,
  value,
  onChange,
  error,
  description,
  placeholder,
  step = "any",
  min,
  suffix,
  className,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  error?: string;
  description?: React.ReactNode;
  placeholder?: string;
  step?: string;
  min?: number;
  suffix?: string;
  className?: string;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <Field data-invalid={!!error} className={className}>
      <FieldLabel htmlFor={id}>
        {label}
        {suffix && <span className="ml-1 font-normal text-muted-foreground">{suffix}</span>}
      </FieldLabel>
      <Input
        id={id}
        type="number"
        inputMode="decimal"
        step={step}
        min={min}
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={!!error}
        className="tabular-nums"
      />
      {description && !error && <FieldDescription>{description}</FieldDescription>}
      {error && <FieldError role="alert">{error}</FieldError>}
    </Field>
  );
}

/** Searchable multi-select in a popover; selected values shown as removable chips. */
export function MultiSelectField({
  label,
  values,
  onChange,
  options,
  description,
  placeholder = "Select...",
  allowCustom,
  error,
  className,
}: {
  label: string;
  values: string[];
  onChange: (v: string[]) => void;
  options: Option[];
  description?: React.ReactNode;
  placeholder?: string;
  /** Lets the admin type values that aren't in `options`. */
  allowCustom?: boolean;
  error?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const labelOf = useMemo(() => new Map(options.map((o) => [o.value, o.label])), [options]);
  const toggle = (v: string) => onChange(values.includes(v) ? values.filter((x) => x !== v) : [...values, v]);
  const canAdd = allowCustom && query.trim() && !options.some((o) => o.value === query.trim()) && !values.includes(query.trim());

  return (
    <Field data-invalid={!!error} className={className}>
      <FieldLabel>{label}</FieldLabel>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button type="button" variant="outline" role="combobox" aria-expanded={open} className="h-auto min-h-8 w-full justify-between px-2 py-1 font-normal">
            <span className="flex flex-wrap gap-1">
              {values.length === 0 && <span className="text-muted-foreground">{placeholder}</span>}
              {values.map((v) => (
                <Badge key={v} variant="secondary" className="gap-1 font-mono text-[11px]">
                  {labelOf.get(v) ?? v}
                  <span
                    role="button"
                    tabIndex={0}
                    aria-label={`Remove ${v}`}
                    className="cursor-pointer opacity-60 hover:opacity-100"
                    onClick={(e) => {
                      e.stopPropagation();
                      toggle(v);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.stopPropagation();
                        toggle(v);
                      }
                    }}
                  >
                    <X className="size-3" />
                  </span>
                </Badge>
              ))}
            </span>
            <ChevronsUpDown className="size-4 shrink-0 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-[var(--radix-popover-trigger-width)] min-w-64 p-0" align="start">
          <Command>
            <CommandInput placeholder="Search..." value={query} onValueChange={setQuery} />
            <CommandList>
              <CommandEmpty>{allowCustom ? "Type and press add" : "Nothing found"}</CommandEmpty>
              <CommandGroup>
                {canAdd && (
                  <CommandItem
                    value={`__add__${query}`}
                    onSelect={() => {
                      toggle(query.trim());
                      setQuery("");
                    }}
                  >
                    Add &ldquo;{query.trim()}&rdquo;
                  </CommandItem>
                )}
                {options.map((o) => (
                  <CommandItem key={o.value} value={`${o.label} ${o.value}`} onSelect={() => toggle(o.value)}>
                    <Check className={cn("size-4", values.includes(o.value) ? "opacity-100" : "opacity-0")} />
                    <span className="truncate">{o.label}</span>
                    {o.hint && <span className="ml-auto text-xs text-muted-foreground">{o.hint}</span>}
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      {description && !error && <FieldDescription>{description}</FieldDescription>}
      {error && <FieldError role="alert">{error}</FieldError>}
    </Field>
  );
}

/** Free-form tag input: type a value, press Enter or comma. */
export function TagsField({
  label,
  values,
  onChange,
  description,
  placeholder = "Add and press Enter",
  className,
}: {
  label: string;
  values: string[];
  onChange: (v: string[]) => void;
  description?: React.ReactNode;
  placeholder?: string;
  className?: string;
}) {
  const [text, setText] = useState("");
  const id = useId();
  const commit = () => {
    const parts = text.split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
    if (parts.length) onChange([...new Set([...values, ...parts])]);
    setText("");
  };
  return (
    <Field className={className}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <div className="flex min-h-8 flex-wrap items-center gap-1 rounded-lg border border-input px-2 py-1 dark:bg-input/30">
        {values.map((v) => (
          <Badge key={v} variant="secondary" className="gap-1 font-mono text-[11px]">
            {v}
            <button type="button" aria-label={`Remove ${v}`} className="opacity-60 hover:opacity-100" onClick={() => onChange(values.filter((x) => x !== v))}>
              <X className="size-3" />
            </button>
          </Badge>
        ))}
        <input
          id={id}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === ",") {
              e.preventDefault();
              commit();
            } else if (e.key === "Backspace" && !text && values.length) {
              onChange(values.slice(0, -1));
            }
          }}
          onBlur={commit}
          placeholder={values.length ? "" : placeholder}
          className="min-w-24 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
        />
      </div>
      {description && <FieldDescription>{description}</FieldDescription>}
    </Field>
  );
}

/** Checkbox row (label right of the box). */
export function CheckField({ label, checked, onChange, description }: { label: string; checked: boolean; onChange: (v: boolean) => void; description?: React.ReactNode }) {
  const id = useId();
  return (
    <div className="flex items-start gap-2">
      <Checkbox id={id} checked={checked} onCheckedChange={(v) => onChange(v === true)} className="mt-0.5" />
      <div className="space-y-0.5">
        <label htmlFor={id} className="text-sm font-medium leading-none">
          {label}
        </label>
        {description && <p className="text-xs text-muted-foreground">{description}</p>}
      </div>
    </div>
  );
}
