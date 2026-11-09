import { z } from 'zod';

/**
 * An enum that tolerates values added in later protocol versions (owner decision 2026-11-09,
 * ADR-003 §2): an unknown string is read as `fallback` instead of failing the whole message; a
 * missing or non-string value is still rejected. The
 * fallback is also published in JSON Schema as `x-tacet-fallback`, so non-TypeScript receivers
 * can apply the same rule. Do not use this for discriminators such as `AgentEvent.t`.
 */
export function openEnum<const T extends readonly [string, ...string[]]>(
  values: T,
  fallback: T[number],
) {
  // z.string() first: a missing or non-string value is still an error. Only unknown strings
  // fall back. The `enum` meta keeps the known values visible in the generated JSON Schema.
  return z
    .string()
    .pipe(z.enum(values).catch(fallback))
    .meta({ enum: [...values], 'x-tacet-fallback': fallback });
}

/** ULID: 26 Crockford base32 characters, first one 0-7 (48-bit time). ADR-003 §1. */
export const Ulid = z
  .string()
  .regex(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/, 'expected a ULID (26 Crockford base32 characters)');

/** Opaque, non-empty identifier minted by another system (A2A task ids, vendor session ids). */
export const Id = z.string().min(1).max(256);

/** RFC 3339 timestamp in UTC with a trailing `Z`. */
export const Timestamp = z.iso.datetime();

/** How urgent an escalation is (ADR-003 §6, MCP `escalate`). */
/** Unknown values fall back to `normal`. */
export const Urgency = openEnum(['low', 'normal', 'high', 'blocking'], 'normal');
export type Urgency = z.infer<typeof Urgency>;

/** Escalation strictness dial (ARCHITECTURE.md §2.2). */
/** Unknown values fall back to `low` (escalate more, not less). */
export const Autonomy = openEnum(['low', 'medium', 'high'], 'low');
export type Autonomy = z.infer<typeof Autonomy>;

/** Money in US dollars, never negative. */
export const Usd = z.number().nonnegative();

/** Token counts are non-negative integers. */
export const TokenCount = z.number().int().nonnegative();
