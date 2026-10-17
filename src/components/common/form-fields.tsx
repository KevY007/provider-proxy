"use client";

import { useId, useState } from "react";
import { Eye, EyeOff, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

export interface TextFieldProps extends Omit<React.ComponentProps<"input">, "id"> {
  label: string;
  /** Inline error message (from `fieldErrors` returned by server actions). */
  error?: string;
  description?: React.ReactNode;
  /** Element rendered at the right of the label row (e.g. "Forgot password?" link). */
  labelAction?: React.ReactNode;
}

/** Label + input + description + inline error, wired for accessibility (aria-invalid / aria-describedby). */
export function TextField({ label, error, description, labelAction, className, ...props }: TextFieldProps) {
  const id = useId();
  const descId = `${id}-desc`;
  const errId = `${id}-err`;
  return (
    <Field data-invalid={!!error}>
      <div className="flex items-center justify-between gap-2">
        <FieldLabel htmlFor={id}>{label}</FieldLabel>
        {labelAction}
      </div>
      <Input
        id={id}
        aria-invalid={!!error}
        aria-describedby={cn(description && descId, error && errId) || undefined}
        className={className}
        {...props}
      />
      {description && !error && <FieldDescription id={descId}>{description}</FieldDescription>}
      {error && (
        <FieldError id={errId} role="alert">
          {error}
        </FieldError>
      )}
    </Field>
  );
}

/** TextField with a show/hide toggle. */
export function PasswordField({ label, error, description, labelAction, className, ...props }: TextFieldProps) {
  const id = useId();
  const errId = `${id}-err`;
  const [show, setShow] = useState(false);
  return (
    <Field data-invalid={!!error}>
      <div className="flex items-center justify-between gap-2">
        <FieldLabel htmlFor={id}>{label}</FieldLabel>
        {labelAction}
      </div>
      <div className="relative">
        <Input
          id={id}
          type={show ? "text" : "password"}
          aria-invalid={!!error}
          aria-describedby={error ? errId : undefined}
          className={cn("pr-10", className)}
          {...props}
        />
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="absolute right-0.5 top-1/2 size-8 -translate-y-1/2 text-muted-foreground"
          onClick={() => setShow((s) => !s)}
          aria-label={show ? "Hide password" : "Show password"}
          tabIndex={-1}
        >
          {show ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
        </Button>
      </div>
      {description && !error && <FieldDescription>{description}</FieldDescription>}
      {error && (
        <FieldError id={errId} role="alert">
          {error}
        </FieldError>
      )}
    </Field>
  );
}

/** Submit button with spinner while `pending`. */
export function SubmitButton({ pending, children, className, ...props }: { pending?: boolean } & React.ComponentProps<typeof Button>) {
  return (
    <Button type="submit" disabled={pending || props.disabled} className={className} {...props}>
      {pending && <Loader2 className="size-4 animate-spin" />}
      {children}
    </Button>
  );
}
