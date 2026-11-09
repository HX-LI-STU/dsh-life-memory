# dsh-life-memory · 记忆库

> 为 **DeepSeek Harness（DSH）** 提供持久、可审计的记忆：不可变原始档案 + 本地 SQLite + 分层记忆 + 人格独立记忆库。

<p>
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-green.svg"></a>
  <img alt="DSH plugin" src="https://img.shields.io/badge/DSH-plugin-blue.svg">
  <img alt="Node" src="https://img.shields.io/badge/node-%5E22.19%20%7C%7C%20%3E%3D24-brightgreen.svg">
</p>

[English](README.md)

**版本：v1.2.0**

DSH 的会话是短命的：关掉窗口，上下文就没了。`dsh-life-memory` 为 Agent 提供跨会话、跨重启的长期（理论上可终身）记忆，并把"真正发生过什么"（不可变原始记录）与"模型当前想起来什么"（可重建、可遗忘的派生记忆）严格分开。

- **原始优先**：每条捕获的事件追加写入不可变 L0 档案，永不改写、不静默删除。
- **派生可重建**：工作/情景/语义记忆存放在 SQLite，任何时候都能从 L0 重新生成。
- **本地优先**：数据只在本机，无遥测、无外部数据库；远程嵌入必须显式开启。
- **按范围隔离**：记忆按会话分组；每个人格拥有完全独立的记忆库（含原始数据与数据库）。
- **长期保存**：记忆随对话增长，实际上限只取决于磁盘空间；原始会话不会被记忆系统自动删除。
- **可共享**：使用共享库的会话之间共享记忆；同一人格的所有会话共享该人格库；不同人格之间相互隔离。
- **低上下文成本**：每次提示只注入精简画像与当前会话工作记忆，细节按需从原始/向量库取回，而不是塞进每一轮上下文。
- **开启记忆不丢历史**：开启记忆/人格时会弹窗询问是否补档本会话已有历史（包括你之前发送的消息），每次开启在弹窗中选择。关闭记忆只停止后续捕获，已归档 L0 记录不会被删除。

---

## 设计理念：长期记忆 + 低上下文依赖

`dsh-life-memory` 的核心出发点：模型不需要把**所有**旧对话都放进上下文，它只需要在需要时能重新找到这些对话。

- **永不删除的原始会话**：每个会话都以追加、哈希链方式归档；原始档案是事实来源，永不重写，只有人工显式删除才会移除。
- **向量 + 关键词索引原始会话**：每条原始记录都有嵌入向量，并用 FTS5 建索引，模型可以按关键词或语义检索原始对话。
- **记忆可共享、但有作用域**：共享库在多个会话之间共享；人格库在该人格的所有会话之间共享；不同人格与共享库之间相互隔离。
- **低上下文依赖**：提示中只注入精简的语义画像、少量工作记忆和人格块；其余内容按需检索，即使积累多年历史，上下文窗口也能保持较小。
- **手动恢复记忆**：你可以直接告诉模型"去向量库里查一下原始会话里关于 X 的内容"，它会调用 `memory_recall`（显式模式）检索 L0 + 原始层永久向量索引，必要时再用 `memory_get_raw` 取原文。

> 经验法则：日常让插件自动维护精简记忆；需要旧对话的原文时，再显式让模型去检索。

## 功能特性

### 记忆架构

- **默认精简记录**：只归档你发送的最终输入与助手最终回复；思考、工具调用/结果、系统事件默认不记录。需要全量时，打开「记录完整原始事件」开关（会话面板与新会话页都有）。
- **不可变原始档案（L0）**
  - 追加式 JSONL 段文件 + 全局 SHA-256 哈希链 + manifest。
  - 原始段文件**按会话物理分开**（`segments/<日期>/<sessionKey>/`），不同会话不会混写。
  - `memory_recall`（explicit 模式）、`memory_get_raw`、面板浏览都以原始记录为准，永不改写。
- **SQLite 派生库**（`node:sqlite`，WAL）
  - `raw_index` 镜像 L0，FTS5 全文检索 + 向量检索（余弦）+ 向量缓存。
  - 默认使用完全离线的本地哈希嵌入（`dsh-local-hash-v1`，512 维）；可选 OpenAI 兼容嵌入（需显式开启联网）。
