#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hanxustu (dsh-life-memory)
/**
 * dsh-life-memory build script.
 *
 * - Host half:  src/index.ts  -> lib/index.js  (ESM, platform=node)
 * - Client half: client/src/index.tsx -> lib/client.js (browser, DSH ModuleLoader wrapper)
 *
 * Everything the DSH host injects at runtime is externalized:
 *   @deepseek-ai/* (cordis + dsh SDK), react, react-dom.
 * Node builtins are externalized too (they are never bundled).
 *
 * 客户端产物格式（DSH 0.2.1-rc.3，官方模板 cordis-plugin-development/templates/decoration/client.js）：
 *   window.__ModuleLoader__.load({ id: '<package name>', factory: (require) => { ...; return module.exports } })
 * 即：一个 classic script，执行时只“注册工厂”，工厂在首次 import 时才 materialize。
 * 因此客户端先用 esbuild 产出 cjs（react 等保持 require 外部依赖），再用 banner/footer
 * 包出上述形状；id 必须等于 package.json 的 name。
 *
 * 兼容性：esbuild 的 JS API 会 spawn 一个常驻 service 进程（stdio 管道）。
 * 某些沙箱环境禁止命名管道 → `spawn EPERM`。此时自动退化为直接调用 esbuild CLI
 * （stdio 继承，无需管道），产物一致；两条路径使用同一份配置。
 */
import { existsSync } from 'node:fs';
import { rm, mkdir, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(root, 'lib');

const externals = [
  'node:*',
  '@deepseek-ai/*',
  '@dsh-ops/*',
  'react',
  'react-dom',
  'react-dom/client',
  'react/jsx-runtime',
  'zod',
];

const common = {
  bundle: true,
  format: 'esm',
  sourcemap: false,
  logLevel: 'info',
  external: externals,
  define: {
    'process.env.NODE_ENV': '"production"',
  },
};

/** 解析 esbuild 平台二进制（JS API 不可用时的兜底 CLI） */
function esbuildCliPath() {
  const platformPkg = `@esbuild/${process.platform}-${process.arch}`;
  const candidates = [
    resolve(root, 'node_modules', ...platformPkg.split('/'), process.platform === 'win32' ? 'esbuild.exe' : 'esbuild'),
    resolve(root, 'node_modules', 'esbuild', 'bin', 'esbuild'),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

/** 用 esbuild CLI（stdio 继承）执行一次构建；返回是否成功 */
function buildViaCli(args) {
  const bin = esbuildCliPath();
  if (bin === null) {
    console.error('[build] esbuild JS API 不可用（spawn EPERM），且找不到 esbuild CLI 兜底');
    return false;
  }
  console.log(`[build] esbuild JS API 不可用，改用 CLI 兜底：${bin}`);
  const result = spawnSync(bin, args, { stdio: 'inherit' });
  if (result.error) {
    console.error(`[build] esbuild CLI 执行失败：${result.error.message}`);
    return false;
  }
  return result.status === 0;
}

/** CLI 兜底参数（与上面的 JS API 配置保持一致） */
function cliArgsFor({ entry, outfile, platform, target, format, extra = [] }) {
  const args = [
    entry,
    '--bundle',
    `--format=${format}`,
    `--platform=${platform}`,
    `--target=${target}`,
    `--outfile=${outfile}`,
    '--log-level=info',
  ];
  for (const item of externals) args.push(`--external:${item}`);
  for (const item of extra) args.push(item);
  return args;
}

async function buildOrCli(esbuildOptions, cliArgs) {
  try {
    await build(esbuildOptions);
    return true;
  } catch (error) {
    if (error && error.code === 'EPERM') {
      return buildViaCli(cliArgs);
    }
    throw error;
  }
}

async function main() {
  const only = process.argv.slice(2);
  const pkgMeta = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
  const legalBanner =
    `/*! ${pkgMeta.name} v${pkgMeta.version} | (c) 2026 hanxustu | SPDX-License-Identifier: MIT */`;
  // 全量构建才清空 lib/；只构建单个目标时不要删掉另一个目标的产物（并行开发时互相破坏）
  if (only.length === 0) {
    await rm(outDir, { recursive: true, force: true });
  }
  await mkdir(outDir, { recursive: true });

  if (only.length === 0 || only.includes('host')) {
    const entry = resolve(root, 'src/index.ts');
    const outfile = resolve(outDir, 'index.js');
    const ok = await buildOrCli(
      { ...common, entryPoints: [entry], outfile, platform: 'node', target: 'node22', banner: { js: legalBanner } },
      cliArgsFor({ entry, outfile, platform: 'node', target: 'node22', format: 'esm', extra: [`--banner:js=${legalBanner}`] }),
    );
    if (!ok) process.exitCode = 1;
  }

  const clientEntry = resolve(root, 'client/src/index.tsx');
  const clientEntryTs = resolve(root, 'client/src/index.ts');
  const entry = existsSync(clientEntry) ? clientEntry : existsSync(clientEntryTs) ? clientEntryTs : null;
  if ((only.length === 0 || only.includes('client')) && entry) {
    const pkg = pkgMeta;
    const pkgName = typeof pkg.name === 'string' ? pkg.name : 'dsh-life-memory';
    const wrapperBanner = [
      legalBanner,
      'window.__ModuleLoader__.load({',
      `  id: ${JSON.stringify(pkgName)},`,
      '  factory: (require) => {',
      '    var module = { exports: {} };',
      '    var exports = module.exports;',
      "    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });",
      '',
    ].join('\n');
    const wrapperFooter = ['', '    return module.exports;', '  },', '});', ''].join('\n');
    const outfile = resolve(outDir, 'client.js');
    const ok = await buildOrCli(
      {
        ...common,
        entryPoints: [entry],
        outfile,
        platform: 'browser',
        target: 'es2022',
        format: 'cjs',
        jsx: 'automatic',
        loader: { '.css': 'empty' },
        banner: { js: wrapperBanner },
        footer: { js: wrapperFooter },
      },
      cliArgsFor({
        entry,
        outfile,
        platform: 'browser',
        target: 'es2022',
        format: 'cjs',
        extra: ['--jsx=automatic', '--loader:.css=empty', `--banner:js=${wrapperBanner}`, `--footer:js=${wrapperFooter}`],
      }),
    );
    if (!ok) process.exitCode = 1;
  } else if (only.includes('client')) {
    console.log('[build] client entry not found, skipping client bundle');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
