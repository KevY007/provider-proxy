/**
 * Friendly validation messages for the admin settings form (instead of raw zod text like
 * "Too small: expected number to be >=1"). Pure.
 */
export interface IssueLike {
  code: string;
  message?: string;
  minimum?: number | bigint;
  maximum?: number | bigint;
  origin?: string;
  expected?: string;
  received?: string;
  inclusive?: boolean;
}

export function friendlySettingIssue(label: string, issue: IssueLike | undefined): string {
  if (!issue) return "That value isn't valid.";
  const isText = issue.origin === "string";
  const min = issue.minimum !== undefined ? Number(issue.minimum) : undefined;
  const max = issue.maximum !== undefined ? Number(issue.maximum) : undefined;
  switch (issue.code) {
    case "too_small":
      if (isText) return min !== undefined && min <= 1 ? `${label} can't be empty.` : `${label} must be at least ${min} characters.`;
      return `${label} must be at least ${min !== undefined ? min.toLocaleString("en-US") : "higher"}.`;
    case "too_big":
      if (isText) return `${label} must be at most ${max} characters.`;
      return `${label} must be at most ${max !== undefined ? max.toLocaleString("en-US") : "lower"}.`;
    case "invalid_type":
      if (issue.expected === "int" || /\bint\b/.test(issue.message ?? "")) return `${label} must be a whole number (no decimals).`;
      if (issue.expected === "number") return `${label} must be a number.`;
      if (issue.expected === "string") return `${label} must be text.`;
      if (issue.expected === "boolean") return `${label} must be on or off.`;
      return `${label} has the wrong type of value.`;
    case "not_multiple_of":
      return `${label} must be a whole number (no decimals).`;
    default:
      return `${label} isn't a valid value.`;
  }
}