- **两套正交的记忆模型**
  - **内容层**：L1 工作记忆 → L2 情景摘要 → L3 语义画像（偏好/事实/决策/画像）。
  - **保留期分层**：短期 → 中期 → 长期，可配置晋升规则、钉住、遗忘（短期到期删除、中期归档）；长期/钉住记忆不会被删除。
- **访问与遗忘分离**
  - 显式检索读取**不可变原始层 + 原始层永久向量索引**（永不遗忘）。
  - 隐式上下文读取**派生三层记忆**（可遗忘），让注入 prompt 保持精简。
- **保守的语义抽取**
  - L3 只从**用户消息**与**显式 `memory_save`** 抽取；工具输出、助手代码块、URL 等噪声来源会被过滤。
  - L2 → L3 晋升要求来源记录可信。

### 人格（Persona）

- **Markdown 定义人格**：`<DSH_HOME>/personas/<id>.md`，frontmatter（`name`、`description`、`tags`、`aliases`）+ 正文作为 system prompt。
- **热重载**：修改/新增人格文件后，无需重启 DSH 即可刷新名单。
- **面板 CRUD**：在「人格」页签新建、编辑、删除（移入 `.trash/`，可恢复）、激活。
- **独立记忆库**：每个人格拥有自己的原始段文件、SQLite、向量、保留期与遗忘状态；人格 A 看不到人格 B 或共享库的数据（原始数据也不共享）。
- **共享记忆库**：未使用人格/关闭人格的会话使用 `<dataDir>/vaults/shared/`。
- **严格校验**：非法人格会给出具体原因；正文包含完整 `{{…}}` 模板组会被拒绝。

### 会话级控制

- **按会话开关**：`memory`（记忆）与 `persona`（人格）可分别开关，按 `sessionId` 持久化。
- **新会话默认值**：默认记忆**开**、人格**关**（共享库），可在新建会话页底部修改。
- **语义**：开启人格会强制开启记忆；关闭记忆后该会话停止捕获/注入，但档案仍可只读浏览。
- **当前会话 id**：会话内「记忆库」页签顶部会显示完整 sessionId，并提供复制按钮。

### 面板

侧栏「记忆库」提供 8 个页签：

| 页签 | 内容 |
| --- | --- |
| 概览 | 健康状态、原始档案统计、保留/遗忘统计、当前库、新会话默认、数据保留提示 |
| 记忆分层 | 短期/中期/长期数量、晋升与遗忘状态 |
| 人格 | 人格名单、新建/编辑/删除/激活、每个人格的记忆数量 |
| 原始记忆 | 分页浏览 L0、会话/人格元数据、哈希校验 |
| 层统计 | 按人格统计 L1/L2/L3 |
| 搜索 | 显式（原始层）与隐式（派生层）检索 |
| 导入导出 | 会话/整库导出导入、重建原始索引 |
| 健康/完整性 | 哈希链校验、manifest、存储健康 |

面板以只读浏览为主，仅人格编辑、会话/新会话设置与导入导出为写操作。

### 导入导出（只追加）

- **会话归档（JSONL）**：header + 完整 L0 记录 + 可选派生记忆行。导入会分配**新** sessionId、追加新记录，并在 payload 中记录 `importedFrom` / `originalSessionId`。
- **整库归档**：`VERSION`、`manifest.json`、`vault.db`（含 WAL）、`segments/**`；内容可选**全部 / 仅数据库 / 仅原始记忆**。
- **绝不破坏已有数据**：导入不删除、不覆盖、不修改任何已有记忆；整库导入必须使用**新库 id**；仅原始记忆导入会自动从 L0 重建 SQLite 索引。
- **重构原始数据库**：从不可变 L0 对账/补齐 `raw_index`（只增不删），适合导入后或怀疑索引缺失时使用。

### 工具与 HTTP API

- **17 个 Agent 工具**：检索、保存、状态、原始记录、层统计、人格 CRUD、会话开关、会话/整库导入导出。
- **HTTP API**：面板使用 16 条 `GET` + 7 条 `POST`（同源、JSON 包络）。
- **零运行时依赖**：只使用 Node.js 内置模块（`node:sqlite`、`node:crypto`、`node:fs`）。

---

## 工作原理

```
DSH 会话事件 ──► 捕获队列 ──► L0 原始档案（追加、哈希链、按会话分目录）
                                    │ 派生
                                    ▼
                     SQLite：raw_index + L1/L2/L3 + FTS5 + 向量
                                    │
                    ┌───────────────┴───────────────┐
                    ▼                               ▼
           prompt 上下文（隐式记忆）          记忆工具 / HTTP 面板
                    ▲
          显式检索直接读 L0（永不遗忘）
```

