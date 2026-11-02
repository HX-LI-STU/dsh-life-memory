/** 捕获映射器单元测试（纯函数，无宿主依赖） */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  contentToText,
  ingestKeyOf,
  isExcludedWorkspace,
  kindOfEvent,
  mapSessionEvent,
  mapSessionEvents,
  roleOfEvent,
  sessionHeaderToRawInput,
  shouldCapture,
} from '../../src/capture/mapper.ts';
import type { DshSessionEventLike, DshSessionLike } from '../../src/capture/dsh-types.ts';
import { DEFAULT_CAPTURE } from '../../src/config.ts';

const session: DshSessionLike = {
  id: 'sess-01',
  header: { createdAt: 1761390000000, cwd: 'D:\\work\\proj' },
};

const baseOptions = { timezone: 'Asia/Shanghai', capture: { ...DEFAULT_CAPTURE } };

function ev(type: string, seq: number, data: Record<string, unknown>, time = 1761390000123): DshSessionEventLike {
  return { type, seq, time, data };
}

test('map: user message 无损 payload + text + injected 标签', () => {
  const event = ev('user/message', 3, {
    role: 'user',
    id: 'm1',
    source: { kind: 'agent.inject' },
    content: [
      { type: 'text', text: '把主题改成深色' },
      { type: 'image', attachment: { id: 'img1' } },
    ],
  });
  const input = mapSessionEvent(session, event, baseOptions);
  assert.ok(input);
  assert.equal(input.kind, 'user');
  assert.equal(input.role, 'user');
  assert.equal(input.sessionId, 'sess-01');
  assert.equal(input.workspace, 'D:\\work\\proj');
  assert.equal(input.turnId, null);
  assert.match(input.text!, /把主题改成深色/);
  assert.match(input.text!, /\[image\]/);
  assert.ok(input.tags?.includes('injected'));
  assert.ok(input.tags?.includes('source:agent.inject'));
  assert.equal(input.ingestKey, 'sess-01:3');
  // payload 必须原样保存完整事件（无损）
  assert.deepEqual(input.payload, event);
  assert.deepEqual(JSON.parse(JSON.stringify(input.payload)), JSON.parse(JSON.stringify(event)));
});

test('map: assistant 默认不把 reasoning 放进 text，但 payload 保留', () => {
  const event = ev('assistant/message', 7, {
    turn: 2,
    step: 1,
    message: {
      role: 'assistant',
      content: [
        { type: 'reasoning', text: '用户想要深色主题，我应该……' },
        { type: 'text', text: '好的，已为你设置深色主题。' },
        { type: 'tool-call', id: 'c1', name: 'fs_edit', arguments: '{"path":"x"}' },
      ],
    },
    stream: [{ type: 'text-delta', text: '好的' }],
    usage: { inputTokens: 10, outputTokens: 20 },
  });
  const input = mapSessionEvent(session, event, baseOptions)!;
  assert.equal(input.kind, 'assistant');
  assert.equal(input.turnId, '2');
  assert.equal(input.stepId, '1');
  assert.ok(!input.text!.includes('用户想要深色主题'));
  assert.ok(input.text!.includes('已为你设置深色主题'));
  assert.ok(input.text!.includes('[tool_call] fs_edit'));
  assert.ok(input.tags?.includes('has-usage'));
  const withReasoning = mapSessionEvent(session, event, { ...baseOptions, includeReasoningInText: true })!;
  assert.ok(withReasoning.text!.includes('用户想要深色主题'));
});

test('map: tool/call 与 tool/result', () => {
  const call = mapSessionEvent(session, ev('tool/call', 9, { turn: 1, step: 2, callId: 'c9', name: 'bash', arguments: '{"command":"ls"}' }), baseOptions)!;
  assert.equal(call.kind, 'tool_call');
  assert.ok(call.text!.includes('[tool_call] bash'));
  assert.ok(call.tags?.includes('tool:bash'));

  const result = mapSessionEvent(
    session,
    ev('tool/result', 10, {
      turn: 1,
      step: 2,
      callId: 'c9',
      message: { role: 'tool', toolCallId: 'c9', isError: true, content: [{ type: 'text', text: 'command not found' }] },
    }),
    baseOptions,
  )!;
  assert.equal(result.kind, 'tool_result');
  assert.ok(result.text!.includes('command not found'));
  assert.ok(result.tags?.includes('tool-error'));
  assert.ok(result.tags?.includes('call:c9'));
});

