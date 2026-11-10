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
    const { env, dropped } = workerEnv(USER_ENV, {
      names: ['ANTHROPIC_API_KEY'],
      prefixes: ['ANTHROPIC_'],
    });
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

  it('passes vendor prefixes without secret-looking names, credential prefixes whole', () => {
    const user = {
      VENDOR_API_KEY: 'k',
      VENDOR_MODEL: 'm',
      VENDOR_OAUTH_TOKEN: 'login',
      AWS_REGION: 'eu-west-1',
      AWS_SECRET_ACCESS_KEY: 'aws-x',
    };
    expect(
      workerEnv(user, { names: ['VENDOR_API_KEY'], prefixes: ['VENDOR_', 'AWS_'] }).env,
    ).toEqual({
      VENDOR_API_KEY: 'k',
      VENDOR_MODEL: 'm',
      AWS_REGION: 'eu-west-1',
    });
    expect(workerEnv(user, { credentialPrefixes: ['AWS_'] }).env).toEqual({
      AWS_REGION: 'eu-west-1',
      AWS_SECRET_ACCESS_KEY: 'aws-x',
    });
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
    const { UNSET: _, ...set } = USER_ENV;
    expect(env).toEqual(set);
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
    'AWS_SECRET_ACCESS_KEY',
    'AWS_SESSION_TOKEN',
    'MYSQL_PWD',
    'GPG_PASSPHRASE',
    'CI_JOB_JWT',
    'AZURE_DEVOPS_EXT_PAT',
    'SLACK_WEBHOOK_URL',
    'GOOGLE_APPLICATION_CREDENTIALS',
    'SENTRY_DSN',
    'HF_TOKEN',
    'SLACK_WEBHOOK_SECRET',
    'MYAPIKEY',
  ])('%s looks secret', (n) => expect(looksSecret(n)).toBe(true));
  it.each([
    'PATH',
    'JAVA_HOME',
    'MYAPP_HOME',
    'KEYBOARD_LAYOUT',
    'NODE_ENV',
    'CI',
    'AWS_REGION',
    'AWS_PROFILE',
    'TOKENIZERS_PARALLELISM',
    'MAX_THINKING_TOKENS',
    'MYAPP_SESSION_TIMEOUT',
  ])('%s does not', (n) => expect(looksSecret(n)).toBe(false));
  it('only an exact name passes a secret', () => {
    expect(passesSecret('NPM_TOKEN')).toBe(true);
    expect(passesSecret('NPM_*')).toBe(false);
  });
});