1. **捕获**：会话事件（消息、工具调用/结果、笔记）追加写入原始档案。
2. **派生**：队列构建 L1 原子、L2 情景摘要、L3 语义记忆；保留期晋升与遗忘由定时器执行。
3. **服务**：prompt 注入人格身份块与精简记忆上下文；工具/HTTP 提供检索与查看能力。
4. **作用域**：每次操作根据会话配置解析记忆库（共享库或某人格库），并按 sessionId 分组。

---

## 环境要求

- **DeepSeek Harness 桌面版** `0.2.1-rc.3` 及以上（在 Windows 上测试过 `0.2.1-rc.3` … `0.2.1-rc.5`）。
- Node.js **22.19+ 或 24+** 运行时（插件使用 `node:sqlite`；DSH 自带兼容运行时）。
- 可写的 DSH home 目录。

---

## 安装

### 从发布包安装

仓库根目录已包含可直接安装的压缩包：`dsh-life-memory-1.2.0.tgz`（也可从 GitHub Releases 下载）。

> **安装前：先完全退出 DSH Desktop。** 如果是全新 DSH，请先启动一次 DSH Desktop 初始化 `desktop` profile，再退出（CLI 会初始化/使用 profile，但安装时不要让运行中的应用占用 profile）。

```bash
dsh plugin --profile desktop add "./dsh-life-memory-1.2.0.tgz"   # 桌面版 profile
# 或：dsh plugin --profile web add "./dsh-life-memory-1.2.0.tgz"
```

若 `dsh` 不在 `PATH`，使用 DSH 自带 CLI（Windows：`resources/runtime/cli/bin/dsh.cmd`）。安装后重新启动 DSH Desktop——插件在启动时加载，侧栏会出现「记忆库」。

### 从源码构建

```bash
npm install
npm run build           # 生成 lib/index.js（宿主）与 lib/client.js（Web 面板）
npm run pack:release    # 生成 dsh-life-memory-1.2.0.tgz（包内 README 为简明使用指南）
dsh plugin --profile desktop add ./dsh-life-memory-1.2.0.tgz
```

包内 README 是简明的安装/使用指南（`docs/PACKAGE_README.zh-CN.md`）；仓库 README 继续保留完整项目文档。

### 开发

```bash
npm run typecheck    # TypeScript 类型检查
npm run build        # 宿主 + 客户端构建
```

---

## 快速开始

1. 安装并重启 DSH，从侧栏打开「记忆库」。
2. 正常聊天——会话事件会被自动捕获，派生记忆在后台生成。
3. 明确让 Agent 记住：

   > “记住：这个项目使用 TypeScript ESM，构建用 `npm run build`。”

   这会调用 `memory_save`，保存为显式 L3 记忆。
4. 使用 `memory_recall`（或直接问“之前我们约定过什么？”）——显式检索会查 L0 与永久向量索引。
5. 打开「人格」页签，新建一个人格并点「使用此人格」——该人格拥有独立记忆库，其正文会作为身份块注入。
6. 在任意会话内打开「记忆库」页签，可只针对该会话开关记忆/人格。
7. 新建会话页底部的「新会话默认」控制下一个会话的默认值。

---

## 可以用它做什么

- **跨会话的项目记忆**：决策、约定、命令、API 契约、偏好等跨重启保留。
- **多个人格、各自记忆**：生活助理人格与编码人格的原始数据、派生记忆互不混合。
- **按会话隔离**：临时对话可关闭记忆；只在合适的地方启用某个人格。
- **审计与检查**：浏览每条原始记录、校验哈希链、检查派生关系。
- **搜索**：对原始层与派生层做 FTS5（支持中文）与向量检索。
- **备份/迁移**：导出单会话或整库，换机器导入，不触碰已有历史。
- **恢复/重建**：数据库丢失或不同步时，从 L0 重建 SQLite 原始索引。
- **扩展**：层注册表与 SQLite schema 支持新增层；人格就是普通 markdown 文件。

---

## 如何找回旧记忆

模型拥有专门的工具：

```text
你：去原始会话里查一下"部署端口"，把原话找出来
模型 -> memory_recall({ query: "部署端口", mode: "explicit", limit: 8 })
     -> memory_get_raw({ id: "<raw id>" }) 需要原文时
```

