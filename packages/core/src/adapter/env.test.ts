import { describe, expect, it } from 'vitest';
import { looksSecret, passesSecret, workerEnv, workerEnvPolicy } from './env.js';

const USER_ENV = {
  PATH: '/usr/bin',
  HOME: '/home/u',
  LANG: 'en_US.UTF-8',
  LC_ALL: 'C',
  HTTPS_PROXY: 'http://proxy:3128',
  JAVA_HOME: '/opt/jdk',
  ANTHROPIC_API_KEY: 'sk-ant-x',
  OPENAI_API_KEY: 'sk-x',
  GITHUB_TOKEN: 'ghp_x',
  AWS_SECRET_ACCESS_KEY: 'aws-x',
  DATABASE_URL: 'postgres://u:p@h/db',
  MYAPP_HOME: '/opt/myapp',
  MYAPP_TOKEN: 'myapp-x',
  NPM_TOKEN: 'npm-x',
  UNSET: undefined,
};

describe('workerEnv', () => {
  it('keeps the base set, toolchains and the adapter own variables; drops the rest', () => {
    const { env, dropped } = workerEnv(USER_ENV, { prefixes: ['ANTHROPIC_'] });
    expect(env).toEqual({
      PATH: '/usr/bin',
      HOME: '/home/u',
      LANG: 'en_US.UTF-8',
      LC_ALL: 'C',
      HTTPS_PROXY: 'http://proxy:3128',
      JAVA_HOME: '/opt/jdk',
      ANTHROPIC_API_KEY: 'sk-ant-x',
    });
    // Names only, never values, sorted.
    expect(dropped).toEqual([
      'AWS_SECRET_ACCESS_KEY',
      'DATABASE_URL',
      'GITHUB_TOKEN',
      'MYAPP_HOME',
      'MYAPP_TOKEN',
      'NPM_TOKEN',
      'OPENAI_API_KEY',
    ]);
  });

  it('passes exact names as given, and prefixes without secret-looking names', () => {
    const { env } = workerEnv(USER_ENV, {}, { pass: ['NPM_TOKEN', 'MYAPP_*', 'AWS_*'] });
    expect(env.NPM_TOKEN).toBe('npm-x');
    expect(env.MYAPP_HOME).toBe('/opt/myapp');
    expect(env.MYAPP_TOKEN).toBeUndefined();
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
  });

  it('inherits everything only when asked to', () => {
    const { env, dropped } = workerEnv(USER_ENV, {}, { inherit: 'all' });
    expect(Object.keys(env)).toHaveLength(Object.keys(USER_ENV).length - 1);
    expect(dropped).toEqual([]);
  });

  it('reads the policy from the effective config', () => {
    expect(workerEnvPolicy({})).toEqual({ pass: [] });
    expect(workerEnvPolicy({ workers: { env: { pass: ['A_*'] } } })).toEqual({ pass: ['A_*'] });
  });
});

describe('looksSecret', () => {
  it.each([
    'GITHUB_TOKEN',
    'NPM_TOKEN',
    'OPENAI_API_KEY',
    'STRIPE_SECRET',
    'DB_PASSWORD',
    'AWS_REGION',
    'GOOGLE_APPLICATION_CREDENTIALS',
    'SENTRY_DSN',
    'HF_TOKEN',
    'SLACK_WEBHOOK_SECRET',
    'MYAPIKEY',
  ])('%s looks secret', (n) => expect(looksSecret(n)).toBe(true));
  it.each(['PATH', 'JAVA_HOME', 'MYAPP_HOME', 'KEYBOARD_LAYOUT', 'NODE_ENV', 'CI'])(
    '%s does not',
    (n) => expect(looksSecret(n)).toBe(false),
  );
  it('only an exact name passes a secret', () => {
    expect(passesSecret('NPM_TOKEN')).toBe(true);
    expect(passesSecret('NPM_*')).toBe(false);
  });
});
