import { describe, expect, it } from 'vitest';
import { mergeConfig } from './merge.js';
import { evaluatePolicies, globRegExp, mayContain } from './policy.js';
import type { PolicyRule } from './schema.js';

describe('globRegExp', () => {
  const m = (glob: string, path: string) => globRegExp(glob).test(path);
  it('keeps * and ? within a segment', () => {
    expect(m('src/*.ts', 'src/a.ts')).toBe(true);
    expect(m('src/*.ts', 'src/x/a.ts')).toBe(false);
    expect(m('*.env', '.env')).toBe(true);
    expect(m('*.env', 'config/.env')).toBe(false);
    expect(m('a?c', 'abc')).toBe(true);
    expect(m('a?c', 'a/c')).toBe(false);
  });
  it('lets ** span any number of segments, none included', () => {
    expect(m('secrets/**', 'secrets')).toBe(true);
    expect(m('secrets/**', 'secrets/a/b.pem')).toBe(true);
    expect(m('secrets/**', 'secretsx/a')).toBe(false);
    expect(m('**/*.pem', 'a.pem')).toBe(true);
    expect(m('**/*.pem', 'a/b/c.pem')).toBe(true);
    expect(m('a/**/b', 'a/b')).toBe(true);
    expect(m('a/**/b', 'a/x/y/b')).toBe(true);
    expect(m('a/**/b', 'a/xb')).toBe(false);
    expect(m('**', 'anything/at/all')).toBe(true);
  });
  it('collapses runs of **', () => {
    expect(m('**/**', 'a')).toBe(true);
    expect(m('**/**', 'a/b')).toBe(true);
    expect(m('**/**/*.pem', 'a.pem')).toBe(true);
    expect(m('**/**/*.pem', 'x/a.pem')).toBe(true);
    expect(m('a/**/**/b', 'a/b')).toBe(true);
  });
  it('takes regular-expression characters literally', () => {
    expect(m('a.b', 'axb')).toBe(false);
    expect(m('(x)+', '(x)+')).toBe(true);
  });
});

describe('mayContain', () => {
  it('tells whether a search from a directory could reach a match', () => {
    expect(mayContain('', 'secrets/**')).toBe(true);
    expect(mayContain('secrets', 'secrets/**')).toBe(true);
    expect(mayContain('secrets/sub', 'secrets/**')).toBe(true);
    expect(mayContain('src', 'src/*/key.pem')).toBe(true);
    expect(mayContain('src/a', 'src/*/key.pem')).toBe(true);
    expect(mayContain('src/a/key.pem', 'src/*/key.pem')).toBe(true);
    expect(mayContain('lib', 'src/**')).toBe(false);
    expect(mayContain('src/a/b', 'src/*/key.pem')).toBe(false);
    expect(mayContain('docs', '**/*.pem')).toBe(true);
    // Below a literal file path nothing more can match.
    expect(mayContain('secrets/k/x', 'secrets/k')).toBe(false);
  });
});

describe('evaluatePolicies', () => {
  const r = (rule: Partial<PolicyRule>): PolicyRule => ({ decision: 'deny', ...rule });
  it('is order-free: deny beats ask beats allow', () => {
    const rules = [
      r({ tool: 'Read', decision: 'allow' }),
      r({ tool: 'Read', decision: 'ask' }),
      r({ tool: 'Read', decision: 'deny', reason: 'no' }),
    ];
    for (const order of [rules, [...rules].reverse()]) {
      expect(evaluatePolicies(order, { tool: 'Read', paths: ['a'] })).toMatchObject({
        decision: 'deny',
        rule: { reason: 'no' },
      });
    }
    expect(evaluatePolicies(rules.slice(0, 2), { tool: 'Read' })?.decision).toBe('ask');
    expect(evaluatePolicies(rules.slice(0, 1), { tool: 'Read' })).toMatchObject({
      decision: 'allow',
      index: 0,
    });
    expect(evaluatePolicies(rules, { tool: 'Write' })).toBeUndefined();
  });

  it('matches a tool exactly, by prefix, or any tool', () => {
    expect(evaluatePolicies([r({ tool: 'Read' })], { tool: 'ReadX' })).toBeUndefined();
    expect(
      evaluatePolicies([r({ tool: 'mcp__github__*' })], { tool: 'mcp__github__pr' }),
    ).toBeDefined();
    expect(evaluatePolicies([r({})], { tool: 'Anything' })).toBeDefined();
  });

  it('applies a match only to tools with a defined input, on any of their paths', () => {
    const rules = [r({ match: 'secrets/**' })];
    expect(evaluatePolicies(rules, { tool: 'Read', paths: ['src/a', 'secrets/k'] })).toBeDefined();
    expect(evaluatePolicies(rules, { tool: 'Read', paths: ['src/a'] })).toBeUndefined();
    expect(evaluatePolicies(rules, { tool: 'Bash' })).toBeUndefined();
    // Compared as a case-insensitive file system would, and without `./`.
    expect(evaluatePolicies(rules, { tool: 'Read', paths: ['./Secrets/K'] })).toBeDefined();
  });

  it('covers a search whose roots could reach a match', () => {
    const rules = [r({ match: 'secrets/**' })];
    expect(evaluatePolicies(rules, { tool: 'Grep', paths: [], roots: [''] })).toBeDefined();
    expect(evaluatePolicies(rules, { tool: 'Grep', paths: [], roots: ['src'] })).toBeUndefined();
    expect(evaluatePolicies(rules, { tool: 'Glob', paths: [], roots: ['secrets'] })).toBeDefined();
  });

  it("never applies to Tacet's own MCP tools", () => {
    expect(evaluatePolicies([r({})], { tool: 'mcp__tacet__escalate' })).toBeUndefined();
  });
});

describe('policies across config layers', () => {
  it('refuses allow in the committed repo layer, and unions the rest', () => {
    const merged = mergeConfig([
      { name: 'user', origin: 'user', data: { policies: [{ tool: 'Read', decision: 'allow' }] } },
      {
        name: 'repo',
        origin: '.tacet/tacet.yaml',
        data: {
          policies: [
            { tool: 'Write', match: 'secrets/**', decision: 'deny' },
            { tool: 'Bash', decision: 'allow' },
          ],
        },
      },
      { name: 'local', origin: 'local', data: { policies: [{ tool: 'Grep', decision: 'allow' }] } },
    ]);
    expect(merged.errors).toEqual([
      'policies: the repo layer (.tacet/tacet.yaml) may not allow; put allow rules in your user or local config',
    ]);
    expect(merged.config.policies).toHaveLength(4);
  });
});
