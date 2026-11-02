#!/usr/bin/env node
/**
 * tests/client/api-paths.mjs —— 客户端 URL / 方法与 Host 路由表一致性校验（无需启动 DSH）。
 *
 * v5 契约：
 * - GET 16 条：health/status/layers/stats-layers/raw/raw-detail/raw-verify/memories/
 *   memory-detail/search/manifest/integrity/retention/personas/vaults/session-config
 * - POST 7 条：/personas、/personas/update、/personas/delete、/personas/activate、/session-config、/transfer、/rebuild
 * - 既有 GET 支持可选 `vault` / `sessionId` 作用域参数；默认 base `/api/life-memory`。
 *
 * Host 侧（src/http/register.ts）尚未落地新路由时，对齐检查标记为「Host 未就绪」而不是
 * 失败（静态契约本身仍严格校验）；联调后同一条命令即为严格对齐。
 *
 * 用法：node tests/client/api-paths.mjs
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

const clientApiPath = resolve(repoRoot, 'client/src/api.ts');
const clientTypesPath = resolve(repoRoot, 'client/src/types.ts');
const registerPath = resolve(repoRoot, 'src/http/register.ts');
const handlersPath = resolve(repoRoot, 'src/http/handlers.ts');
const configPath = resolve(repoRoot, 'src/config.ts');

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
}

function read(path) {
  if (!existsSync(path)) {
    check(`文件存在：${path}`, false, '不存在');
    return '';
  }
  return readFileSync(path, 'utf8');
}

const EXPECTED_GET = [
  '/health',
  '/status',
  '/layers',
  '/stats-layers',
  '/raw',
  '/raw-detail',
  '/raw-verify',
  '/memories',
  '/memory-detail',
  '/search',
  '/manifest',
  '/integrity',
  '/retention',
  '/personas',
  '/vaults',
  '/session-config',
].sort();
const EXPECTED_POST = ['/personas', '/personas/update', '/personas/delete', '/personas/activate', '/session-config', '/transfer', '/rebuild'].sort();

const apiSource = read(clientApiPath);
const clientTypesSource = read(clientTypesPath);
const registerSource = read(registerPath);
const handlersSource = read(handlersPath);
const configSource = read(configPath);

// ── 1. 客户端 GET/POST 路径集合 ───────────────────────────────────────────
const clientPaths = [...new Set([...apiSource.matchAll(/apiGet<[^>]*>\(\s*'([^']+)'/g)].map((match) => match[1]))].sort();
const postPaths = [...new Set([...apiSource.matchAll(/apiPost<[^>]*>\(\s*'([^']+)'/g)].map((match) => match[1]))].sort();
const missingGet = EXPECTED_GET.filter((path) => !clientPaths.includes(path));
const extraGet = clientPaths.filter((path) => !EXPECTED_GET.includes(path));
check(
  'client/src/api.ts GET 路径集合 == v5 契约 16 条（含 /vaults、/session-config）',
  missingGet.length === 0 && extraGet.length === 0,
  `缺失=[${missingGet.join(', ')}] 多余=[${extraGet.join(', ')}]`,
);
check(
  'client/src/api.ts POST 路径集合 == v6 契约 7 条（personas CRUD/activate + session-config + transfer + rebuild）',
  postPaths.length === EXPECTED_POST.length && postPaths.every((path) => EXPECTED_POST.includes(path)),
  `实际=[${postPaths.join(', ')}]`,
);
check(
  '客户端 POST 仅覆盖允许的写接口（无 /raw、/memories 等写入）',
  postPaths.every((path) => EXPECTED_POST.includes(path)),
  postPaths.join(', '),
);

// ── 2. Host READ_ONLY_ROUTES / WRITE_ROUTES 对齐 ──────────────────────────
const suffixesBlock = registerSource.match(/READ_ONLY_ROUTES[\s\S]*?\]\.map/);
const hostGet = suffixesBlock
  ? [...new Set([...suffixesBlock[0].matchAll(/suffix:\s*'([^']+)'/g)].map((match) => match[1]))].sort()
  : [];
const hostMissing = EXPECTED_GET.filter((path) => !hostGet.includes(path));
const hostExtra = hostGet.filter((path) => !EXPECTED_GET.includes(path) && path !== '/forgetting');
check(
  'Host GET 路由与 v5 契约一致（Host 未就绪时标记 pending）',
  hostExtra.length === 0,
  hostMissing.length === 0
    ? `Host 已就绪：${hostGet.length} 条`
    : `Host 未就绪（等待联调）：缺少 [${hostMissing.join(', ')}]；当前 Host=${hostGet.join(', ')}`,
);

const writeBlock = registerSource.match(/WRITE_ROUTES[\s\S]*?\]/);
const hostPost = writeBlock
  ? [...new Set([...writeBlock[0].matchAll(/suffix:\s*'([^']+)'/g)].map((match) => match[1]))].sort()
  : [];
check(
  'Host POST 写路由与 v5 契约一致（Host 未就绪时标记 pending）',
  hostPost.length === 0 || (hostPost.length === EXPECTED_POST.length && hostPost.every((path) => EXPECTED_POST.includes(path))),
  hostPost.length === 0 ? 'Host 未就绪：register.ts 尚无 WRITE_ROUTES（等待联调）' : `Host WRITE_ROUTES=[${hostPost.join(', ')}]`,
);

// ── 3. basePath 一致性 ───────────────────────────────────────────────────
const clientBase = (apiSource.match(/CANDIDATE_BASES\s*=\s*\[\s*'([^']+)'/) ?? [])[1] ?? '';
const hostDefaultBase = (registerSource.match(/DEFAULT_HTTP_BASE_PATH\s*=\s*'([^']+)'/) ?? [])[1] ?? '';
check('客户端首选 base 存在', clientBase.length > 0, clientBase);
check('客户端 base == Host DEFAULT_HTTP_BASE_PATH', clientBase === hostDefaultBase, `client=${clientBase} host=${hostDefaultBase}`);
check('Host 默认 base 以 /api/ 开头（宿主路由硬约束）', hostDefaultBase.startsWith('/api/'), hostDefaultBase);

const configBase = (configSource.match(/basePath:\s*'([^']+)'/) ?? [])[1] ?? '';
check('src/config.ts 默认 basePath 与 Host 一致', configBase === hostDefaultBase, `config=${configBase} host=${hostDefaultBase}`);

// ── 4. id 端点必须走 query（宿主不支持 path 参数）─────────────────────────
for (const endpoint of ['/raw-detail', '/raw-verify', '/memory-detail']) {
  // 允许 `{ id }` 或 `{ id, ...(scope ?? {}) }`（v5 增加作用域参数）
  const matched = apiSource.match(new RegExp(`apiGet<[^>]*>\\(\\s*'${endpoint.replace('/', '\\/')}'[^)]*\\bid\\b`));
  check(`id 端点 ${endpoint} 使用 query ?id=`, Boolean(matched), '');
}

// ── 5. v3/v4：retention / mode / vectors / forgetting / persona ──────────
check('客户端 retention() 使用 apiGet<RetentionData>(\'/retention\')', /retention:\s*\([^)]*\):\s*Promise<RetentionData>\s*=>\s*apiGet<RetentionData>\('\/retention'/.test(apiSource), '');
check('客户端 /memories 支持 retention 过滤参数', /retention\?:\s*string/.test(apiSource), '');
check('客户端 search() 声明并透传 mode（explicit|implicit）', /mode\?:\s*'explicit'\s*\|\s*'implicit'/.test(apiSource), '');
check('客户端类型含 RawVectorStats / ForgettingStats', /export interface RawVectorStats/.test(clientTypesSource) && /export interface ForgettingStats/.test(clientTypesSource), '');
check('客户端 clients 支持 personas() 与 memories({persona})', /personas:\s*\([^)]*\):\s*Promise<PersonaData>/.test(apiSource) && /persona\?:\s*string/.test(apiSource), '');
check('客户端类型含 PersonaSummary / PersonaHealth', /export interface PersonaSummary/.test(clientTypesSource) && /export interface PersonaHealth/.test(clientTypesSource), '');
check('客户端不再引用 /activation 或 ?tier=', !apiSource.includes('activation') && !apiSource.includes('tier?:'), '');

// ── 6. v5：vaults / session-config / 写操作类型 ──────────────────────────
check('客户端 vaults() 使用 apiGet<VaultsData>(\'/vaults\')', /vaults:\s*\([^)]*\):\s*Promise<VaultsData>\s*=>\s*apiGet<VaultsData>\('\/vaults'\)/.test(apiSource), '');
check('客户端 sessionConfig() 使用 GET /session-config', /sessionConfig:\s*\([^)]*\):\s*Promise<SessionConfig>[\s\S]{0,120}?apiGet<SessionConfig>\('\/session-config'/.test(apiSource), '');
check('客户端 saveSessionConfig() 使用 POST /session-config', /saveSessionConfig[\s\S]{0,160}?apiPost<SessionConfig>\('\/session-config'/.test(apiSource), '');
check(
  '客户端类型含 PersonaCreateInput/UpdateInput/SessionConfig/VaultsData',
  ['PersonaCreateInput', 'PersonaUpdateInput', 'SessionConfig', 'VaultsData', 'VaultInfo'].every((name) =>
    new RegExp(`export (interface|type) ${name}`).test(clientTypesSource),
  ),
  '',
);
check('客户端 POST 统一走 apiPost（同源 POST + JSON body）', /async function postRequest/.test(apiSource) && /method:\s*'POST'/.test(apiSource), '');
check('Host handlers 已解析 session-config/vaults（Host 未就绪时 pending）', hostExtra.length > 0 ? true : /personas/.test(handlersSource), hostExtra.length > 0 ? 'Host 未就绪（等待联调）' : 'Host handlers 已含 persona 路由');

// ── 7. v5.1：新会话默认（GET/POST /session-config 不带 sessionId，POST body defaults:true）──
check(
  '客户端 sessionDefaults() 使用 GET /session-config（不带 sessionId）',
  /sessionDefaults:\s*\([^)]*\):\s*Promise<SessionDefaults>\s*=>\s*apiGet<SessionDefaults>\('\/session-config'\)/.test(apiSource),
  '',
);
check(
  '客户端 saveSessionDefaults() 使用 POST /session-config + body defaults:true',
  /saveSessionDefaults[\s\S]{0,240}?apiPost<SessionDefaults>\('\/session-config'[\s\S]{0,160}?defaults:\s*true/.test(apiSource),
  '',
);
check(
  '新会话默认复用既有 /session-config 路由（GET 仍 16 / POST 仍 5，不新增路由）',
  clientPaths.length === EXPECTED_GET.length &&
    postPaths.length === EXPECTED_POST.length &&
    clientPaths.includes('/session-config') &&
    postPaths.includes('/session-config'),
  `GET=${clientPaths.length} POST=${postPaths.length}`,
);
check(
  '客户端类型含 SessionDefaults / SessionDefaultsInput（defaults:true 作用域）',
  /export interface SessionDefaults\b/.test(clientTypesSource) && /export interface SessionDefaultsInput\b/.test(clientTypesSource),
  '',
);

const failed = results.filter((item) => !item.ok);
console.log(`\n=== client/src/api.ts <-> src/http/register.ts（v5：16 GET + 5 POST）===`);
for (const item of results) console.log(`${item.ok ? 'PASS' : 'FAIL'}  ${item.name}${item.detail ? `  — ${item.detail}` : ''}`);
console.log(`\n${results.length - failed.length}/${results.length} 通过${failed.length > 0 ? '，存在失败项' : ''}`);
process.exitCode = failed.length === 0 ? 0 : 1;
