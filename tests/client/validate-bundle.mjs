#!/usr/bin/env node
/**
 * tests/client/validate-bundle.mjs —— lib/client.js 静态契约校验（无需启动 DSH）。
 *
 * 依据：DSH 0.2.1-rc.3 客户端模块协议
 *   - `window.__ModuleLoader__.load({ id: '<package name>', factory: (require) => exports })`
 *   - bundle 是 classic script（不能含顶层 ESM import/export）
 *   - 只允许 require 平台 seed（react / react/jsx-runtime / react-dom / react-dom/client）
 *   - 不加载任何外部资源（无 http(s) URL、无 CDN/字体/telemetry）
 *
 * 用法：node tests/client/validate-bundle.mjs [--bundle lib/client.js] [--json]
 * 退出码：0 全部通过；1 有失败项。
 */
import { readFileSync, existsSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

const args = process.argv.slice(2);
function argValue(name, fallback) {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback;
}
const bundlePath = resolve(repoRoot, argValue('--bundle', 'lib/client.js'));
const asJson = args.includes('--json');

const packageJson = JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8'));
const packageName = packageJson.name;

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
}

function main() {
  if (!existsSync(bundlePath)) {
    check('bundle 存在', false, `${bundlePath} 不存在（先运行 node build.mjs client）`);
    return finish();
  }
  const bytes = statSync(bundlePath).size;
  const text = readFileSync(bundlePath, 'utf8');

  check('bundle 存在', true, `${bundlePath} (${bytes} bytes)`);
  check('非空（> 10KB）', bytes > 10 * 1024, `${bytes} bytes`);

  // 1) ModuleLoader 包装
  const wrapperIndex = text.indexOf('window.__ModuleLoader__.load(');
  check('包含 window.__ModuleLoader__.load(...) 注册', wrapperIndex >= 0, wrapperIndex >= 0 ? `offset ${wrapperIndex}` : '未找到');
  const head = text.slice(0, Math.max(0, wrapperIndex));
  check(
    'wrapper 之前没有可执行代码（允许注释/空白）',
    /^[\s;]*$/.test(head.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')),
    `前导内容 ${head.length} 字符`,
  );
  check(`注册 id 等于包名（${packageName}）`, text.includes(`id: ${JSON.stringify(packageName)}`) || text.includes(`id: "${packageName}"`), '');
  check('包含 factory(require) 工厂', /factory:\s*\(?require\)?\s*=>/.test(text), '');
  check('factory 返回 module.exports', /return module\.exports;/.test(text), '');

  // 2) classic script：不允许顶层 ESM 语法
  const lines = text.split('\n');
  const topLevelEsm = lines.filter((line) => /^\s*(import|export)\s/.test(line));
  check('无顶层 ESM import/export 语句', topLevelEsm.length === 0, topLevelEsm.slice(0, 3).join(' | '));

  // 3) require 只允许平台 seed
  const allowedRequires = new Set([
    'react',
    'react/jsx-runtime',
    'react-dom',
    'react-dom/client',
    'react-dom/server',
    '@deepseek-ai/cordis',
  ]);
  const requires = [...new Set([...text.matchAll(/require\((["'])([^"']+)\1\)/g)].map((match) => match[2]))];
  const illegalRequires = requires.filter((spec) => !allowedRequires.has(spec));
  check('require 仅使用平台 seed', illegalRequires.length === 0, `requires=[${requires.join(', ')}]${illegalRequires.length > 0 ? ` 非法=[${illegalRequires.join(', ')}]` : ''}`);
  // 不允许打包进 Harness Client 包（官方 practice：不要 require 这些包）
  const harnessRequires = requires.filter((spec) => spec.startsWith('@deepseek-ai/') && spec !== '@deepseek-ai/cordis');
  check('未 require Harness Client 包', harnessRequires.length === 0, harnessRequires.join(', '));

  // 4) 无外部资源
  const urls = [...new Set([...text.matchAll(/https?:\/\/[^\s"'`)]+/g)].map((match) => match[0]))];
  check('无外部 http(s) 资源', urls.length === 0, urls.slice(0, 5).join(' , '));
  check('不引用 CDN / 字体 / telemetry 关键字', !/\b(cdn\.|fonts\.googleapis|telemetry|sentry|umami|gtag\()/i.test(text), '');
  check('无 </script> 注入风险', !text.includes('</script'));

  // 5) v5 写操作范围：仅允许 5 个 POST 写接口（人格 CRUD/激活 + 会话配置）；其余仍只读
  const allowedPostPaths = ['/personas', '/personas/update', '/personas/delete', '/personas/activate', '/session-config', '/transfer', '/rebuild'];
  const presentPostPaths = allowedPostPaths.filter((item) => text.includes(item));
  check(
    '客户端包含 v6 七个 POST 写入路径（personas CRUD/activate + session-config + transfer + rebuild）',
    presentPostPaths.length === allowedPostPaths.length,
    `已包含=[${presentPostPaths.join(', ')}]`,
  );
  const postMethodCount = [...text.matchAll(/method:\s*["']POST["']/g)].length;
  check('POST 集中在一个写请求函数（method: "POST" 仅 1 处）', postMethodCount === 1, `实际 ${postMethodCount} 处`);
  check('客户端无 PUT/PATCH/DELETE 请求', !/method:\s*["'](PUT|PATCH|DELETE)["']/.test(text), '');
check('写操作读取错误包络但不展示 stack（postRequest 复用 unwrap）', text.includes('postRequest') || text.includes('apiPost'), '');
  check('不使用 localStorage/sessionStorage 保存档案', !/\b(localStorage|sessionStorage)\s*\./.test(text), '');

  // 6) 只读面板固定文案（隐私警示）——esbuild 会把中文转成 \uXXXX 转义，先解码再查
  const decoded = text.replace(/\\u([0-9a-fA-F]{4})/g, (_match, hex) => String.fromCharCode(Number.parseInt(hex, 16)));
  check('包含隐私警示文案', decoded.includes('原始档案可能包含隐私/密钥，请勿截图外传'), '');
    check('导入页自动列出归档并自动生成新 id（无需手填路径）', decoded.includes('选择整库归档') && decoded.includes('选择会话归档') && decoded.includes('刷新列表') && decoded.includes('自动生成'), '');
check('包含导入导出页（只追加、默认整库/单会话可选、重构原始数据库、sessionId 提示）', decoded.includes('导入导出') && decoded.includes('只追加') && decoded.includes('整库（默认）') && decoded.includes('单会话（可选）') && decoded.includes('重构原始数据库') && decoded.includes('会话内 → 记忆库') && decoded.includes('仅数据库') && decoded.includes('仅原始记忆数据'), '');
  check('记忆库面板包含人工删除提示（愿记忆长存）', decoded.includes('愿记忆长存') && decoded.includes('人工删除') && decoded.includes('数据保留与删除'), '');
  check('包含 READ-ONLY 标记', text.includes('READ-ONLY'), '');

  // 7) 面板注册：sidebar.panellist + main
  check('注册 sidebar.panellist 侧栏入口', text.includes('sidebar.panellist'), '');
  check('注册 main 中央面板', /name:\s*["']main["']/.test(text), '');
  check('面板 id = life-memory', text.includes('life-memory'), '');
  check(
    '七个只读页签文案齐全（含记忆分层、人格）',
    ['概览', '记忆分层', '原始记忆', '层统计', '搜索', '人格', '健康/完整性'].every((label) => decoded.includes(label)),
    '',
  );

  // 8) 记忆双模型（第 13 条只读端点 = /retention；三层记忆类型命名保留）
  check('客户端包含 /retention 只读端点', text.includes('/retention'), '');
  check(
    '记忆分层文案齐全（短期/中期/长期）',
    ['短期', '中期', '长期'].every((label) => decoded.includes(label)),
    '',
  );
  check(
    '三层记忆类型命名齐全（工作/情景/语义记忆层）',
    ['工作记忆层', '情景记忆层', '语义记忆层'].every((label) => decoded.includes(label)),
    '',
  );
  check('包含记忆分层页签数据源（/memories?retention=）', text.includes('retention'), '');
// 9) 人格（第 14 条只读端点 = /personas；人格页签/卡片/记忆作用域文案）
check('客户端包含 /personas 只读端点（人格）', text.includes('/personas'), '');
check('人格页签/文案齐全（人格/当前人格/人格定义）', decoded.includes('人格') && decoded.includes('当前人格'), '');
check('客户端包含人格记忆作用域说明（persona）', text.includes('persona'), '');
  check(
    '双模型说明文案存在（记忆分层 × 记忆类型）',
    decoded.includes('记忆分层') && decoded.includes('记忆类型') && decoded.includes('共同描述每条记忆'),
    '',
  );
  // 负向断言：旧“激活层”口径已作废，bundle 中不得出现这些字样/标识
  const forbiddenWords = ['激活层', '活跃层', '半活跃', '潜在记忆层', '/activation', 'semi_active', 'activationTier'];
  const foundForbidden = forbiddenWords.filter((word) => text.includes(word) || decoded.includes(word));
  check('禁止出现旧“激活层”口径字样（激活层/活跃层/半活跃/潜在/activation）', foundForbidden.length === 0, foundForbidden.join(', '));

  // 9) v3（docs/24）：显式检索（原始层+向量模型，永不遗忘）× 隐式上下文（三层记忆，可遗忘）
  check('客户端包含 /search 检索端点', text.includes('/search'), '');
  check('客户端包含检索模式 explicit/implicit', text.includes('explicit') && text.includes('implicit'), '');
  check(
    '显式/隐式检索文案齐全（显式检索 / 隐式 / 原始层 / 向量模型 / 永不遗忘）',
    ['显式检索', '隐式', '原始层', '向量模型', '永不遗忘'].every((label) => decoded.includes(label)),
    '',
  );
  check('包含“隐式上下文 = 三层记忆（可遗忘）”文案', decoded.includes('可遗忘'), '');
  check('状态卡数据源包含 vectors/forgetting（原始层向量索引 + 遗忘统计）', text.includes('vectors') && text.includes('forgetting'), '');
  check(
    '包含原始层向量索引/遗忘统计文案',
    ['原始层向量索引', '短期到期删除', '中期到期归档', '长期永久'].every((label) => decoded.includes(label)),
    '',
  );
  check('遗忘策略说明（原始层与向量模型不遗忘）', decoded.includes('原始层与向量模型不遗忘'), '');
  check('检索/状态相关请求仍为 GET（无写操作）', !/search[^;]{0,200}method:\s*["'](POST|PUT|PATCH|DELETE)/i.test(text), '');

  // 10) v5（人格可编辑 + 会话级开关 + 记忆库）
  check(
    '会话内「记忆库」页签已注册（conversation.view，feature-detect）',
    text.includes('conversation.view') && text.includes('life-memory-session'),
    '',
  );
  check(
    '新建会话 hero 选项已注册（conversation.hero.options，feature-detect）',
    text.includes('conversation.hero.options') && text.includes('life-memory-hero'),
    '',
  );
  check('客户端包含 /vaults 记忆库总览端点', text.includes('/vaults'), '');
  check('客户端包含 /session-config 会话配置端点（GET/POST）', text.includes('/session-config'), '');
  check(
    '新会话默认「记忆/人格」控件文案存在（新会话默认 + 共享库/跟随激活人格）',
    decoded.includes('新会话默认') && (decoded.includes('共享库') || decoded.includes('跟随激活人格')),
    '',
  );
  check(
    '新会话默认保存用法存在（POST /session-config body defaults:true + sessionDefaults GET）',
    /defaults:\s*(true|!0)/.test(text) && text.includes('saveSessionDefaults') && text.includes('sessionDefaults'),
    '',
  );
  check(
    '人格 CRUD 文案齐全（新建人格 / 编辑 / 删除 / 使用此人格 / 取消人格）',
    ['新建人格', '编辑', '删除', '使用此人格', '取消人格'].every((label) => decoded.includes(label)),
    '',
  );
  check(
    '会话级开关文案齐全（本会话使用记忆 / 本会话使用人格 / 会话级开关）',
    ['本会话使用记忆', '本会话使用人格', '会话级开关'].every((label) => decoded.includes(label)),
    '',
  );
  check(
    '记忆库文案齐全（记忆库 / 当前记忆库 / 切换独立记忆库）',
    ['记忆库', '当前记忆库', '独立记忆库'].every((label) => decoded.includes(label)),
    '',
  );
  check('Host 未就绪提示文案存在（写操作失败不崩溃）', decoded.includes('Host 写接口尚未就绪') || decoded.includes('Host 未就绪'), '');
  check('人格页头徽标说明可编辑（READ-ONLY · 人格页可编辑）', decoded.includes('人格页可编辑'), '');

  return finish();
}

function finish() {
  const failed = results.filter((item) => !item.ok);
  if (asJson) {
    console.log(JSON.stringify({ bundle: bundlePath, packageName, pass: failed.length === 0, checks: results }, null, 2));
  } else {
    console.log(`\n=== lib/client.js 静态契约校验（${packageName}） ===`);
    for (const item of results) {
      console.log(`${item.ok ? 'PASS' : 'FAIL'}  ${item.name}${item.detail ? `  — ${item.detail}` : ''}`);
    }
    console.log(`\n${results.length - failed.length}/${results.length} 通过${failed.length > 0 ? '，存在失败项' : ''}`);
  }
  process.exitCode = failed.length === 0 ? 0 : 1;
}

main();
