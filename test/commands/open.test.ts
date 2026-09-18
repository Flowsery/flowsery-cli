import { describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';

vi.mock('../../src/core/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/index.js')>();
  return { ...actual, openUrl: () => false, getGlobalOptions: () => ({ input: false }) };
});

const { registerOpenCommand } = await import('../../src/commands/open.js');
const { PRODUCT, initOutput } = await import('../../src/core/index.js');

const TARGETS: [string, string][] = [
  ['dashboard', '/dashboard'],
  ['sites', '/all-websites'],
  ['issues', '/issues'],
  ['users', '/users'],
  ['rules', '/rules'],
  ['add', '/add-website'],
  ['tokens', '/api-tokens'],
  ['billing', '/billing'],
  ['settings', '/settings/general'],
  ['workspaces', '/workspaces'],
];

const ALIASES: [string, string][] = [
  ['home', '/dashboard'],
  ['realtime', '/dashboard'],
  ['websites', '/all-websites'],
  ['visitors', '/users'],
];

function opened(what: string): string {
  let out = '';
  const write = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    out += String(chunk);
    return true;
  });
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  registerOpenCommand(program);
  initOutput({ isTTY: true, env: {}, command: 'open' });
  program.parse(['open', what], { from: 'user' });
  write.mockRestore();
  return out.trim();
}

describe('open targets', () => {
  it('points at https://flowsery.com', () => {
    expect(PRODUCT.appUrl).toBe('https://flowsery.com');
    expect(PRODUCT.tokensUrl).toBe('https://flowsery.com/api-tokens');
  });

  it.each(TARGETS)('%s resolves to %s', (what, path) => {
    expect(opened(what)).toBe(`${PRODUCT.appUrl}${path}`);
  });

  it.each(ALIASES)('alias %s resolves to %s', (what, path) => {
    expect(opened(what)).toBe(`${PRODUCT.appUrl}${path}`);
  });

  it('refuses a target that does not exist', () => {
    expect(() => opened('nonsense')).toThrow();
  });
});
