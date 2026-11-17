/**
 * Model list prices for the cost ledger (#35), used when an adapter reports tokens but no cost.
 * Prices are US dollars per million tokens, standard (not batch or fast) rates.
 */
export interface ModelPrice {
  /** Input tokens not read from or written to a cache (see `costOf`). */
  inputPerMTok: number;
  outputPerMTok: number;
  /** Input tokens read from a cache (#355). Absent: charged at the input rate. */
  cacheReadPerMTok?: number;
  /**
   * Input tokens written to a cache, at the shortest cache lifetime the vendor prices (#355):
   * Anthropic's 5 minutes, OpenAI's 30 minutes. A write that lives longer costs more and is
   * undercounted. Absent: charged at the input rate.
   */
  cacheWritePerMTok?: number;
  /** A higher rate for a request whose prompt is longer than `aboveInputTokens`. */
  longContext?: {
    aboveInputTokens: number;
    inputPerMTok: number;
    outputPerMTok: number;
    /** Absent: the tier's input rate. */
    cacheReadPerMTok?: number;
    /** Absent: the tier's input rate. */
    cacheWritePerMTok?: number;
  };
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

/**
 * A price that takes over from `from` (a UTC day, `YYYY-MM-DD`) on. It holds until a later step
 * replaces it: a later price that ends is written as another step.
 */
export type LaterPrice = { from: string; price: DayPrice } | { from: string; billedAs: string };

/** A price as it holds on one day: no end date, nothing after it. */
export type DayPrice = Omit<ModelPrice, 'later' | 'until'>;

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
  // Anthropic: input, output, cache read, cache write (5 minutes).
  'claude-fable-5-2': claude(8, 40, 0.2, 10),
  'claude-fable-5-1': claude(10, 50, 0.25, 12.5),
  'claude-fable-5': claude(10, 50, 1, 12.5),
  'claude-opus-5-5': claude(4, 20, 0.2, 5),
  'claude-opus-5': claude(5, 25, 0.5, 6.25),
  'claude-opus-4-8': claude(5, 25, 0.5, 6.25),
  'claude-opus-4-7': claude(5, 25, 0.5, 6.25),
  'claude-opus-4-6': claude(5, 25, 0.5, 6.25),
  'claude-opus-4-5-20251101': claude(5, 25, 0.5, 6.25),
  'claude-sonnet-5-5': claude(2, 10, 0.1, 2.5),
  'claude-sonnet-5': claude(2, 10, 0.2, 2.5),
  'claude-sonnet-4-6': claude(3, 15, 0.3, 3.75),
  'claude-sonnet-4-5-20250929': claude(3, 15, 0.3, 3.75),
  'claude-haiku-5-5': {
    ...claude(0.1, 0.5, 0.01, 0.125),
    longContext: {
      aboveInputTokens: 100_000,
      inputPerMTok: 0.5,
      outputPerMTok: 2.5,
      cacheReadPerMTok: 0.05,
      cacheWritePerMTok: 0.625,
    },
  },
  'claude-haiku-4-5-20251001': claude(1, 5, 0.1, 1.25),
  // OpenAI, read from https://developers.openai.com/api/docs/pricing.md on 2026-11-16, standard
  // tier ("Short context: ≤272K input tokens. Long context: >272K input tokens."): input, output,
  // cached input, cache write (30 minutes), then the long tier's input, output and cached input.
  'gpt-6-astra': openai(10, 50, 1, 12.5, 20, 75, 2),
  'gpt-6.1-sol': openai(2, 10, 0.1, 2.5, 4, 15, 0.2),
  'gpt-6.1-terra': openai(1, 5, 0.05, 1.25, 2, 7.5, 0.1),
  'gpt-6-luna': openai(0.1, 0.5, 0.01, 0.125, 0.2, 0.75, 0.02),
  'gpt-6-sol': openai(2, 10, 0.2, 2.5, 4, 15, 0.4),
  // "GPT-5.6 Sol's promotional pricing is available until November 30, 2026."
  'gpt-5.6-sol': { ...openai(4, 20, 0.4, 5, 8, 30, 0.8), until: '2026-11-30' },
  'gpt-5.6-terra': openai(2, 12, 0.2, 2.5, 4, 18, 0.4),
  'gpt-5.6-luna': openai(0.2, 1.2, 0.02, 0.25, 0.4, 1.8, 0.04),
  // The page lists no cache write rate for GPT-5.5: writes are charged at the input rate.
  'gpt-5.5': openai(5, 30, 0.5, undefined, 10, 45, 1),
  // Google, read from https://aistudio.google.com/docs/pricing.md on 2026-11-16 (#357): the
  // paid tier's standard rates, text input. Audio input costs more on some models and is not
  // told apart. "prompts <= 200k tokens" is read as 200,000. Cache reads at the "context caching"
  // rate; the page prices no cache write per token (storage is per hour), so writes are charged
  // at the input rate.
  // "$0.75 through December 31, 2026. $1.50 starting January 1, 2027." (output $3.75, then $7.50;
  // caching $0.075, then $0.15).
  'gemini-3.8-flash': {
    inputPerMTok: 0.75,
    outputPerMTok: 3.75,
    cacheReadPerMTok: 0.075,
    until: '2026-12-31',
    later: [
      {
        from: '2027-01-01',
        price: { inputPerMTok: 1.5, outputPerMTok: 7.5, cacheReadPerMTok: 0.15 },
      },
    ],
  },
  'gemini-3.5-flash-lite': { inputPerMTok: 0.3, outputPerMTok: 2.5, cacheReadPerMTok: 0.03 },
  'gemini-3.1-flash-lite': { inputPerMTok: 0.25, outputPerMTok: 1.5, cacheReadPerMTok: 0.025 },
  // The page prices both ids in one section.
  'gemini-3.1-pro-preview': gemini(2, 12, 0.2, 4, 18, 0.4),
  'gemini-3.1-pro-preview-customtools': gemini(2, 12, 0.2, 4, 18, 0.4),
  'gemini-3-flash-preview': { inputPerMTok: 0.5, outputPerMTok: 3, cacheReadPerMTok: 0.05 },
  // Deprecated: "Effective December 1, 2026, all API requests to `gemini-2.5-pro` will
  // automatically route to Gemini 3.8 Flash (`gemini-3.8-flash`) and be billed at Gemini 3.8
  // Flash rates." This price holds through November 30, then it is billed as 3.8 Flash.
  'gemini-2.5-pro': {
    ...gemini(1.25, 10, 0.125, 2.5, 15, 0.25),
    until: '2026-11-30',
    later: [{ from: '2026-12-01', billedAs: 'gemini-3.8-flash' }],
  },
};

