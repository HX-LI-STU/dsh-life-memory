/**
 * L0 原始记忆库（RawVault）测试：
 * 追加/读取/过滤/统计/哈希链/字节格式/日期编号/轮转/幂等/崩溃恢复/tamper 检测/
 * manifest 重建/诊断文件/关闭语义。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AppendResult, RawRecord, RawRecordInput } from '../../src/core/contracts.ts';
import { GENESIS_HASH } from '../../src/core/contracts.ts';
import { sha256Hex } from '../../src/core/hash.ts';
import { formatRawId } from '../../src/core/ids.ts';
import { serializeRecordLine } from '../../src/vault/record.ts';
import {
  buildRawRecord,
  hashRawRecord,
  openRawVault,
  parseSegmentRelativePath,
  sanitizeSessionKey,
  type RawVaultImpl,
} from '../../src/vault/index.ts';

const TZ = 'Asia/Shanghai';
const BASE_TS = Date.UTC(2026, 9, 25, 7, 0, 0); // 2026-10-25T15:00:00+08:00

const tmpDirs: string[] = [];
function tmpRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-mv-vault-'));
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

function mkInput(overrides: Partial<RawRecordInput> = {}): RawRecordInput {
  return {
    kind: 'user',
    ts: BASE_TS,
    timezone: TZ,
    sessionId: 'sess_1',
    workspace: 'D:\\work\\proj',
    turnId: 'turn_1',
    stepId: 'step_1',
    role: 'user',
    text: 'hello world',
    payload: { eventType: 'message', message: { role: 'user', content: 'hello world' } },
    tags: ['role:user'],
    ...overrides,
  };
}

async function openTest(root: string, overrides: Record<string, unknown> = {}): Promise<RawVaultImpl> {
  return openRawVault({
    rootDir: root,
    timezone: TZ,
    fsync: false,
    writerInfo: false,
    ...overrides,
  } as Parameters<typeof openRawVault>[0]);
}

function segmentAbs(root: string, rel: string): string {
  return join(root, ...rel.split('/'));
}

function readManifestFile(root: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8')) as Record<string, unknown>;
}

function readSegmentLines(root: string, rel: string): string[] {
  const content = readFileSync(segmentAbs(root, rel), 'utf8');
  assert.ok(content.length > 0);
  assert.ok(content.endsWith('\n'), 'segment file must be newline terminated');
  return content.slice(0, -1).split('\n');
}

function firstSegment(vault: RawVaultImpl): string {
  return vault.segmentList[0].segment;
}

test('vault: layout, append, read, filters, stats, verify, manifest', async () => {
  const root = tmpRoot();
  const vault = await openTest(root);
  assert.equal(readFileSync(join(root, 'VERSION'), 'utf8'), '2\n');
  assert.equal((await vault.manifest()).formatVersion, 1);
  assert.deepEqual(await vault.stats(), { records: 0, segments: 0, days: 0, bytes: 0 });

  const result: AppendResult = await vault.append([
    mkInput({ ts: BASE_TS }),
    mkInput({ kind: 'assistant', role: 'assistant', text: 'hi there', ts: BASE_TS + 1000, payload: { r: 2 } }),
    mkInput({ ts: BASE_TS + 2000, sessionId: 'sess_2' }),
  ]);
  assert.equal(result.items.length, 3);
  assert.equal(result.skipped, 0);
  // v2：同一批次里的不同 sessionId 分组写入各自会话目录（2 个段文件）
  assert.equal(result.segmentsWritten.length, 2);
  for (const relPath of result.segmentsWritten) {
    assert.match(relPath, /^segments\/2026-10-25\/sess_[12]\/seg-w[0-9a-f]{6}-000001\.jsonl$/);
  }
  // 全局哈希链保持连续：seq/prevHash 仍按追加顺序
  const records = result.items.map((item) => item.record);
  assert.deepEqual(
    records.map((record) => record.id),
    ['2026-10-25-000001', '2026-10-25-000002', '2026-10-25-000003'],
  );
  assert.deepEqual(records.map((record) => record.seq), [1, 2, 3]);
  assert.deepEqual(records.map((record) => record.day), ['2026-10-25', '2026-10-25', '2026-10-25']);
  assert.equal(records[0].prevHash, GENESIS_HASH);
  assert.equal(records[1].prevHash, records[0].hash);
  assert.equal(records[2].prevHash, records[1].hash);
  assert.equal(records[0].iso, new Date(BASE_TS).toISOString());
  assert.equal(records[0].v, 1);
  assert.deepEqual(result.items.map((item) => item.location.lineNo), [1, 2, 1]);
  assert.ok(result.items[0].location.byteOffset === 0);
  assert.ok(
    result.items[1].location.byteOffset ===
      result.items[0].location.byteOffset + result.items[0].location.byteLen,
  );
  assert.ok(result.items.every((item) => item.location.ingestKey.length > 0));

  // 段文件内容 = 逐字节 canonical 行；每行只属于单一会话（物理隔离）
  const seg1 = vault.segmentList.find((segment) => segment.sessionId === 'sess_1');
  const seg2 = vault.segmentList.find((segment) => segment.sessionId === 'sess_2');
  assert.ok(seg1 !== undefined && seg2 !== undefined);
  assert.match(seg1.segment, /^segments\/2026-10-25\/sess_1\/seg-w[0-9a-f]{6}-000001\.jsonl$/);
  assert.match(seg2.segment, /^segments\/2026-10-25\/sess_2\/seg-w[0-9a-f]{6}-000001\.jsonl$/);
  const lines1 = readSegmentLines(root, seg1.segment);
  const lines2 = readSegmentLines(root, seg2.segment);
  assert.equal(lines1.length, 2);
  assert.equal(lines2.length, 1);
  assert.deepEqual(lines1.map((line) => (JSON.parse(line) as RawRecord).sessionId), ['sess_1', 'sess_1']);
  assert.deepEqual(lines2.map((line) => (JSON.parse(line) as RawRecord).sessionId), ['sess_2']);
  const lines = [lines1[0], lines1[1], lines2[0]];
  for (let i = 0; i < 3; i += 1) {
    assert.equal(lines[i], serializeRecordLine(records[i]));
    assert.deepEqual(JSON.parse(lines[i]), records[i]);
    const location = result.items[i].location;
    assert.deepEqual(location.segment, i < 2 ? seg1.segment : seg2.segment);
    assert.equal(location.byteLen, Buffer.byteLength(lines[i], 'utf8') + 1);
  }

  // get
  const fetched = await vault.get(records[1].id);
  assert.deepEqual(fetched, records[1]);
  assert.equal(await vault.get('2026-10-25-999999'), null);
  assert.equal(await vault.get('not-an-id'), null);

  // list
  const all = await vault.list();
  assert.equal(all.total, 3);
  assert.deepEqual(all.records.map((record) => record.seq), [1, 2, 3]);
  const desc = await vault.list({ desc: true });
  assert.deepEqual(desc.records.map((record) => record.seq), [3, 2, 1]);
  const page = await vault.list({ offset: 1, limit: 1 });
  assert.equal(page.total, 3);
  assert.deepEqual(page.records.map((record) => record.seq), [2]);
  assert.equal((await vault.list({ kinds: ['assistant'] })).total, 1);
  assert.equal((await vault.list({ sessionId: 'sess_2' })).total, 1);
  assert.equal((await vault.list({ sessionId: 'nope' })).total, 0);
  assert.equal((await vault.list({ workspace: 'D:\\work\\proj' })).total, 3);
  assert.equal((await vault.list({ from: BASE_TS + 1000, to: BASE_TS + 2000 })).total, 2);
  assert.equal((await vault.list({ day: '2026-10-25' })).total, 3);
  assert.equal((await vault.list({ day: '2026-10-26' })).total, 0);
  const byIds = await vault.list({ ids: [records[2].id, records[0].id] });
  assert.deepEqual(byIds.records.map((record) => record.seq), [1, 3]);

  // iterate
  const iterated: number[] = [];
  for await (const record of vault.iterate()) iterated.push(record.seq);
  assert.deepEqual(iterated, [1, 2, 3]);
  const iteratedDesc: number[] = [];
  for await (const record of vault.iterate({ desc: true, limit: 2 })) iteratedDesc.push(record.seq);
  assert.deepEqual(iteratedDesc, [3, 2]);
  // 消费方提前 break 不应留下未处理错误
  for await (const _record of vault.iterate()) {
    void _record;
    break;
  }

  // stats / manifest
  const stats = await vault.stats();
  assert.equal(stats.records, 3);
  assert.equal(stats.segments, 2);
  assert.equal(stats.days, 1);
  assert.equal(
    stats.bytes,
    statSync(segmentAbs(root, seg1.segment)).size + statSync(segmentAbs(root, seg2.segment)).size,
  );
  assert.equal(stats.firstId, records[0].id);
  assert.equal(stats.lastId, records[2].id);
  assert.equal(stats.firstTs, BASE_TS);
  assert.equal(stats.lastTs, BASE_TS + 2000);
  const manifest = await vault.manifest();
  assert.equal(manifest.segments.length, 2);
  const manifestSeg1 = manifest.segments.find((segment) => segment.sessionId === 'sess_1');
  const manifestSeg2 = manifest.segments.find((segment) => segment.sessionId === 'sess_2');
  assert.ok(manifestSeg1 !== undefined && manifestSeg2 !== undefined);
  assert.equal(manifestSeg1.records, 2);
  assert.equal(manifestSeg1.day, '2026-10-25');
  assert.equal(manifestSeg1.sealed, false); // 活跃段
  assert.equal(manifestSeg2.records, 1);
  assert.equal(manifestSeg1.bytes + manifestSeg2.bytes, stats.bytes);
  assert.equal(manifest.stats.records, 3);

  const verified = await vault.verify();
  assert.deepEqual(verified, { ok: true, checked: 3 });
  await vault.close();
  await assert.rejects(() => vault.append([mkInput()]), /closed/);
  await vault.close(); // 幂等
});

test('vault: append reuses active segment across calls, reopen seals and continues chain', async () => {
  const root = tmpRoot();
  let vault = await openTest(root);
  const first = await vault.append([mkInput({ ts: BASE_TS })]);
  const second = await vault.append([mkInput({ ts: BASE_TS + 1000 }), mkInput({ ts: BASE_TS + 2000 })]);
  assert.equal(first.segmentsWritten[0], second.segmentsWritten[0]);
  assert.deepEqual([...first.items, ...second.items].map((item) => item.record.seq), [1, 2, 3]);
  assert.deepEqual(second.items.map((item) => item.location.lineNo), [2, 3]);
  assert.deepEqual(await vault.verify(), { ok: true, checked: 3 });
  await vault.close();

  vault = await openTest(root);
  assert.equal((await vault.stats()).records, 3);
  const appended = await vault.append([mkInput({ ts: BASE_TS + 3000 })]);
  assert.equal(appended.items[0].record.seq, 4);
  assert.equal(appended.items[0].record.id, '2026-10-25-000004');
  assert.equal(appended.items[0].record.prevHash, second.items[1].record.hash);
  assert.notEqual(appended.segmentsWritten[0], first.segmentsWritten[0]); // 重开后新段
  assert.equal((await vault.stats()).segments, 2);
  assert.deepEqual(await vault.verify(), { ok: true, checked: 4 });
  await vault.close();
});

test('vault: hash algorithm is docs §5.2 byte-exact and payload key order preserved', async () => {
  const root = tmpRoot();
  const vault = await openTest(root);
  const payload = { b: 1, a: { y: 2, x: 3 }, text: '记忆' };
  const result = await vault.append([
    mkInput({ payload, tags: ['t1', 't2'] }),
    mkInput({ ts: BASE_TS + 1, payload: { second: true } }),
  ]);
  const rel = firstSegment(vault);
  const lines = readSegmentLines(root, rel);
  // 宿主 payload 键序不得被排序（docs §5.2）
  assert.ok(
    lines[0].includes('"payload":{"b":1,"a":{"y":2,"x":3},"text":"记忆"}'),
    `payload key order must be preserved: ${lines[0]}`,
  );
  // 手工复算哈希：sha256(prevHash + "\n" + JSON.stringify(record_without_hash))
  const parsed = JSON.parse(lines[0]) as Record<string, unknown>;
  const expectedPrev = parsed.prevHash as string;
  delete parsed.hash;
  const recomputed = sha256Hex(`${expectedPrev}\n${JSON.stringify(parsed)}`);
  assert.equal(recomputed, result.items[0].record.hash);
  assert.equal(hashRawRecord(result.items[0].record), result.items[0].record.hash);
  // 字段顺序固定：以 {"id":... 开头，,"prevHash":...,"hash":...} 结尾
  assert.ok(lines[0].startsWith('{"id":"2026-10-25-000001","seq":1,"ts":'));
  assert.ok(lines[0].endsWith(`"prevHash":"${GENESIS_HASH}","hash":"${result.items[0].record.hash}"}`));
  assert.deepEqual(await vault.verify(), { ok: true, checked: 2 });
  await vault.close();
});

test('vault: id numbering across day boundary uses config timezone (not record timezone)', async () => {
  const root = tmpRoot();
  const vault = await openTest(root);
  const t1 = Date.UTC(2025, 11, 31, 15, 59, 59); // 上海 2025-12-31 23:59:59
  const t2 = t1 + 1000; // 上海 2026-01-01 00:00:00
  const result = await vault.append([
    mkInput({ ts: t1, timezone: 'UTC' }),
    mkInput({ ts: t2, timezone: 'UTC' }),
    mkInput({ ts: t2 + 1000 }),
  ]);
  assert.deepEqual(
    result.items.map((item) => item.record.id),
    ['2025-12-31-000001', '2026-01-01-000001', '2026-01-01-000002'],
  );
  assert.deepEqual(result.items.map((item) => item.record.day), ['2025-12-31', '2026-01-01', '2026-01-01']);
  assert.deepEqual(result.items.map((item) => item.record.seq), [1, 2, 3]);
  assert.equal(result.segmentsWritten.length, 2);
  const stats = await vault.stats();
  assert.equal(stats.days, 2);
  assert.equal(stats.segments, 2);
  assert.deepEqual(await vault.verify(), { ok: true, checked: 3 });
  const manifest = await vault.manifest();
  assert.deepEqual(
    manifest.segments.map((segment) => segment.day),
    ['2025-12-31', '2026-01-01'],
  );
  await vault.close();
});

test('vault: segment rotation by record count and byte threshold', async () => {
  const root = tmpRoot();
  let vault = await openTest(root, { segmentMaxRecords: 2 });
  const result = await vault.append(Array.from({ length: 5 }, (_, i) => mkInput({ ts: BASE_TS + i })));
  const segmentCounts = vault.segmentList.map((segment) => segment.records);
  assert.deepEqual(segmentCounts, [2, 2, 1]);
  assert.equal(result.segmentsWritten.length, 3);
  assert.deepEqual(await vault.verify(), { ok: true, checked: 5 });
  await vault.close();

  const root2 = tmpRoot();
  vault = await openTest(root2, { segmentMaxBytes: 900 });
  const bigText = 'x'.repeat(200);
  const bigResult = await vault.append(
    Array.from({ length: 8 }, (_, i) =>
      mkInput({ ts: BASE_TS + i, text: bigText, payload: { i, text: bigText } }),
    ),
  );
  assert.ok(bigResult.segmentsWritten.length > 1);
  assert.ok(vault.segmentList.every((segment) => segment.bytes <= 900));
  assert.deepEqual(await vault.verify(), { ok: true, checked: 8 });
  await vault.close();
});

test('vault: ingestKey dedupe via seenIngestKeys (skip before seq allocation)', async () => {
  const root = tmpRoot();
  const seen = new Set<string>();
  const vault = await openTest(root, { seenIngestKeys: (key: string) => seen.has(key) });
  const inputA = mkInput({ ingestKey: 'k1', ts: BASE_TS });
  const inputB = mkInput({ ingestKey: 'k2', ts: BASE_TS + 1 });
  const first = await vault.append([inputA, inputB]);
  assert.equal(first.items.length, 2);
  for (const item of first.items) seen.add(item.location.ingestKey);

  const again = await vault.append([inputA, inputB]);
  assert.equal(again.items.length, 0);
  assert.equal(again.skipped, 2);
  assert.equal((await vault.stats()).records, 2);

  // 批内重复 ingestKey 只保留第一条
  const batchDup = await vault.append([
    mkInput({ ingestKey: 'dup', ts: BASE_TS + 2 }),
    mkInput({ ingestKey: 'dup', ts: BASE_TS + 3 }),
  ]);
  assert.equal(batchDup.items.length, 1);
  assert.equal(batchDup.skipped, 1);

  // 无显式 ingestKey 时使用 auto:<ts>:<sha256(payload)>；重复投递被去重
  const autoInput = mkInput({ ts: BASE_TS + 4, payload: { auto: true } });
  const autoFirst = await vault.append([autoInput]);
  assert.match(autoFirst.items[0].location.ingestKey, /^auto:/);
  seen.add(autoFirst.items[0].location.ingestKey);
  const autoAgain = await vault.append([autoInput]);
  assert.equal(autoAgain.skipped, 1);
  assert.equal(autoAgain.items.length, 0);

  assert.equal((await vault.stats()).records, 4);
  assert.deepEqual(await vault.verify(), { ok: true, checked: 4 });
  await vault.close();
});

test('vault: recovery truncates torn tail of newest segment only', async () => {
  const root = tmpRoot();
  let vault = await openTest(root, { segmentMaxRecords: 2 });
  await vault.append(Array.from({ length: 3 }, (_, i) => mkInput({ ts: BASE_TS + i })));
  const segments = vault.segmentList.map((segment) => segment.segment);
  await vault.close();

  // 最新段（第二个）追加一条无换行残尾
  const newest = segmentAbs(root, segments[1]);
  const beforeSize = statSync(newest).size;
  appendFileSync(newest, '{"id":"2026-10-25-999999","seq":99');
  // 更早的段也追加残尾：不允许被截断（非最新段）
  const older = segmentAbs(root, segments[0]);
  const olderBefore = statSync(older).size;
  appendFileSync(older, 'garbage-tail');

  vault = await openTest(root, { segmentMaxRecords: 2 });
  assert.equal(statSync(newest).size, beforeSize);
  assert.equal(statSync(older).size, olderBefore + 'garbage-tail'.length);
  const stats = await vault.stats();
  assert.equal(stats.records, 3);
  // 旧段的残尾是外部篡改：verify 必须报错（不修改文件）
  const verified = await vault.verify();
  assert.equal(verified.ok, false);
  assert.ok(verified.error !== undefined);
  assert.match(verified.error.reason, /manifest mismatch|invalid JSON|bytes/);
  // 新段可继续追加
  const appended = await vault.append([mkInput({ ts: BASE_TS + 10 })]);
  assert.equal(appended.items[0].record.seq, 4);
  await vault.close();
});

test('vault: recovery adopts complete orphan lines written before manifest (crash B)', async () => {
  const root = tmpRoot();
  let vault = await openTest(root);
  await vault.append([mkInput({ ts: BASE_TS })]);
  const last = (await vault.list({ desc: true, limit: 1 })).records[0];
  const segments = vault.segmentList.map((segment) => segment.segment);
  await vault.close();

  // 手工构造一条合法孤儿记录（hash 链正确）追加到段文件，但不更新 manifest
  const orphan = buildRawRecord(mkInput({ ts: BASE_TS + 1 }), {
    id: formatRawId(last.day, 2),
    seq: last.seq + 1,
    day: last.day,
    iso: new Date(BASE_TS + 1).toISOString(),
    prevHash: last.hash,
  });
  appendFileSync(segmentAbs(root, segments[0]), `${serializeRecordLine(orphan)}\n`);
  const manifestBefore = readManifestFile(root);
  assert.equal((manifestBefore.stats as { records: number }).records, 1);

  vault = await openTest(root);
  const stats = await vault.stats();
  assert.equal(stats.records, 2);
  assert.equal(stats.lastId, orphan.id);
  assert.deepEqual(await vault.verify(), { ok: true, checked: 2 });
  const verifiedManifest = await vault.manifest();
  assert.equal(verifiedManifest.stats.records, 2);
  // 后续追加链继续正确
  const appended = await vault.append([mkInput({ ts: BASE_TS + 2 })]);
  assert.equal(appended.items[0].record.seq, 3);
  assert.equal(appended.items[0].record.prevHash, orphan.hash);
  await vault.close();
});

test('vault: manifest missing/corrupt => rebuild from segments, append continues', async () => {
  const root = tmpRoot();
  let vault = await openTest(root);
  await vault.append(Array.from({ length: 4 }, (_, i) => mkInput({ ts: BASE_TS + i })));
  await vault.close();

  unlinkSync(join(root, 'manifest.json'));
  vault = await openTest(root);
  assert.equal((await vault.stats()).records, 4);
  assert.deepEqual(await vault.verify(), { ok: true, checked: 4 });
  const appended = await vault.append([mkInput({ ts: BASE_TS + 10 })]);
  assert.equal(appended.items[0].record.id, '2026-10-25-000005');
  await vault.close();

  writeFileSync(join(root, 'manifest.json'), '{not valid json');
  vault = await openTest(root);
  assert.equal((await vault.stats()).records, 5);
  assert.deepEqual(await vault.verify(), { ok: true, checked: 5 });
  await vault.close();
});

test('vault: tamper detection (middle record modified) is read-only', async () => {
  const root = tmpRoot();
  let vault = await openTest(root);
  await vault.append(Array.from({ length: 3 }, (_, i) => mkInput({ ts: BASE_TS + i })));
  const rel = firstSegment(vault);
  await vault.close();

  const file = segmentAbs(root, rel);
  const lines = readFileSync(file, 'utf8').split('\n');
  lines[1] = lines[1].replace('"text":"hello world"', '"text":"HELLO WORLD"');
  writeFileSync(file, lines.join('\n'));
  const tampered = readFileSync(file, 'utf8');

  vault = await openTest(root);
  const verified = await vault.verify();
  assert.equal(verified.ok, false);
  assert.equal(verified.error?.seq, 2);
  assert.match(verified.error?.reason ?? '', /hash mismatch/);
  // verify 绝不修改文件
  assert.equal(readFileSync(file, 'utf8'), tampered);
  await vault.close();
});

test('vault: unsupported VERSION / invalid options / invalid batch rejected atomically', async () => {
  const root = tmpRoot();
  writeFileSync(join(root, 'VERSION'), '3\n');
  await assert.rejects(() => openTest(root), /unsupported vault VERSION/);

  const root2 = tmpRoot();
  await assert.rejects(
    () => openRawVault({ rootDir: root2, timezone: 'Not/AZone', fsync: false }),
    /timezone/,
  );

  const vault = await openTest(tmpRoot());
  assert.deepEqual(await vault.append([]), { items: [], skipped: 0, segmentsWritten: [] });
  await assert.rejects(() => vault.append([mkInput({ kind: 'bogus' as unknown as 'user' })]), /kind/);
  await assert.rejects(() => vault.append([mkInput({ ts: Number.NaN })]), /ts/);
  await assert.rejects(() => vault.append([mkInput({ payload: undefined as unknown })]), /payload/);
  const bigintPayload = { n: 1n } as unknown;
  await assert.rejects(() => vault.append([mkInput({ payload: bigintPayload })]), /bigint|JSON value/);
  // 非法批不落任何数据
  assert.deepEqual(await vault.stats(), { records: 0, segments: 0, days: 0, bytes: 0 });
  assert.deepEqual(await vault.verify(), { ok: true, checked: 0 });
  await vault.close();
});

test('vault: writerId option + locks/writer.json diagnostics', async () => {
  const root = tmpRoot();
  const vault = await openRawVault({
    rootDir: root,
    timezone: TZ,
    writerId: 'w1a2b3c',
    fsync: false,
  });
  const result = await vault.append([mkInput({ ts: BASE_TS })]);
  assert.match(result.segmentsWritten[0], /seg-w1a2b3c-000001\.jsonl$/);
  assert.ok(existsSync(join(root, 'locks', 'writer.json')));
  const writerInfo = JSON.parse(readFileSync(join(root, 'locks', 'writer.json'), 'utf8')) as {
    writerId: string;
    pid: number;
    startedAt: number;
    heartbeatAt: number;
  };
  assert.equal(writerInfo.writerId, 'w1a2b3c');
  assert.equal(writerInfo.pid, process.pid);
  assert.ok(writerInfo.startedAt > 0);
  await vault.close();
  assert.equal(existsSync(join(root, 'locks', 'writer.json')), false);
});

test('vault: syncManifest rebuilds cache from segment files', async () => {
  const root = tmpRoot();
  const vault = await openTest(root);
  await vault.append([mkInput({ ts: BASE_TS }), mkInput({ ts: BASE_TS + 1 })]);
  unlinkSync(join(root, 'manifest.json'));
  const manifest = await vault.syncManifest();
  assert.equal(manifest.stats.records, 2);
  assert.equal(manifest.segments.length, 1);
  assert.ok(existsSync(join(root, 'manifest.json')));
  assert.deepEqual(await vault.verify(), { ok: true, checked: 2 });
  await vault.close();
});

// ---------------------------------------------------------------------------
// v2：按会话物理隔离（段文件落在 segments/<day>/<sessionKey>/）
// ---------------------------------------------------------------------------

test('vault: session raw isolation (per-session directories, global hash chain)', async () => {
  const root = tmpRoot();
  const vault = await openTest(root, { writerId: 'w1a2b3c' });
  // 同一批里混入多个会话 + 需要清洗的 sessionId
  const weird = 'sess/../有 空格';
  const result = await vault.append([
    mkInput({ ts: BASE_TS, sessionId: 'sess_1' }),
    mkInput({ ts: BASE_TS + 1, sessionId: weird }),
    mkInput({ ts: BASE_TS + 2, sessionId: 'sess_1' }),
    mkInput({ ts: BASE_TS + 3, sessionId: 'sess_1' }),
  ]);
  assert.equal(result.items.length, 4);
  assert.equal(result.segmentsWritten.length, 2);
  const key1 = sanitizeSessionKey('sess_1');
  const keyWeird = sanitizeSessionKey(weird);
  assert.equal(key1, 'sess_1');
  assert.equal(keyWeird, 'sess-..-----'); // '/'、' '、'有'、'空'、'格' → '-'
  assert.ok(!keyWeird.includes('/'));

  // 段文件只落在自己的会话目录；其它会话目录不含本会话记录
  for (const relPath of result.segmentsWritten) {
    const parsed = parseSegmentRelativePath(relPath);
    assert.ok(parsed !== null);
    assert.equal(parsed.day, '2026-10-25');
    assert.ok(parsed.sessionKey === key1 || parsed.sessionKey === keyWeird);
    const lines = readSegmentLines(root, relPath);
    for (const line of lines) {
      const record = JSON.parse(line) as RawRecord;
      assert.equal(sanitizeSessionKey(record.sessionId), parsed.sessionKey);
      assert.equal(record.day, '2026-10-25');
    }
  }
  const sess1Segments = vault.segmentList.filter((segment) => segment.sessionId === 'sess_1');
  const weirdSegments = vault.segmentList.filter((segment) => segment.sessionId === weird);
  assert.equal(sess1Segments.length, 1);
  assert.equal(weirdSegments.length, 1);
  assert.ok(sess1Segments[0].segment.startsWith(`segments/2026-10-25/${key1}/`));
  assert.ok(weirdSegments[0].segment.startsWith(`segments/2026-10-25/${keyWeird}/`));
  assert.equal(sess1Segments[0].records, 3);
  assert.equal(weirdSegments[0].records, 1);
  // sess_1 的段文件里不能出现 weird 会话的记录
  const sess1Lines = readSegmentLines(root, sess1Segments[0].segment);
  assert.ok(sess1Lines.every((line) => (JSON.parse(line) as RawRecord).sessionId === 'sess_1'));

  // 全库哈希链仍全局连续（不因分目录断裂）
  assert.deepEqual(result.items.map((item) => item.record.seq), [1, 2, 3, 4]);
  for (let i = 1; i < 4; i += 1) {
    assert.equal(result.items[i].record.prevHash, result.items[i - 1].record.hash);
  }
  assert.deepEqual(await vault.verify(), { ok: true, checked: 4 });
  // 校验可以检测"记录跑到别的会话目录"
  assert.equal((await vault.list({ sessionId: 'sess_1' })).total, 3);
  assert.equal((await vault.list({ sessionId: weird })).total, 1);
  await vault.close();

  // 重新打开（同一 writer）：每个会话目录的段号继续递增（互不干扰）
  const reopened = await openTest(root, { writerId: 'w1a2b3c' });
  const appended = await reopened.append([mkInput({ ts: BASE_TS + 10, sessionId: 'sess_1' })]);
  assert.equal(appended.items[0].record.seq, 5);
  assert.match(
    appended.segmentsWritten[0],
    new RegExp(`^segments/2026-10-25/${key1}/seg-w[0-9a-f]{6}-000002\.jsonl$`),
  );
  assert.deepEqual(await reopened.verify(), { ok: true, checked: 5 });
  await reopened.close();
});

test('vault: sanitizeSessionKey keeps [A-Za-z0-9._-], caps at 80, guards traversal', () => {
  assert.equal(sanitizeSessionKey(null), '_no-session');
  assert.equal(sanitizeSessionKey(undefined), '_no-session');
  assert.equal(sanitizeSessionKey(''), '_no-session');
  assert.equal(sanitizeSessionKey('   '), '---');
  assert.equal(sanitizeSessionKey('..'), '_no-session');
  assert.equal(sanitizeSessionKey('a.b_c-d'), 'a.b_c-d');
  assert.equal(sanitizeSessionKey('a/b|c'), 'a-b-c');
  assert.equal(sanitizeSessionKey('会话 1'), '---1'); // 2 个汉字 + 空格 → '---'
  const long = 'x'.repeat(200);
  assert.equal(sanitizeSessionKey(long).length, 80);
  assert.equal(sanitizeSessionKey(`${long}.`).endsWith('.'), false);
});

// ---------------------------------------------------------------------------
// v1 旧布局兼容（只读；不迁移老文件）
// ---------------------------------------------------------------------------

test('vault: v1 layout stays readable and new appends go to v2 session dirs', async () => {
  const root = tmpRoot();
  const first = await openTest(root, { writerId: 'w1a2b3c' });
  const seed = await first.append([mkInput({ ts: BASE_TS, sessionId: 'sess_1' })]);
  await first.close();
  const v2Rel = seed.segmentsWritten[0];
  assert.match(v2Rel, /^segments\/2026-10-25\/sess_1\/seg-w1a2b3c-000001\.jsonl$/);

  // 手工降级为 v1 布局：文件移到 segments/<day>/<name>，VERSION 回写 "1"，删 manifest 强制重扫
  const v1Rel = 'segments/2026-10-25/seg-w1a2b3c-000001.jsonl';
  renameSync(segmentAbs(root, v2Rel), segmentAbs(root, v1Rel));
  rmSync(join(root, 'segments', '2026-10-25', 'sess_1'), { recursive: true, force: true });
  unlinkSync(join(root, 'manifest.json'));
  writeFileSync(join(root, 'VERSION'), '1\n');
  const v1Bytes = readFileSync(segmentAbs(root, v1Rel));

  const vault = await openTest(root, { writerId: 'w1a2b3c' });
  // reader 接受 VERSION=1，并只升级版本标记（老段文件原样保留）
  assert.equal(readFileSync(join(root, 'VERSION'), 'utf8'), '2\n');
  const manifest = await vault.manifest();
  assert.equal(manifest.segments.length, 1);
  assert.equal(manifest.segments[0].segment, v1Rel);
  assert.equal(manifest.segments[0].sessionId, null);
  assert.deepEqual(await vault.verify(), { ok: true, checked: 1 });
  assert.equal((await vault.list({ sessionId: 'sess_1' })).total, 1);

  // 新追加：链继续（prevHash = 旧段尾），文件写入 v2 会话目录
  const appended = await vault.append([mkInput({ ts: BASE_TS + 5000, sessionId: 'sess_1' })]);
  assert.equal(appended.items[0].record.seq, 2);
  assert.equal(appended.items[0].record.prevHash, seed.items[0].record.hash);
  assert.match(appended.segmentsWritten[0], /^segments\/2026-10-25\/sess_1\/seg-w1a2b3c-000001\.jsonl$/);
  assert.deepEqual(readFileSync(segmentAbs(root, v1Rel)), v1Bytes); // 旧段字节不变
  assert.deepEqual(await vault.verify(), { ok: true, checked: 2 });
  await vault.close();
});
