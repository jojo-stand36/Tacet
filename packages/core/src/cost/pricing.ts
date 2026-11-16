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
   * no known price, rather than the promotion's, unless `later` says what follows (#363).
   */
  until?: string;
  /**
   * What applies from a later UTC day on, oldest first (#363): another price, or another model's
   * price (`billedAs`, for a model the vendor bills as another). See {@link priceOn}.
   */
  later?: readonly LaterPrice[];
}

/** A price that takes over from `from` (a UTC day, `YYYY-MM-DD`) on. */
export type LaterPrice =
  | { from: string; price: Omit<ModelPrice, 'later'> }
  | { from: string; billedAs: string };

/** Model id → price. */
export type PricingTable = Readonly<Record<string, ModelPrice>>;

/** When {@link BUILTIN_PRICES} was last checked against the vendors' own pricing pages. */
export const BUILTIN_PRICES_CHECKED = '2026-11-16';

/**
 * API list prices (capability matrix, "Model API prices (#35)"): Anthropic's, read from
 * https://platform.claude.com/docs/en/about-claude/pricing, OpenAI's, read from
 * https://developers.openai.com/api/docs/pricing.md, and Google's (the Gemini models Gemini CLI
 * 0.67.0 names that the page lists, #357), read from https://aistudio.google.com/docs/pricing.md,
 * all on 2026-11-16. A model not here has no known cost and is never guessed.
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
  // Google, read from https://aistudio.google.com/docs/pricing.md on 2026-11-16 (#357): the
  // paid tier's standard rates, text input. Audio input costs more on some models and is not
  // told apart. "prompts <= 200k tokens" is read as 200,000.
  // "$0.75 through December 31, 2026. $1.50 starting January 1, 2027." (output $3.75, then $7.50).
  'gemini-3.8-flash': {
    inputPerMTok: 0.75,
    outputPerMTok: 3.75,
    until: '2026-12-31',
    later: [{ from: '2027-01-01', price: { inputPerMTok: 1.5, outputPerMTok: 7.5 } }],
  },
  'gemini-3.5-flash-lite': { inputPerMTok: 0.3, outputPerMTok: 2.5 },
  'gemini-3.1-flash-lite': { inputPerMTok: 0.25, outputPerMTok: 1.5 },
  // The page prices both ids in one section.
  'gemini-3.1-pro-preview': gemini(2, 12, 4, 18),
  'gemini-3.1-pro-preview-customtools': gemini(2, 12, 4, 18),
  'gemini-3-flash-preview': { inputPerMTok: 0.5, outputPerMTok: 3 },
  // Deprecated: "Effective December 1, 2026, all API requests to `gemini-2.5-pro` will
  // automatically route to Gemini 3.8 Flash (`gemini-3.8-flash`) and be billed at Gemini 3.8
  // Flash rates." This price holds through November 30.
  'gemini-2.5-pro': {
    ...gemini(1.25, 10, 2.5, 15),
    until: '2026-11-30',
    later: [{ from: '2026-12-01', billedAs: 'gemini-3.8-flash' }],
  },
};

/** A Gemini price with its tier for prompts above 200k (read as 200,000) tokens. */
function gemini(input: number, output: number, longInput: number, longOutput: number): ModelPrice {
  return {
    inputPerMTok: input,
    outputPerMTok: output,
    longContext: { aboveInputTokens: 200_000, inputPerMTok: longInput, outputPerMTok: longOutput },
  };
}

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
 * The price of `model` in force on `day` (a UTC day, `YYYY-MM-DD`), or undefined when none is
 * known (#363). The latest `later` entry from on or before `day` wins: its price, or the price of
 * the model it is billed as on that day. With none, the entry's own price holds, through `until`
 * when it has one. A model billed as another is followed a few steps at most, so a loop in the
 * table prices nothing rather than hang.
 */
export function priceOn(
  model: string | undefined,
  day: string,
  table: PricingTable,
  depth = 0,
): Omit<ModelPrice, 'later' | 'until'> | undefined {
  const price = priceFor(model, table);
  if (!price || depth > 4) return undefined;
  const step = [...(price.later ?? [])].reverse().find((l) => l.from <= day);
  if (step) {
    return 'billedAs' in step ? priceOn(step.billedAs, day, table, depth + 1) : step.price;
  }
  if (price.until !== undefined && day > price.until) return undefined;
  const { later: _later, until: _until, ...own } = price;
  return own;
}

/**
 * The cost in USD of one usage event's tokens at `price`. Every input token is charged at the
 * input rate: usage events do not split out cache reads (0.025x to 0.1x of it) or writes (1.25x to
 * 2x), so for a cache-heavy agent loop this can be several times the bill, and a call that writes
 * much cache is undercounted (#355). The long-context rate applies when the event's input is above
 * the tier's threshold: per request where the adapter reports per call, per turn where it reports
 * a turn's total (so a tier may apply to a turn of small requests).
 */
export function costOf(
  price: Omit<ModelPrice, 'later' | 'until'>,
  inputTokens: number,
  outputTokens: number,
): number {
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