/** An Anthropic price: no long-context tier unless given. */
function claude(input: number, output: number, read: number, write: number): ModelPrice {
  return {
    inputPerMTok: input,
    outputPerMTok: output,
    cacheReadPerMTok: read,
    cacheWritePerMTok: write,
  };
}

/** A Gemini price with its tier for prompts above 200k (read as 200,000) tokens. */
function gemini(
  input: number,
  output: number,
  read: number,
  longInput: number,
  longOutput: number,
  longRead: number,
): ModelPrice {
  return {
    inputPerMTok: input,
    outputPerMTok: output,
    cacheReadPerMTok: read,
    longContext: {
      aboveInputTokens: 200_000,
      inputPerMTok: longInput,
      outputPerMTok: longOutput,
      cacheReadPerMTok: longRead,
    },
  };
}

/** An OpenAI price with its long-context tier above 272K (read as 272,000) input tokens. */
function openai(
  input: number,
  output: number,
  read: number,
  write: number | undefined,
  longInput: number,
  longOutput: number,
  longRead: number,
): ModelPrice {
  return {
    inputPerMTok: input,
    outputPerMTok: output,
    cacheReadPerMTok: read,
    ...(write !== undefined ? { cacheWritePerMTok: write } : {}),
    longContext: {
      aboveInputTokens: 272_000,
      inputPerMTok: longInput,
      outputPerMTok: longOutput,
      cacheReadPerMTok: longRead,
    },
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
): DayPrice | undefined {
  return resolve(model, day, table, 0);
}

function resolve(
  model: string | undefined,
  day: string,
  table: PricingTable,
  depth: number,
): DayPrice | undefined {
  const price = priceFor(model, table);
  if (!price || depth > 4) return undefined;
  // The step with the latest `from` on or before `day`, whatever order the list is in.
  let step: LaterPrice | undefined;
  for (const l of price.later ?? []) {
    if (l.from <= day && (step === undefined || l.from >= step.from)) step = l;
  }
  if (step) {
    if ('billedAs' in step) return resolve(step.billedAs, day, table, depth + 1);
    const { inputPerMTok, outputPerMTok, cacheReadPerMTok, cacheWritePerMTok, longContext } =
      step.price;
    return {
      inputPerMTok,
      outputPerMTok,
      ...(cacheReadPerMTok !== undefined ? { cacheReadPerMTok } : {}),
      ...(cacheWritePerMTok !== undefined ? { cacheWritePerMTok } : {}),
      ...(longContext ? { longContext } : {}),
    };
  }
  if (price.until !== undefined && day > price.until) return undefined;
  const { later: _later, until: _until, ...own } = price;
  return own;
}

/**
 * The cost in USD of one usage event's tokens at `price`. `inputTokens` counts every input token;
 * of those, `cache.read` were read from a cache and `cache.write` written to one (#355), each at
 * its own rate where the price has one, else at the input rate. Without the split, every input
 * token is charged at the input rate: several times the bill for a cache-heavy agent loop.
 * The long-context rate applies when the event's input (cache included) is above the tier's
 * threshold: per request where the adapter reports per call, per turn where it reports a turn's
 * total (so a tier may apply to a turn of small requests).
 */
export function costOf(
  price: DayPrice,
  inputTokens: number,
  outputTokens: number,
  cache: { read?: number | undefined; write?: number | undefined } = {},
): number {
  const rate =
    price.longContext && inputTokens > price.longContext.aboveInputTokens
      ? price.longContext
      : price;
  // Never more cache than input: a malformed report is charged as plain input.
  const read = Math.min(Math.max(cache.read ?? 0, 0), inputTokens);
  const write = Math.min(Math.max(cache.write ?? 0, 0), inputTokens - read);
  const plain = inputTokens - read - write;
  return (
    (plain * rate.inputPerMTok +
      read * (rate.cacheReadPerMTok ?? rate.inputPerMTok) +
      write * (rate.cacheWritePerMTok ?? rate.inputPerMTok) +
      outputTokens * rate.outputPerMTok) /
    1_000_000
  );
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
