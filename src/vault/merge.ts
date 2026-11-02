// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hanxustu (dsh-life-memory)
/**
 * 通用 k 路归并（async iterable，内存有界）：
 * 用于把多个段文件的记录按 seq 顺序合并成全局有序流（升序或降序），
 * 是 `RawVault.list/iterate/verify` 的实现基础。
 *
 * 前提：每个输入迭代器自身已按 compare 升序产出。
 * 复杂度：O(N log K)，内存 O(K)（K = 段文件数，每个段保持一个当前值）。
 */

interface HeapNode<T> {
  value: T;
  sourceIndex: number;
  iterator: AsyncIterator<T>;
}

/** 简单二叉最小堆（按 compare） */
class MinHeap<T> {
  private readonly items: HeapNode<T>[] = [];
  private readonly compare: (a: T, b: T) => number;

  constructor(compare: (a: T, b: T) => number) {
    this.compare = compare;
  }

  get size(): number {
    return this.items.length;
  }

  push(node: HeapNode<T>): void {
    const items = this.items;
    items.push(node);
    let index = items.length - 1;
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (this.compare(items[parent].value, items[index].value) <= 0) break;
      [items[parent], items[index]] = [items[index], items[parent]];
      index = parent;
    }
  }

  pop(): HeapNode<T> | undefined {
    const items = this.items;
    if (items.length === 0) return undefined;
    const top = items[0];
    const last = items.pop() as HeapNode<T>;
    if (items.length > 0) {
      items[0] = last;
      let index = 0;
      for (;;) {
        const left = index * 2 + 1;
        const right = left + 1;
        let smallest = index;
        if (left < items.length && this.compare(items[left].value, items[smallest].value) < 0) {
          smallest = left;
        }
        if (right < items.length && this.compare(items[right].value, items[smallest].value) < 0) {
          smallest = right;
        }
        if (smallest === index) break;
        [items[smallest], items[index]] = [items[index], items[smallest]];
        index = smallest;
      }
    }
    return top;
  }
}

/**
 * 合并多个已排序 async iterable 为一个有序 async generator。
 * @param sources 每个 source 已按 compare 升序
 * @param compare 返回 <0 表示 a 先于 b
 */
export async function* mergeSortedAsync<T>(
  sources: readonly AsyncIterable<T>[],
  compare: (a: T, b: T) => number,
): AsyncGenerator<T> {
  const heap = new MinHeap<T>(compare);
  const iterators: AsyncIterator<T>[] = [];
  try {
    for (let i = 0; i < sources.length; i += 1) {
      const iterator = sources[i][Symbol.asyncIterator]();
      iterators.push(iterator);
      const next = await iterator.next();
      if (!next.done) heap.push({ value: next.value, sourceIndex: i, iterator });
    }
    while (heap.size > 0) {
      const node = heap.pop() as HeapNode<T>;
      yield node.value;
      const next = await node.iterator.next();
      if (!next.done) heap.push({ value: next.value, sourceIndex: node.sourceIndex, iterator: node.iterator });
    }
  } finally {
    // 提前退出（消费方 break）时关闭未完成的迭代器
    for (const iterator of iterators) {
      try {
        await iterator.return?.(undefined);
      } catch {
        /* ignore */
      }
    }
  }
}
