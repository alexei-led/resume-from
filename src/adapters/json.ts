/**
 * The shape readers every adapter applies to untrusted JSON. One implementation, so a value
 * one adapter accepts is a value every adapter accepts.
 */

/** A non-empty string, or null. */
export function asString(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/** A plain object record, or null for null, arrays and primitives. */
export function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/** True for a plain object record: the type-guard form of asRecord. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return asRecord(value) !== null;
}

/** An array, or null. */
export function asArray(value: unknown): unknown[] | null {
  return Array.isArray(value) ? value : null;
}