- `memory_recall` 显式模式检索**不可变 L0 原始档案 + 原始层向量索引**并返回引用；隐式模式检索派生层。
- 人格会话仍可按需读取共享库：给 `memory_recall` / `memory_get_raw` 传 `vault: "shared"`（其它人格库依旧不可访问）；面板的 `?vault=shared` 查询同样可用于只读查看。
- `memory_get_raw` 返回完整原始记录并校验哈希。
- 结果带有会话与人格元数据，模型能知道某条记忆属于哪个会话。
- 原始数据永不删除，因此只要档案还在，旧会话随时可以这样恢复（实际限制只有磁盘空间）。

## 人格

人格是 `<DSH_HOME>/personas/` 下的单个 markdown 文件：

```markdown
---
name: 小狸
description: 生活助理人格
tags: [assistant]
aliases: [xiaoli]
---

你是一个细心、简洁的生活助理。回答中文，先给结论，再给必要的解释。
```

- 正文会成为 system prompt 中的人格身份块。
- `id` 即文件名（不含 `.md`），也可用 `memory_persona_create` 显式指定。
- 非法人格（空正文、frontmatter 错误、完整 `{{…}}` 模板组）会被标记无效并给出原因，不能激活。
- 激活人格会切换默认记忆库；单个会话的覆盖配置保存在会话配置中。

---

## 会话配置

会话配置（`session-config.json`）按会话保存（默认 `memory=true`、`persona=false`）：

| 字段 | 含义 |
| --- | --- |
| `memoryEnabled` | 本会话是否捕获 + 召回 + 注入 |
| `personaEnabled` | 使用人格库而非共享库 |
| `personaId` | 本会话指定人格（`null` = 跟随全局激活人格） |

新会话默认值也保存在同一文件；会话内「记忆库」页签、新建会话页底部都会通过 `memory_session_config` / `POST /session-config` 写入。

---

## 记忆工具

| 工具 | 作用 |
| --- | --- |
| `memory_recall` | 显式（L0 + 原始向量）或隐式（派生层）检索 |
| `memory_save` | 显式保存记忆（L3，默认钉住） |
| `memory_status` | 库、存储、层、捕获/派生、保留期、向量、人格、会话状态 |
| `memory_get_raw` | 读取原始记录并校验哈希 |
| `memory_layers` | 层注册表与数量 |
| `memory_persona_list` | 人格名单 |
| `memory_persona_use` | 激活人格（`null` 取消） |
| `memory_persona_current` | 当前人格 |
| `memory_persona_reload` | 从磁盘重新加载人格文件 |
| `memory_persona_create` | 创建人格 markdown |
| `memory_persona_update` | 编辑人格 |
| `memory_persona_delete` | 删除人格（移入 `.trash/` 可恢复） |
| `memory_session_config` | 读写会话开关 |
| `memory_export_session` | 导出会话原始归档（JSONL） |
| `memory_import_session` | 导入会话归档（只追加、新 sessionId） |
| `memory_export_vault` | 导出整库（全部 / 仅数据库 / 仅原始记忆） |
| `memory_import_vault` | 导入整库归档为新库 id |

---

## HTTP API

面板通过同源 `/api/life-memory` 访问（可用 `http.basePath` 配置）。

**GET（16 条）**：`health`、`status`、`layers`、`stats-layers`、`raw`、`raw-detail`、`raw-verify`、`memories`、`memory-detail`、`search`、`manifest`、`integrity`、`retention`、`personas`、`vaults`、`session-config`。

**POST（7 条）**：`personas`、`personas/update`、`personas/delete`、`personas/activate`、`session-config`、`transfer`、`rebuild`。

响应格式：`{ ok: true, data: … }` / `{ ok: false, error: { code, message } }`。写接口需要 DSH 同源会话，匿名请求会被宿主拒绝。

---

## 配置项

