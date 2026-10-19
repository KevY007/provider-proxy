"use client";

import { useId } from "react";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { InputGroup, InputGroupAddon, InputGroupInput, InputGroupText } from "@/components/ui/input-group";

export interface MoneyInputProps {
  label: string;
  value: string;
  onChange: (v: string) => void;
  error?: string;
  description?: React.ReactNode;
  placeholder?: string;
  disabled?: boolean;
  name?: string;
  onBlur?: () => void;
}

/** `$` prefixed decimal input with label, hint and inline error. */
export function MoneyInput({ label, value, onChange, error, description, placeholder, disabled, name, onBlur }: MoneyInputProps) {
  const id = useId();
  return (
    <Field data-invalid={!!error}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <InputGroup>
        <InputGroupAddon>
          <InputGroupText>$</InputGroupText>
        </InputGroupAddon>
        <InputGroupInput
          id={id}
          name={name}
          inputMode="decimal"
          autoComplete="off"
          value={value}
          placeholder={placeholder}
          disabled={disabled}
          aria-invalid={!!error}
          aria-describedby={error ? `${id}-err` : undefined}
          onChange={(e) => onChange(e.target.value.replace(/[^\d.]/g, ""))}
          onBlur={onBlur}
        />
        <InputGroupAddon align="inline-end">
          <InputGroupText>USD</InputGroupText>
        </InputGroupAddon>
      </InputGroup>
      {description && !error && <FieldDescription>{description}</FieldDescription>}
      {error && (
        <FieldError id={`${id}-err`} role="alert">
          {error}
        </FieldError>
      )}
    </Field>
  );
}
