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
  /**
   * The last UTC day (`YYYY-MM-DD`) this price holds, for a promotional price: usage after it has
   * no known price, rather than the promotion's.
   */
  until?: string;
}

/** Model id → price. */
export type PricingTable = Readonly<Record<string, ModelPrice>>;

/** When {@link BUILTIN_PRICES} was last checked against the vendors' own pricing pages. */
export const BUILTIN_PRICES_CHECKED = '2026-11-16';

/**
 * API list prices (capability matrix, "Model API prices (#35)"): Anthropic's, read from
 * https://platform.claude.com/docs/en/about-claude/pricing, and OpenAI's, read from
 * https://developers.openai.com/api/docs/pricing.md, both on 2026-11-16. Google's are not here:
 * their pricing page could not be read, so usage on Gemini models has no known cost and is never
 * guessed.
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
  // OpenAI, read from https://developers.openai.com/api/docs/pricing.md on 2026-11-16, standard
  // tier ("Short context: ≤272K input tokens. Long context: >272K input tokens.").
  'gpt-6-astra': openai(10, 50, 20, 75),
  'gpt-6.1-sol': openai(2, 10, 4, 15),
  'gpt-6.1-terra': openai(1, 5, 2, 7.5),
  'gpt-6-luna': openai(0.1, 0.5, 0.2, 0.75),
  'gpt-6-sol': openai(2, 10, 4, 15),
  // "GPT-5.6 Sol's promotional pricing is available until November 30, 2026."
  'gpt-5.6-sol': { ...openai(4, 20, 8, 30), until: '2026-11-30' },
  'gpt-5.6-terra': openai(2, 12, 4, 18),
  'gpt-5.6-luna': openai(0.2, 1.2, 0.4, 1.8),
  'gpt-5.5': openai(5, 30, 10, 45),
};

/** An OpenAI price with its long-context tier above 272K (read as 272,000) input tokens. */
function openai(input: number, output: number, longInput: number, longOutput: number): ModelPrice {
  return {
    inputPerMTok: input,
    outputPerMTok: output,
    longContext: { aboveInputTokens: 272_000, inputPerMTok: longInput, outputPerMTok: longOutput },
  };
}

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
 * The cost in USD of one usage event's tokens at `price`. Every input token is charged at the
 * input rate: usage events do not split out cache reads (0.025x to 0.1x of it) or writes (1.25x to
 * 2x), so for a cache-heavy agent loop this can be several times the bill, and a call that writes
 * much cache is undercounted (#355). The long-context rate applies when the event's input is above
 * the tier's threshold: per request where the adapter reports per call, per turn where it reports
 * a turn's total (so a tier may apply to a turn of small requests).
 */
export function costOf(price: ModelPrice, inputTokens: number, outputTokens: number): number {
  const rate =
    price.longContext && inputTokens > price.longContext.aboveInputTokens
      ? price.longContext
      : price;
  return (inputTokens * rate.inputPerMTok + outputTokens * rate.outputPerMTok) / 1_000_000;
}

/** The `pricing:` config (#35): user-layer prices, keyed by model id. */
export type PricingConfig = Readonly<
  Record<
    string,
    {
      input_per_mtok: number;
      output_per_mtok: number;
      long_context?:
        | {
            above_input_tokens: number;
            input_per_mtok: number;
            output_per_mtok: number;
          }
        | undefined;
    }
  >
>;

/** The built-in prices with the user's `pricing:` laid over them (model ids lowercased). */
export function pricingTable(config: PricingConfig | undefined): PricingTable {
  const table: Record<string, ModelPrice> = { ...BUILTIN_PRICES };
  for (const [model, p] of Object.entries(config ?? {})) {
    table[model.trim().toLowerCase()] = {
      inputPerMTok: p.input_per_mtok,
      outputPerMTok: p.output_per_mtok,
      ...(p.long_context
        ? {
            longContext: {
              aboveInputTokens: p.long_context.above_input_tokens,
              inputPerMTok: p.long_context.input_per_mtok,
              outputPerMTok: p.long_context.output_per_mtok,
            },
          }
        : {}),
    };
  }
  return table;
}
