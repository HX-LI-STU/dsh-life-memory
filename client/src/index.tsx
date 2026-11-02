// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hanxustu (dsh-life-memory)
/**
 * dsh-life-memory —— Web（浏览器）客户端半边。
 *
 * 加载协议（DSH 0.2.1-rc.3 实测/官方模板 `templates/decoration/client.js`）：
 *   window.__ModuleLoader__.load({ id: '<包名>', factory(require) { ... return plugin } })
 * 构建时由 build.mjs 的 client 目标用 banner/footer 包出该形状；本文件只导出
 * Cordis 客户端插件对象 `{ name, inject, apply }`。
 *
 * 注册位置：
 * - `sidebar.panellist`（list, root）：侧栏全局面板图标，id = 'life-memory'；
 * - `main`（keyed, root）：点击图标后中央面板按同 id 分发的页面组件（全局页）；
 * - `conversation.view`（list, session，v5）：会话内「记忆库」页签，标准席位带 `sessionId`，
 *   用于本会话的记忆/人格开关（POST /session-config）。
 *   该 slot 由 `@deepseek-ai/dsh-client-ui-conversation` 声明；`slots.inject` 会等待声明，
 *   宿主未提供该插件时静默不注册，不影响 boot（feature-detect + try/catch）。
 * - `conversation.hero.options`（list，session 作用域，v5.1）：新建会话页 hero 设置行的
 *   「记忆 / 人格」开关 + 人格下拉，改的是**下一个新会话的默认值**
 *   （GET/POST `/session-config` 不带 sessionId，POST body 带 `defaults:true`）。
 *   Hero 页不读 sessionId、不做会话级写；同样 feature-detect + try/catch，注册失败只告警。
 *
 * 写操作范围（v5/v5.1）：仅 POST /personas、/personas/update、/personas/delete、
 * /personas/activate、/session-config；其余数据仍 GET-only（见 api.ts）。
 */
import { MemoryVaultPanel } from './panel.tsx';
import HeroOptions, { registerHeroOptions } from './views/hero-options.tsx';
import { SessionMemoryPanel } from './views/session-panel.tsx';
import { token, VaultIcon } from './theme.tsx';

/** 面板 id：同时在 sidebar.panellist 与 main 两个 slot 中使用 */
export const PANEL_ID = 'life-memory';

/** 侧栏/面板显示名（locale 无关的固定中文；面板内另有 Life Memory 副标题） */
const PANEL_LABEL = '记忆库';

/** 客户端 Context 最小接口（避免打包 DSH 类型包；运行时由宿主注入） */
interface SlotEntryOptions {
  name: string;
  id?: string;
  key?: string;
  order?: number;
  label?: string | (() => string);
  [key: string]: unknown;
}

interface SlotsLike {
  inject(key: string, callback: () => unknown): void;
  register(options: SlotEntryOptions, component: unknown): () => void;
}

interface ClientContextLike {
  slots?: SlotsLike;
}

/** 侧栏图标（ownerProps: { size, active }） */
function MemoryVaultSidebarIcon(props: { size?: number; active?: boolean }): JSX.Element {
  const size = typeof props.size === 'number' && props.size > 0 ? props.size : 20;
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: props.active === true ? token.brand : token.textSecondary,
        lineHeight: 0,
      }}
      title={PANEL_LABEL}
    >
      <VaultIcon size={size} />
    </span>
  );
}

function warn(message: string, error: unknown): void {
  try {
    // 只输出错误消息，绝不输出档案内容
    console.warn(`[dsh-life-memory] ${message}:`, error instanceof Error ? error.message : String(error));
  } catch {
    /* ignore */
  }
}

/**
 * Cordis 客户端插件入口：把只读面板挂到侧栏 + 中央面板。
 * 任何注册失败都只告警（宿主 Web UI 不受影响）。
 */
export function apply(ctx: ClientContextLike): void {
  const slots = ctx?.slots;
  if (!slots || typeof slots.inject !== 'function' || typeof slots.register !== 'function') {
    warn('slots 服务不可用，记忆库面板未挂载', new Error('missing ctx.slots'));
    return;
  }

  try {
    slots.inject('sidebar.panellist', () =>
      slots.register(
        {
          name: 'sidebar.panellist',
          id: PANEL_ID,
          order: 40,
          label: () => PANEL_LABEL,
        },
        MemoryVaultSidebarIcon,
      ),
    );
  } catch (error) {
    warn('侧栏入口注册失败', error);
  }

  try {
    slots.inject('main', () =>
      slots.register(
        {
          name: 'main',
          key: PANEL_ID,
        },
        MemoryVaultPanel,
      ),
    );
  } catch (error) {
    warn('主面板注册失败', error);
  }

  // v5：会话内「记忆库」页签（session 作用域；标准席位带 sessionId）。
  // feature-detect：宿主无 conversation 插件/slot 未声明时 slots.inject 不会回调，
  // 注册失败只告警，绝不影响 boot 与全局面板。
  try {
    slots.inject('conversation.view', () =>
      slots.register(
        {
          name: 'conversation.view',
          id: 'life-memory-session',
          order: 60,
          label: () => PANEL_LABEL,
        },
        SessionMemoryPanel,
      ),
    );
  } catch (error) {
    warn('会话内记忆库页签注册失败（不影响全局面板）', error);
  }

  // v5.1：新建会话页 hero 设置行的「新会话默认」（记忆/人格开关 + 人格下拉）。
  // 只写"下一个新会话默认"，不读 sessionId、不做会话级写；slot 未声明/注册失败均只告警。
  try {
    registerHeroOptions(slots, warn);
  } catch (error) {
    warn('新建会话 hero 选项注册失败（不影响 boot）', error);
  }
}

/** 插件名（Loader 诊断用；必须与 package.json name 一致） */
export const name = 'dsh-life-memory';

/** 依赖的客户端服务：slots（面板/页签注册必需） */
export const inject = ['slots'];

export { MemoryVaultPanel, SessionMemoryPanel, HeroOptions };
