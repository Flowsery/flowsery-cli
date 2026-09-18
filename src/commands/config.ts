import type { Command } from 'commander';

import {
  PRODUCT,
  configKey,
  configPath,
  credentialsPath,
  dim,
  getConfigValue,
  hint,
  listConfigValues,
  notFoundError,
  print,
  printKeyValues,
  printResult,
  productConfigKeys,
  resolveProfileName,
  setConfigValue,
  success,
  unsetConfigValue,
} from '../core/index.js';

const keyNames = (): string => productConfigKeys().map((entry) => entry.key).join(', ');

const profileOf = (): string => resolveProfileName();

export function registerConfigCommands(program: Command): void {
  const config = program.command('config').description('read and write CLI preferences');

  config
    .command('list')
    .alias('ls')
    .description('show every key and its value')
    .action(() => {
      const profile = profileOf();
      const { entries } = listConfigValues(profile);

      printResult('config.list', { profile, entries });

      print(`  profile: ${profile}`);
      printKeyValues(
        entries.map(
          (entry) =>
            [
              entry.key,
              entry.value === undefined || entry.value === null
                ? dim('unset')
                : configKey(entry.key).format(entry.value),
            ] as [string, string],
        ),
      );
    });

  config
    .command('get')
    .argument('<key>', `one of ${keyNames()}`)
    .description('print one value')
    .action((key: string) => {
      const definition = configKey(key);
      const profile = profileOf();
      const value = getConfigValue(key, profile);

      if (value === undefined || value === null) {
        throw notFoundError(
          `"${key}" is not set for profile "${profile}".`,
          `${PRODUCT.binName} config set ${key} <value>`,
        );
      }

      printResult('config.get', { key, value });
      print(definition.format(value));
    });

  config
    .command('set')
    .argument('<key>', `one of ${keyNames()}`)
    .argument('<value>', 'new value')
    .description('write one value')
    .action((key: string, raw: string) => {
      const definition = configKey(key);
      const profile = profileOf();
      const value = setConfigValue(key, raw, profile);

      printResult('config.set', { key, value, scope: definition.scope, profile });
      success(`${key} = ${definition.format(value)}`);
    });

  config
    .command('unset')
    .argument('<key>', `one of ${keyNames()}`)
    .description('remove one value')
    .action((key: string) => {
      const profile = profileOf();
      const removed = unsetConfigValue(key, profile);

      printResult('config.unset', { key, removed, profile });
      if (removed) success(`${key} removed`);
      else hint(`${key} was not set, nothing changed.`);
    });

  config
    .command('path')
    .description('print the config and credentials file paths')
    .action(() => {
      const configFile = configPath();
      const credentialsFile = credentialsPath();

      printResult('config.path', { config: configFile, credentials: credentialsFile });
      printKeyValues([
        ['config', configFile],
        ['credentials', credentialsFile],
      ]);
    });
}