| 配置 | 默认值 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 插件总开关 |
| `dataDir` | `<DSH_HOME>/life-memory` | 插件数据根目录 |
| `timezone` | 宿主机时区 | 按天分桶与时间戳 |
| `capture.enabled` | `true` | 捕获 DSH 会话事件 |
| `embedding.provider` | `local` | `local` 哈希嵌入或 `openai-compatible` |
| `embedding.model` / `dim` | `dsh-local-hash-v1` / `512` | 嵌入模型引用 |
| `embedding.baseURL` / `apiKeyEnv` / `timeoutMs` / `batchSize` | — | 远程嵌入设置（需 `safety.allowNetwork`） |
| `layers.enabled` | `[L1, L2, L3]` | 要构建的派生层 |
| `recall.enabled` | `true` | 启用 prompt 注入与召回 |
| `recall.promptBudgetTokens` / `toolDefaultLimit` | 内置预算 | 上下文/工具上限 |
| `retention.enabled` | `true` | 短期/中期/长期晋升 |
| `retention.shortTermDays` / `longTermAfterDays` | `7` / `90` | 保留期阈值 |
| `vectors.enabled` | `true` | 原始层向量管道 |
| `forgetting.enabled` | `true` | 短期到期删除、中期归档 |
| `persona.enabled` | `true` | 启用人格 |
| `persona.dir` | `<DSH_HOME>/personas` | 人格 markdown 目录 |
| `persona.maxBodyChars` | `20000` | 人格正文上限 |
| `http.enabled` / `basePath` | `true` / `/api/life-memory` | 面板 API |
| `ui.enabled` | `true` | Web 面板 |
| `safety.allowNetwork` | `false` | 是否允许远程嵌入 |
| `safety.redactSecretsInDerived` | `true` | 派生文本中的密钥脱敏 |
| `consolidation.enabled` | `false` | 可选的长期记忆整合（实验） |

---

## 数据布局

```
<DSH_HOME>/personas/<personaId>.md          # 人格定义
<dataDir>/
├─ vaults/
│  ├─ shared/                               # 共享记忆库
│  │  ├─ vault.db（含 -wal/-shm）            # raw_index + L1/L2/L3 + FTS/向量
│  │  ├─ manifest.json / VERSION            # 段清单 + 布局版本
│  │  └─ segments/<日期>/<sessionKey>/*.jsonl # 不可变 L0，按会话分开
│  └─ <personaId>/                          # 人格独立库（同样结构）
├─ exports/                                 # 导出的归档（sessions/、vaults/）
├─ session-config.json                      # 会话开关 + 新会话默认
├─ active-persona.json                      # 全局激活人格
├─ runtime-load.json                        # 最近加载诊断
└─ legacy-*/                                # 旧布局归档（只读，如有）
```

原始 L0 文件只追加；派生数据库即使删除也可以从 L0 重建。

---

## 隐私与安全

- **本地优先**：默认无遥测、无远程服务，数据都在 `dataDir` 下。
- **原始不可变**：捕获过程不修改、不删除 L0；删除只能人工操作。
- **显式派生**：L3 只使用用户消息与 `memory_save`；派生记忆与 prompt 默认会脱敏密钥（原始记录保留原文）。
- **默认离线**：`safety.allowNetwork=false`；远程嵌入需要显式开启并配置。
- **仅追加导入**：导入不会修改已有数据；写入前会校验归档格式/版本/哈希链。
- **删除数据**：完全退出 DSH 后删除 `<dataDir>`（建议先导出备份）；面板会显示准确路径。

---

## 限制与规划（v1）

- L3 语义抽取基于规则、刻意保守；部分内容需要显式 `memory_save` 才会进入长期记忆。
- 全局同时只有一个"激活人格"（单个会话可通过会话配置覆盖）；人格管理面向单用户。
- 面板以只读查看为主，直接编辑限于人格、会话/新会话设置和导入导出。
- 长期记忆整合（consolidation）默认关闭，属于实验性功能。
- 已在 Windows + DSH `0.2.1-rc.3`–`rc.5` 上测试；其他平台预期可用但尚未验证。
- OpenAI 兼容嵌入为可选能力，需要联网，不影响离线使用。

后续方向：更强的记忆整合、嵌入模型迁移工具、更好的语义抽取、多个人格并发。

---

## 参与贡献

欢迎提交 Issue 和 Pull Request。

- 必须保持不变量：L0 只追加且哈希链完整；派生数据可重建；导入不破坏已有数据。
- 提交 PR 前请运行 `npm run typecheck`、`npm run build`。
- 人格定义与文档都是 markdown，便于审查。

---

## 许可证

MIT © 2026 **hanxustu**。详见 [LICENSE](LICENSE) 与 [NOTICE](NOTICE)。

DSH / DeepSeek Harness 是 DeepSeek 的产品；本项目为独立社区插件，与 DeepSeek 无隶属关系，也未获得其背书。
