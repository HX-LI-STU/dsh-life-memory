/**
 * 测试聚合器（不依赖 node --test 的子进程模式，避免沙箱下 spawn EPERM）。
 *
 * 用法（Node.js 22.19+ / 24+）：
 *   node tests/run.mjs                 # 运行 tests/core 下所有 *.test.ts
 *   node tests/run.mjs tests/core      # 运行指定目录
 *   node tests/run.mjs tests/core/vault.test.ts
 *
 * 原理：动态 import 每个测试文件；文件内 `test()` 注册的用例在当前进程内执行，
 * node:test 会在进程退出前汇总输出 TAP 报告，失败时以非 0 退出码结束。
 */
import { readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(import.meta.dirname, '..');
const targets = process.argv.slice(2);
const inputs = targets.length > 0 ? targets.map((t) => resolve(root, t)) : [join(root, 'tests', 'core')];

/** @param {string} p @returns {string[]} */
function collect(p) {
  const out = [];
  let stat;
  try {
    stat = statSync(p);
  } catch {
    return out;
  }
  if (stat.isDirectory()) {
    for (const entry of readdirSync(p).sort()) {
      if (entry === 'node_modules' || entry.startsWith('.')) continue;
      out.push(...collect(join(p, entry)));
    }
  } else if (/\.test\.(ts|mts|js|mjs)$/.test(p)) {
    out.push(p);
  }
  return out;
}

const files = inputs.flatMap(collect);
if (files.length === 0) {
  console.error(`[tests] no test files found in: ${inputs.join(', ')}`);
  process.exit(1);
}

console.log(`[tests] running ${files.length} file(s) in-process:`);
for (const file of files) console.log(`  - ${file.replace(root + '\\', '').replace(root + '/', '')}`);
let failed = false;
for (const file of files) {
  try {
    await import(pathToFileURL(file).href);
  } catch (err) {
    failed = true;
    console.error(`[tests] failed to import ${file}:`, err);
  }
}
if (failed) process.exitCode = 1;
