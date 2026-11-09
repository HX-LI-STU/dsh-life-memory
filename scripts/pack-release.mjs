#!/usr/bin/env node
/**
 * Build the release tarball with a concise, usage-only README.
 *
 * The repository README is the full project documentation; the npm/DSH package
 * README should stay a short install/usage guide. This script stages the package
 * files, swaps in docs/PACKAGE_README*.md, and runs `npm pack`.
 *
 * Usage: npm run build && npm run pack:release
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const root = process.cwd();
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
if (!existsSync(join(root, 'lib', 'index.js')) || !existsSync(join(root, 'lib', 'client.js'))) {
  throw new Error('lib/ is missing: run "npm run build" before packing the release');
}
const staged = join(root, '.tmp-release-pack');
rmSync(staged, { recursive: true, force: true });
mkdirSync(staged, { recursive: true });
try {
  for (const file of ['package.json', 'cordis.patch.yml', 'LICENSE', 'NOTICE', 'CHANGELOG.md']) {
    cpSync(join(root, file), join(staged, file));
  }
  cpSync(join(root, 'lib'), join(staged, 'lib'), { recursive: true });
  cpSync(join(root, 'docs', 'PACKAGE_README.md'), join(staged, 'README.md'));
  cpSync(join(root, 'docs', 'PACKAGE_README.zh-CN.md'), join(staged, 'README.zh-CN.md'));

  const tgz = join(root, `${pkg.name}-${pkg.version}.tgz`);
  rmSync(tgz, { force: true });
  const npmCli = process.env.npm_execpath;
  if (!npmCli) throw new Error('run this with "npm run pack:release"');
  execFileSync(process.execPath, [npmCli, 'pack', '--pack-destination', root], {
    cwd: staged,
    stdio: 'inherit',
  });
  if (!existsSync(tgz)) throw new Error(`package archive was not created: ${tgz}`);
  console.log(`[pack:release] created ${tgz}`);
} finally {
  rmSync(staged, { recursive: true, force: true });
}
