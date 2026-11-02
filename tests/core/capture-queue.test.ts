/** 捕获队列测试（fake vault/store，验证批量、幂等、重试、关闭） */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CaptureQueue } from '../../src/capture/queue.ts';
import { createLogger, silentLogger } from '../../src/core/logger.ts';
import { DEFAULT_CAPTURE } from '../../src/config.ts';
import type {
  AppendResult,
  RawAppendItem,
  RawRecord,
  RawRecordInput,
  RawVault,
  RawQuery,
  VerifyResult,
  VaultStats,
  VaultManifest,
} from '../../src/core/contracts.ts';

function rawInput(i: number, ingestKey?: string): RawRecordInput {
  return {
    kind: 'user',
    ts: 1761390000000 + i,
    timezone: 'Asia/Shanghai',
    sessionId: 's1',
    text: `msg ${i}`,
    payload: { type: 'user/message', n: i },
    ingestKey: ingestKey ?? `s1:${i}`,
  };
}

class FakeVault implements RawVault {
  appended: RawRecordInput[] = [];
  failNext = 0;
  appendDelayMs = 0;
  seen = new Set<string>();

  async append(batch: RawRecordInput[]): Promise<AppendResult> {
    if (this.appendDelayMs) await new Promise((r) => setTimeout(r, this.appendDelayMs));
    if (this.failNext > 0) {
      this.failNext -= 1;
      throw new Error('simulated disk failure');
    }
    const items: RawAppendItem[] = [];
    let skipped = 0;
    batch.forEach((input, idx) => {
      const key = input.ingestKey ?? `auto:${input.ts}:${idx}`;
      if (this.seen.has(key)) {
        skipped += 1;
        return;
      }
      this.seen.add(key);
      this.appended.push(input);
      const seq = this.appended.length;
      const record: RawRecord = {
        ...input,
        id: `2026-10-25-${String(seq).padStart(6, '0')}`,
        day: '2026-10-25',
        seq,
        iso: new Date(input.ts).toISOString(),
        hash: 'h'.repeat(64),
        prevHash: '0'.repeat(64),
        v: 1,
      };
      items.push({ record, location: { ingestKey: key, segment: 'segments/2026-10-25/seg-w000001-000001.jsonl', lineNo: seq, byteOffset: 0, byteLen: 100 } });
    });
    return { items, skipped, segmentsWritten: items.length ? ['segments/2026-10-25/seg-w000001-000001.jsonl'] : [] };
  }

  async get(): Promise<RawRecord | null> {
    return null;
  }
  async list(_q?: RawQuery): Promise<{ records: RawRecord[]; total: number }> {
    return { records: [], total: 0 };
  }
  async *iterate(): AsyncIterable<RawRecord> {}
  async verify(): Promise<VerifyResult> {
    return { ok: true, checked: 0 };
  }
  async stats(): Promise<VaultStats> {
    return { records: this.appended.length, segments: 1, days: 1, bytes: 0 };
  }
  async manifest(): Promise<VaultManifest> {
    return {
      formatVersion: 1,
      vaultId: 'test',
      updatedAt: 0,
      segments: [],
      stats: { records: this.appended.length, days: 1, bytes: 0 },
    };
  }
  async close(): Promise<void> {}
}

class FakeStore {
  rows = new Map<string, string>();
  indexed: string[] = [];
  hasRawIngestKey(key: string): boolean {
    return this.rows.has(key);
  }
  indexRawRecords(items: RawAppendItem[]): void {
    for (const item of items) {
      this.rows.set(item.location.ingestKey, item.record.id);
      this.indexed.push(item.record.id);
    }
  }
}

function makeQueue(opts: { maxBatchSize?: number; flushIntervalMs?: number } = {}) {
  const vault = new FakeVault();
  const store = new FakeStore();
  const derived: RawAppendItem[] = [];
  const queue = new CaptureQueue({
    vault,
    store,
    config: { ...DEFAULT_CAPTURE, maxBatchSize: opts.maxBatchSize ?? 64, flushIntervalMs: opts.flushIntervalMs ?? 5 },
    logger: silentLogger,
    onAppended: (items) => {
      derived.push(...items);
    },
  });
  return { vault, store, derived, queue };
}

test('queue: 批量 flush 与镜像索引', async () => {
  const { vault, store, derived, queue } = makeQueue();
  await queue.ingest([rawInput(1), rawInput(2), rawInput(3)]);
  assert.equal(vault.appended.length, 0, '未到 maxBatchSize 时应走定时器，不立即写');
  await queue.flush();
  assert.equal(vault.appended.length, 3);
  assert.equal(store.indexed.length, 3);
  assert.equal(derived.length, 3);
  assert.equal(queue.stats().captured, 3);
  await queue.close();
});

test('queue: 达到 maxBatchSize 立即落盘并返回记录', async () => {
  const { vault, queue } = makeQueue({ maxBatchSize: 2 });
  const records = await queue.ingest([rawInput(1), rawInput(2)]);
  assert.equal(records.length, 2);
  assert.equal(vault.appended.length, 2);
  await queue.close();
});

test('queue: 已索引的 ingestKey 被跳过（幂等）', async () => {
  const { vault, store, queue } = makeQueue({ maxBatchSize: 2 });
  await queue.ingest([rawInput(1), rawInput(2)]);
  await queue.ingest([rawInput(2), rawInput(3)]);
  await queue.flush();
  assert.deepEqual(
    vault.appended.map((r) => r.ingestKey),
    ['s1:1', 's1:2', 's1:3'],
  );
  assert.equal(store.rows.size, 3);
  await queue.close();
});

test('queue: 写失败整批重入队，下次 flush 重试成功', async () => {
  const { vault, queue } = makeQueue({ maxBatchSize: 2 });
  vault.failNext = 1;
  await queue.ingest([rawInput(1)]);
  // flush 自身不抛错（宿主钩子内 fire-and-forget），错误记录在 stats.failed 并重入队
  await queue.flush();
  assert.equal(queue.stats().failed, 1);
  assert.equal(queue.stats().queued, 1);
  assert.equal(vault.appended.length, 0);
  await queue.flush();
  assert.equal(vault.appended.length, 1);
  assert.equal(queue.stats().captured, 1);
  await queue.close();
});

test('queue: close 前 flush 中内容', async () => {
  const { vault, queue } = makeQueue();
  await queue.ingest([rawInput(7)]);
  await queue.close();
  assert.equal(vault.appended.length, 1, 'close() 必须把缓冲写入');
  await assert.rejects(() => queue.ingest([rawInput(8)]), /closed/);
});

test('queue: onAppended 抛错不影响落盘', async () => {
  const vault = new FakeVault();
  const store = new FakeStore();
  const queue = new CaptureQueue({
    vault,
    store,
    config: { ...DEFAULT_CAPTURE, maxBatchSize: 1, flushIntervalMs: 5 },
    logger: createLogger({ level: 'error' }),
    onAppended: () => {
      throw new Error('derive boom');
    },
  });
  await queue.ingest([rawInput(1)]);
  assert.equal(vault.appended.length, 1);
  await queue.close();
});

test('queue: 定时器自动 flush', async () => {
  const { vault, queue } = makeQueue({ flushIntervalMs: 5 });
  await queue.ingest([rawInput(1)]);
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(vault.appended.length, 1);
  await queue.close();
});
