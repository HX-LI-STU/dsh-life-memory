/**
 * 核心工具测试：canonical JSON / 哈希原语 / 时区日期 / id 规则 / 文本切分 /
 * 原子文件与诊断锁。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CanonicalJsonError,
  canonicalJson,
  canonicalJsonBytes,
  tryCanonicalJson,
} from '../../src/core/canonical-json.ts';
import {
  FNV_OFFSET,
  FNV_SEED2,
  contentHash,
  fnv1a32,
  hashJson,
  isSha256Hex,
  nextPrevHash,
  sha256Hex,
  shortHash,
} from '../../src/core/hash.ts';
import { GENESIS_HASH } from '../../src/core/contracts.ts';
import {
  dateInTimeZone,
  formatUtcOffset,
  isDateString,
  isoInTimeZone,
  isoUtc,
  isValidTimeZone,
  timeZoneOffsetMinutes,
  todayInTimeZone,
} from '../../src/core/time.ts';
import {
  deriveMemoryId,
  formatRawId,
  isMemoryId,
  isRawId,
  isRawKind,
  parseMemoryId,
  parseRawId,
  RAW_ID_RE,
} from '../../src/core/ids.ts';
import {
  estimateTokens,
  lowerLatin,
  normalizeForContentHash,
  normalizeForEmbedding,
  normalizeForTextSeg,
  normalizeText,
  textToFtsText,
  tokenize,
  tokenizeTextSeg,
  tokenizeWeighted,
  truncateToTokens,
  uniqueTokens,
} from '../../src/core/text.ts';
import {
  acquirePidLock,
  appendFileDurable,
  atomicWriteFile,
  atomicWriteJson,
  atomicWriteViaTmp,
  cleanupDirFiles,
  LockBusyError,
  readJsonFile,
  readPidLock,
} from '../../src/core/fs-atomic.ts';

const tmpDirs: string[] = [];
function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-mv-core-'));
  tmpDirs.push(dir);
  return dir;
}
process.on('exit', () => {
  for (const dir of tmpDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

test('canonicalJson: keys sorted, no whitespace, deterministic', () => {
  const a = { b: 1, a: 2, nested: { z: true, y: [3, { q: null }] } };
  const b = { nested: { y: [3, { q: null }], z: true }, a: 2, b: 1 };
  assert.equal(canonicalJson(a), canonicalJson(b));
  assert.equal(canonicalJson(a), '{"a":2,"b":1,"nested":{"y":[3,{"q":null}],"z":true}}');
});

test('canonicalJson: round-trips JSON values losslessly', () => {
  const payload = {
    text: '记忆库 memory vault 🧠',
    numbers: [0, -1, 1.5, 1e21, 9007199254740991],
    nested: { flag: false, empty: {}, list: [] },
    nullValue: null,
  };
  assert.deepEqual(JSON.parse(canonicalJson(payload)), payload);
  assert.equal(canonicalJsonBytes(payload).byteLength, Buffer.byteLength(canonicalJson(payload)));
});

test('canonicalJson: undefined keys dropped, array undefined becomes null', () => {
  assert.equal(canonicalJson({ a: 1, b: undefined }), '{"a":1}');
  assert.equal(canonicalJson([1, undefined, 3]), '[1,null,3]');
  assert.equal(tryCanonicalJson({ a: undefined }), '{}');
});

test('canonicalJson: rejects non-JSON values with clear errors', () => {
  assert.throws(() => canonicalJson({ a: Number.NaN }), CanonicalJsonError);
  assert.throws(() => canonicalJson({ a: Infinity }), CanonicalJsonError);
  assert.throws(() => canonicalJson({ a: 1n }), /bigint/);
  assert.throws(() => canonicalJson(undefined), CanonicalJsonError);
  assert.throws(() => canonicalJson(() => 1), CanonicalJsonError);
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  assert.throws(() => canonicalJson(cyclic), /nesting deeper/);
  assert.equal(tryCanonicalJson({ a: 1n }), null);
});

test('hash: sha256 known vectors, json hash, contentHash', () => {
  assert.equal(sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(sha256Hex(Buffer.from('abc', 'utf8')), sha256Hex('abc'));
  assert.ok(isSha256Hex(sha256Hex('x')));
  assert.equal(shortHash(sha256Hex('x'), 8), sha256Hex('x').slice(0, 8));
  assert.equal(shortHash('记忆', 8).length, 8);
  assert.equal(hashJson({ a: 1, b: [2] }), sha256Hex('{"a":1,"b":[2]}'));
  assert.equal(nextPrevHash(null), GENESIS_HASH);
  assert.equal(nextPrevHash(''), GENESIS_HASH);
  assert.equal(nextPrevHash('abc'), 'abc');
  // docs §6.2: content_hash = sha256(layer + "\0" + kind + "\0" + normalizeText(text))
  assert.equal(contentHash('L3', 'fact', '  Hello, world!  '), sha256Hex('L3\0fact\0hello, world'));
  assert.equal(contentHash('L3', 'fact', 'Hello, world'), contentHash('L3', 'fact', 'hello, world!'));
  assert.notEqual(contentHash('L3', 'fact', 'a'), contentHash('L3', 'preference', 'a'));
});

test('hash: fnv1a32 deterministic, seeded variants', () => {
  assert.equal(fnv1a32('hello'), 0x4f9f2cab);
  assert.equal(fnv1a32('记忆'), fnv1a32('记忆'));
  assert.notEqual(fnv1a32('x', FNV_OFFSET), fnv1a32('x', FNV_SEED2));
  assert.equal(FNV_OFFSET, 0x811c9dc5);
  assert.equal(FNV_SEED2, 0x7f4a7c15);
  assert.ok(fnv1a32('') === 0x811c9dc5);
});

test('time: date in configured IANA timezone across day boundary', () => {
  const ts = Date.UTC(2025, 11, 31, 16, 30); // 2025-12-31T16:30Z
  assert.equal(dateInTimeZone(ts, 'UTC'), '2025-12-31');
  assert.equal(dateInTimeZone(ts, 'Asia/Shanghai'), '2026-01-01');
  assert.equal(dateInTimeZone(ts, 'America/New_York'), '2025-12-31');
  assert.equal(todayInTimeZone('Asia/Shanghai', ts), '2026-01-01');
  assert.equal(isDateString('2025-12-31'), true);
  assert.equal(isDateString('2025-02-30'), false);
  assert.equal(isValidTimeZone('Not/AZone'), false);
});

test('time: DST-safe offsets, UTC ISO helper, ISO round-trip', () => {
  const summer = Date.UTC(2026, 6, 1, 12, 0, 0);
  const winter = Date.UTC(2026, 0, 15, 12, 0, 0);
  assert.equal(timeZoneOffsetMinutes(summer, 'America/New_York'), -240);
  assert.equal(timeZoneOffsetMinutes(winter, 'America/New_York'), -300);
  assert.equal(timeZoneOffsetMinutes(summer, 'Asia/Shanghai'), 480);
  assert.equal(formatUtcOffset(480), '+08:00');
  assert.equal(formatUtcOffset(-300), '-05:00');
  const d1 = Date.UTC(2026, 2, 8, 7, 30, 0); // DST 切换后 NY 03:30 EDT
  assert.equal(isoInTimeZone(d1, 'America/New_York'), '2026-03-08T03:30:00.000-04:00');
  assert.equal(Date.parse(isoInTimeZone(d1, 'America/New_York')), d1);
  // L0 行 iso 使用 UTC Z（docs §5.2 示例）
  assert.equal(isoUtc(d1), '2026-03-08T07:30:00.000Z');
  const withMs = Date.UTC(2026, 9, 25, 15, 15, 37, 123);
  assert.equal(Date.parse(isoUtc(withMs)), withMs);
});

test('ids: raw id format/parse incl >999999 daySeq overflow rule', () => {
  assert.equal(formatRawId('2026-10-25', 1), '2026-10-25-000001');
  assert.equal(formatRawId('2026-10-25', 123), '2026-10-25-000123');
  assert.deepEqual(parseRawId('2026-10-25-000123'), { date: '2026-10-25', daySeq: 123 });
  assert.equal(parseRawId('2026-10-25-000000'), null);
  assert.equal(parseRawId('bad'), null);
  assert.equal(isRawId('2026-10-25-999999'), true);
  // docs §6.2 溢出：>999999 条时 id 变 7 位
  assert.equal(formatRawId('2026-10-25', 1_000_000), '2026-10-25-1000000');
  assert.deepEqual(parseRawId('2026-10-25-1000000'), { date: '2026-10-25', daySeq: 1_000_000 });
  assert.equal(RAW_ID_RE.test('2026-10-25-1000000'), true);
  assert.throws(() => formatRawId('26-10-25', 1), RangeError);
  assert.equal(isRawKind('user'), true);
  assert.equal(isRawKind('nope'), false);
});

test('ids: derived memory ids deterministic + docs §8.1 shape', () => {
  const contentHashValue = sha256Hex('fact text');
  const id1 = deriveMemoryId('L3', 'fact', 1_700_000_000_000, contentHashValue);
  const id2 = deriveMemoryId('L3', 'fact', 1_700_000_000_000, contentHashValue);
  assert.equal(id1, id2);
  assert.match(id1, /^L3-fact-[0-9a-z]+-[0-9a-f]{8}$/);
  assert.equal(isMemoryId(id1), true);
  assert.equal(isMemoryId('not-a-memory-id'), false);
  const parsed = parseMemoryId(id1);
  assert.equal(parsed?.layer, 'L3');
  assert.equal(parsed?.kind, 'fact');
  assert.equal(parsed?.ts, 1_700_000_000_000);
  assert.equal(parsed?.hash8, contentHashValue.slice(0, 8));
  // 扩展层 id（小写自定义层名）也满足 §8.1
  assert.equal(isMemoryId(deriveMemoryId('project', 'custom', 1_700_000_000_000, contentHashValue)), true);
  assert.equal(parseMemoryId('L3-fact-!!-a1b2c3d4'), null);
  assert.equal(parseMemoryId('L3-fact-m9k2x1-A1B2C3D4'), null); // hash8 必须小写
});

test('text: normalization variants (text_seg / embedding / content-hash)', () => {
  assert.equal(normalizeText('  Ｈｅｌｌｏ　ＷＯＲＬＤ  '), 'hello world');
  assert.equal(normalizeForTextSeg('ＡＢＣ 记忆'), 'abc 记忆');
  assert.equal(normalizeForEmbedding('ABC 记忆'), 'abc 记忆');
  assert.equal(lowerLatin('ABC Ж'), 'abc Ж'); // 只拉丁小写，不动西里尔
  assert.equal(normalizeForContentHash('  "Hello, world!"  '), 'hello, world');
});

test('text: docs §7.4 text_seg tokenizer + query matching behaviour', () => {
  assert.equal(textToFtsText('记忆库'), '记忆 忆库');
  assert.deepEqual(tokenizeTextSeg('我喜欢用深色主题，请默认 deep-mode'), [
    '我喜',
    '喜欢',
    '欢用',
    '用深',
    '深色',
    '色主',
    '主题',
    '请默',
    '默认',
    'deep',
    'mode',
  ]);
  // 下划线/点号不算 WORD_CHAR（docs §7.4: dsh_life_memory 与 dsh-life-memory 等价）
  assert.deepEqual(tokenizeTextSeg('dsh_memory.vault'), ['dsh', 'memory', 'vault']);
  // CJK 单字段输出单字
  assert.deepEqual(tokenizeTextSeg('好'), ['好']);
  assert.deepEqual(tokenize('记忆库'), tokenizeTextSeg('记忆库'));
  assert.equal(uniqueTokens(['a', 'b', 'a']).length, 2);
});

test('text: docs §10.2 weighted tokenizer (CJK unigram 0.6 / bigram 1.0)', () => {
  const weighted = tokenizeWeighted('深色主题 theme');
  assert.deepEqual(
    weighted,
    [
      { token: '深', kindWeight: 0.6 },
      { token: '色', kindWeight: 0.6 },
      { token: '主', kindWeight: 0.6 },
      { token: '题', kindWeight: 0.6 },
      { token: '深色', kindWeight: 1 },
      { token: '色主', kindWeight: 1 },
      { token: '主题', kindWeight: 1 },
      { token: 'theme', kindWeight: 1 },
    ],
  );
});

test('text: token estimation and truncation', () => {
  assert.equal(estimateTokens('记忆库'), 3);
  assert.equal(estimateTokens('hello world'), Math.ceil(2 * 1.3));
  assert.ok(estimateTokens('记忆库 memory') > estimateTokens('记忆库'));
  assert.equal(truncateToTokens('记忆库记忆库', 2), '记忆');
  assert.equal(truncateToTokens('hello', 0), '');
  const long = '记忆库'.repeat(10) + ' hello world';
  assert.ok(estimateTokens(truncateToTokens(long, 12)) <= 13);
});

test('fs-atomic: durable atomic write, JSON fallback, append, tmp-rename, cleanup', async () => {
  const dir = tmpDir();
  const file = join(dir, 'nested', 'state.json');
  await atomicWriteJson(file, { version: 1, n: 2 });
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { version: 1, n: 2 });
  await atomicWriteFile(file, 'raw-text');
  assert.equal(readFileSync(file, 'utf8'), 'raw-text');
  assert.deepEqual(await readJsonFile(join(dir, 'missing.json'), { fallback: true }), { fallback: true });
  writeFileSync(file, '{not json');
  assert.deepEqual(await readJsonFile(file, { ok: false }), { ok: false });

  // tmp + rename（manifest 用）：跨目录 rename 同卷
  const tmpFile = join(dir, 'tmp', 'manifest.json.tmp');
  const target = join(dir, 'manifest.json');
  await atomicWriteViaTmp(tmpFile, target, '{"formatVersion":1}');
  assert.equal(readFileSync(target, 'utf8'), '{"formatVersion":1}');

  const log = join(dir, 'a.jsonl');
  assert.equal(await appendFileDurable(log, 'one\n'), 4);
  assert.equal(await appendFileDurable(log, 'two\n'), 4);
  assert.equal(readFileSync(log, 'utf8'), 'one\ntwo\n');

  const tmpDirPath = join(dir, 'tmp');
  writeFileSync(join(tmpDirPath, 'x.tmp'), 'x');
  assert.equal(await cleanupDirFiles(tmpDirPath), 1);
});

test('fs-atomic: pid lock acquire/release/stale/busy semantics', async () => {
  const dir = tmpDir();
  const lockPath = join(dir, 'writer.lock');
  const release = await acquirePidLock(lockPath);
  assert.equal((await readPidLock(lockPath))?.pid, process.pid);
  const release2 = await acquirePidLock(lockPath); // 同进程重开视为 stale
  await release();
  assert.ok(await readPidLock(lockPath));
  await release2();
  assert.equal(await readPidLock(lockPath), null);
  writeFileSync(lockPath, JSON.stringify({ pid: 4242, token: 'other', startedAt: 1, host: '' }));
  // 注入 pid 存活检测，避免依赖机器上真实 pid 分配（确定性/harmetic）
  await assert.rejects(
    () => acquirePidLock(lockPath, { isPidAlive: () => true }),
    LockBusyError,
  );
  const release3 = await acquirePidLock(lockPath, { isPidAlive: () => false });
  assert.equal((await readPidLock(lockPath))?.pid, process.pid);
  await release3();
});
