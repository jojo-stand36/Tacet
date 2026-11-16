import { describe, expect, it } from 'vitest';
import { BUILTIN_PRICES, priceFor, pricingTable } from '../cost/pricing.js';
import { mergeConfig } from './merge.js';

describe('pricing: config (#35, owner decision: user layer only)', () => {
  const prices = { 'my-model': { input_per_mtok: 1, output_per_mtok: 2 } };

  it('takes prices from the user layer', () => {
    const merged = mergeConfig([{ name: 'user', origin: 'user', data: { pricing: prices } }]);
    expect(merged.errors).toEqual([]);
    expect(merged.config.pricing).toEqual(prices);
  });

  it('refuses prices from the repo, local and task layers', () => {
    for (const name of ['repo', 'local', 'task'] as const) {
      const merged = mergeConfig([{ name, origin: `${name}.yaml`, data: { pricing: prices } }]);
      expect(merged.errors, name).toEqual([
        `pricing: the ${name} layer (${name}.yaml) may not set prices; put them in your user config (~/.tacet/config.yaml)`,
      ]);
    }
  });

  it('lays the user prices over the built-in ones, by lowercased id', () => {
    const table = pricingTable({
      'My-Model': {
        input_per_mtok: 1,
        output_per_mtok: 2,
        long_context: { above_input_tokens: 1000, input_per_mtok: 3, output_per_mtok: 4 },
      },
      'claude-sonnet-5-5': { input_per_mtok: 9, output_per_mtok: 9 },
    });
    expect(priceFor('my-model', table)).toEqual({
      inputPerMTok: 1,
      outputPerMTok: 2,
      longContext: { aboveInputTokens: 1000, inputPerMTok: 3, outputPerMTok: 4 },
    });
    expect(priceFor('claude-sonnet-5-5', table)?.inputPerMTok).toBe(9);
    expect(priceFor('claude-opus-5-5', table)).toEqual(BUILTIN_PRICES['claude-opus-5-5']);
    expect(pricingTable(undefined)).toEqual(BUILTIN_PRICES);
  });
});