test('map: 结构事件/turn/plugin record', () => {
  assert.equal(kindOfEvent(ev('turn/start', 1, { turn: 1 })), 'turn');
  assert.equal(kindOfEvent(ev('step/start', 2, { turn: 1, step: 1 })), 'event');
  assert.equal(kindOfEvent(ev('plugin:dsh-compaction/start', 3, {})), 'compaction');
  assert.equal(kindOfEvent(ev('plugin:vendor/foo', 4, {})), 'event');
  assert.equal(kindOfEvent(ev('request/header', 5, {})), 'system');
  assert.equal(roleOfEvent(ev('tool/call', 6, {})), 'tool');
  assert.equal(roleOfEvent(ev('turn/start', 7, {})), null);

  const turnEnd = mapSessionEvent(session, ev('turn/end', 8, { turn: 1, reason: { kind: 'completed' } }), baseOptions)!;
  assert.equal(turnEnd.kind, 'turn');
  assert.ok(turnEnd.tags?.includes('turn-end:completed'));
  assert.equal(turnEnd.text, null);

  const header = mapSessionEvent(session, ev('request/header', 11, { header: { config: { model: 'x' } }, reason: 'initial' }), baseOptions)!;
  assert.equal(header.kind, 'system');
  assert.ok(header.tags?.includes('request-header'));
  assert.deepEqual(header.payload, ev('request/header', 11, { header: { config: { model: 'x' } }, reason: 'initial' }));
});

test('map: capture 开关过滤，但结构事件始终保留', () => {
  const off = { ...DEFAULT_CAPTURE, userMessages: false, toolResults: false };
  assert.equal(shouldCapture(ev('user/message', 1, {}), off), false);
  assert.equal(shouldCapture(ev('tool/result', 2, {}), off), false);
  assert.equal(shouldCapture(ev('turn/start', 3, {}), off), true);
  assert.equal(mapSessionEvent(session, ev('user/message', 1, { content: [] }), { ...baseOptions, capture: off }), null);
});

test('map: excludeWorkspaces 前缀匹配', () => {
  assert.equal(isExcludedWorkspace('D:\\work\\secret', ['D:/work/secret']), true);
  assert.equal(isExcludedWorkspace('D:\\work\\secret2', ['D:/work/secret']), false);
  assert.equal(isExcludedWorkspace('D:\\WORK\\SECRET\\sub', ['d:/work/secret']), true);
  assert.deepEqual(
    mapSessionEvents(session, [ev('user/message', 1, { content: [{ type: 'text', text: 'hi' }] })], {
      ...baseOptions,
      capture: { ...DEFAULT_CAPTURE, excludeWorkspaces: ['D:\\work\\proj'] },
    }),
    [],
  );
});

test('map: sessionHeaderToRawInput 与 ingestKey 回退', () => {
  const header = sessionHeaderToRawInput(session, { timezone: 'Asia/Shanghai', now: 1761390000999 });
  assert.equal(header.kind, 'session');
  assert.equal(header.ts, 1761390000000);
  assert.equal(header.ingestKey, 'sess-01:header');
  assert.equal(header.workspace, 'D:\\work\\proj');

  const noSeq = { type: 'user/message', time: 1761390000123, data: { content: [{ type: 'text', text: '你好' }] } } as never as DshSessionEventLike;
  const key1 = ingestKeyOf('s1', noSeq, 'user', 'user', '你好');
  const key2 = ingestKeyOf('s1', noSeq, 'user', 'user', '你好');
  const key3 = ingestKeyOf('s1', noSeq, 'user', 'user', '你好！');
  assert.match(key1, /^h:[0-9a-f]{64}$/);
  assert.equal(key1, key2);
  assert.notEqual(key1, key3);
});

test('contentToText: 未知块与空内容', () => {
  assert.equal(contentToText([]), null);
  assert.equal(contentToText([{ type: 'reasoning', text: 'x' }]), null);
  assert.equal(contentToText([{ type: 'reasoning', text: 'x' }], { includeReasoning: true }), '[reasoning] x');
  assert.equal(contentToText([{ type: 'unknown-block' } as never]), '[unknown-block]');
  assert.equal(contentToText([{ type: 'text', text: '  ' }]), null);
});
