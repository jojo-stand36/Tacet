/**
 * Model list prices for the cost ledger (#35), used when an adapter reports tokens but no cost.
 * Prices are US dollars per million tokens, standard (not batch or fast) rates.
 */
export interface ModelPrice {
  /** Every input token, cache reads and writes included (see `costOf`). */
  inputPerMTok: number;
  outputPerMTok: number;
  /** A higher rate for a request whose prompt is longer than `aboveInputTokens`. */
  longContext?: { aboveInputTokens: number; inputPerMTok: number; outputPerMTok: number };
}

/** Model id → price. */
export type PricingTable = Readonly<Record<string, ModelPrice>>;

/** When {@link BUILTIN_PRICES} was last checked against the vendors' own pricing pages. */
export const BUILTIN_PRICES_CHECKED = '2026-11-16';

/**
 * Anthropic API list prices, read from https://platform.claude.com/docs/en/about-claude/pricing
 * on 2026-11-16 (capability matrix, "Model API prices (#35)"). OpenAI and Google prices are not
 * here: their pricing pages could not be read, so usage on those models has no known cost and is
 * never guessed.
 */
export const BUILTIN_PRICES: PricingTable = {
  'claude-fable-5-2': { inputPerMTok: 8, outputPerMTok: 40 },
  'claude-fable-5-1': { inputPerMTok: 10, outputPerMTok: 50 },
  'claude-fable-5': { inputPerMTok: 10, outputPerMTok: 50 },
  'claude-opus-5-5': { inputPerMTok: 4, outputPerMTok: 20 },
  'claude-opus-5': { inputPerMTok: 5, outputPerMTok: 25 },
  'claude-opus-4-8': { inputPerMTok: 5, outputPerMTok: 25 },
  'claude-opus-4-7': { inputPerMTok: 5, outputPerMTok: 25 },
  'claude-opus-4-6': { inputPerMTok: 5, outputPerMTok: 25 },
  'claude-opus-4-5-20251101': { inputPerMTok: 5, outputPerMTok: 25 },
  'claude-sonnet-5-5': { inputPerMTok: 2, outputPerMTok: 10 },
  'claude-sonnet-5': { inputPerMTok: 2, outputPerMTok: 10 },
  'claude-sonnet-4-6': { inputPerMTok: 3, outputPerMTok: 15 },
  'claude-sonnet-4-5-20250929': { inputPerMTok: 3, outputPerMTok: 15 },
  'claude-haiku-5-5': {
    inputPerMTok: 0.1,
    outputPerMTok: 0.5,
    longContext: { aboveInputTokens: 100_000, inputPerMTok: 0.5, outputPerMTok: 2.5 },
  },
  'claude-haiku-4-5-20251001': { inputPerMTok: 1, outputPerMTok: 5 },
};

/** A dated snapshot suffix (`-20251101`), which an undated alias drops. */
const DATED = /-\d{8}$/;

/**
 * The price for `model`, or undefined when it has none. Matches the id exactly, then without a
 * context-size suffix such as `[1m]` (Claude bills the 1M window at standard rates), then a dated
 * snapshot or its undated alias against the other form. Nothing looser: a model the table does not
 * name has no known cost, rather than a neighbour's.
 */
export function priceFor(model: string | undefined, table: PricingTable): ModelPrice | undefined {
  if (!model) return undefined;
  const id = model
    .trim()
    .toLowerCase()
    .replace(/\[[^\]]*\]$/, '');
  if (Object.hasOwn(table, id)) return table[id];
  const undated = id.replace(DATED, '');
  for (const [key, price] of Object.entries(table)) {
    if (key.replace(DATED, '') === undated) return price;
  }
  return undefined;
}

/**
 * The cost in USD of one call's tokens at `price`. Every input token is charged at the input
 * rate: usage events do not split out cache reads (cheaper) or writes (dearer, up to 2x), so this
 * can be lower than the bill for a call that writes much cache, and higher for one that reads it.
 * The long-context rate applies when the call's input is above the tier's threshold.
 */
export function costOf(price: ModelPrice, inputTokens: number, outputTokens: number): number {
  const rate =
    price.longContext && inputTokens > price.longContext.aboveInputTokens
      ? price.longContext
      : price;
  return (inputTokens * rate.inputPerMTok + outputTokens * rate.outputPerMTok) / 1_000_000;
}
