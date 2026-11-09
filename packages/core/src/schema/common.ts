import { z } from 'zod';

/** ULID: 26 Crockford base32 characters. Used for event and record ids (ADR-003 §1). */
export const Ulid = z
  .string()
  .regex(/^[0-9A-HJKMNP-TV-Z]{26}$/, 'expected a ULID (26 Crockford base32 characters)');

/** Opaque, non-empty identifier minted by another system (A2A task ids, vendor session ids). */
export const Id = z.string().min(1).max(256);

/** RFC 3339 timestamp in UTC with a trailing `Z`. */
export const Timestamp = z.iso.datetime();

/** How urgent an escalation is (ADR-003 §6, MCP `escalate`). */
export const Urgency = z.enum(['low', 'normal', 'high', 'blocking']);
export type Urgency = z.infer<typeof Urgency>;

/** Escalation strictness dial (ARCHITECTURE.md §2.2). */
export const Autonomy = z.enum(['low', 'medium', 'high']);
export type Autonomy = z.infer<typeof Autonomy>;

/** Money in US dollars, never negative. */
export const Usd = z.number().nonnegative();

/** Token counts are non-negative integers. */
export const TokenCount = z.number().int().nonnegative();
