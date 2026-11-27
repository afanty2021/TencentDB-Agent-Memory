# v3 面按人分库（per-user stores）— 设计文档

- 状态：**已实施（2026-11-27，`port/multi-user-stores`），三席评审通过（2026-11-28，0 Critical / 0 Important），割接前小修批已修。未推送、未上线——§13.1 每一步等口令。**
- 日期：2026-11-27（调研 11-26）
- 分支：`port/multi-user-stores`
- 取代：`docs/v3-user-routing-design.md` 的 Option B′-subsume（共享库 + 列隔离 + team 槽位顶替）。该文档的 §1 隔离模型实测、§2 列错位问题仍然有效，仅路由方案被本文取代。

## 0. 一句话结论

每位用户一套独立记忆库 `<baseDir>/users/<uid>/`（独立 vectors.db、留档、画像、场景块、checkpoint）。实现方式是在 v3 请求入口按 `user_id` 定路由，给每人一个保留前缀的**用户域实例号** `user:<uid>`，库路径、文件根目录、管线任务都从这个实例号推出——18 条 v3 记忆路由的 handler 与管线 worker 的业务逻辑不改，改动集中在「选库/选目录」的几个点。

## 1. 背景

### 1.1 三代隔离方式

| 代 | 时期 | 方式 | 按人画像 |
|---|---|---|---|
| Gen A | 06-18→09-15 | 单库单人 | 有（管理员本人） |
| Gen B | 09-15→约 09-20（数据写到 09-29） | 物理路由：每人一整套独立库 `users/<uid>/` | 有（教师 A 目录下 `persona.md` 等 3 份遗存） |
| Gen C | 10-25→今 | MemoryCore 共享库 + 列隔离；L2/L3 作用域有意忽略 userId | 无（全员共用一份 "Team Operating Doctrine"） |

### 1.2 关键事实：物理隔离机制已经在仓里，只差 v3 没接

`port/multi-user-stores` 把 09-14 的 Gen B 实现原样移植进了 MemoryCore（见 `PORT-NOTES.md`）：

- 路由规则 `resolveUserIdRouting`（`MemoryCore/src/utils/user-id.ts:93`），带单测 `user-id.test.ts`。
- 按人 core：`TdaiGateway.getCoreForUser` / `_resolveCore`（`MemoryCore/src/gateway/server.ts:572-720`），数据根目录 `<baseDir>/users/<uid>/`，LRU 64。
- **但只接了 v1 协议的 5 个 handler**（recall / capture / search×2 / session-end）。插件自 9-22 起只说 v3，v3 走的是另一条路：`applyMultiUserV3Routing`（`v2-router.ts:244`）做 subsume。

### 1.3 v3 这条链怎么选库（实测）

standalone 模式下「库在哪」只由两个点决定，且都以 `instanceId` 为键：

- sqlite 库路径：`StorePool.getSqlitePath(instanceId)`（`store-pool.ts:487-496`）——`"default"` → `<baseDir>/vectors.db`，其他 → `<baseDir>/instances/<id>/vectors.db`。
- 文件根目录：`resolveFileOthersForInstance(instanceId)`（`server.ts:2879-2890`）——standalone 下所有实例都用同一个 `baseDir`。

`instanceId` 贯穿整条链：请求侧 `auth.serviceId` → `resolveStore` / `resolveStorage`；管线侧 `notifyPipeline(instanceId, …)` → 任务 `instanceId` 与 `data.instanceId` → worker 按它取库（`server.ts:3062-3084`）。L2→L3 级联（`pipeline-worker.ts:1046-1056`）、L1/L2 完成回调、本地定时器回调（`local-backend.ts:126-127`）都原样带实例号。**所以只要在请求入口把实例号换掉，管线侧自动跟过去。**

### 1.4 现状数据（2026-11-26 只读对账，时间为 UTC）

主库 `l0_conversations` 722 行 / `l1_records` 596 行。教师一律以代称记（教师 A–F，全文同此）；示意里的路径与实例号写作 `<uid>`；对照表自留本地、不入仓（§15）。

| user_id（教师为代称） | L0 | L1 | 说明 |
|---|---|---|---|
| default | 396 | 400 | cron 会话 + 单用户时代历史，无真人对话 |
| huangzhengbo | 236 | 125 | 管理员（owner），1 个长会话 |
| 教师 A | 50 | 44 | 10 个会话（10-31） |
| 教师 B | 32 | 22 | 1 个长会话（10-27→11-25） |
| 教师 C | 6 | 5 | 11-20 |
| 教师 D | 2 | 0 | 11-08 |

`users/` 下的 Gen B 遗留目录：

| uid（教师为代称） | L0 | L1 | 旧画像 | 备注 |
|---|---|---|---|---|
| 教师 A | 61 | 3 | 有（3801 B，09-21） | 另有 2 个旧场景块 |
| 教师 E | 14 | 4 | 有 | 10-25 后未再出现 |
| 教师 B | 14 | 0 | 无 | |
| 教师 F | 2 | 1 | 有 | 10-25 后未再出现 |
| zz-encourage | — | — | 有 | 测试账号，无库 |

旧库是旧 schema：`l0_conversations` / `l1_records` 只比现在少 `team_id / user_id / agent_id / task_id`（L1 另少 `version`）。MemoryCore 的 sqlite `init()` 自带在线迁移（`sqlite/memory-store.ts:506-512`、`621-630` 补列，`938-1031` 重建 FTS），正是为「隔离前的库」设计的。**先例：10-25 起在用的主库本身就是一个 Gen B 时代的目录被原地接管的，已稳定运行一个月。**

留档文件：`conversations/*.jsonl` 722 行（506 行带 `userId`），`records/*.jsonl` 682 行（664 行带 `userId`，append-only）。

## 2. 目标 / 非目标

**目标**

1. 每位用户一套独立库，含自己的画像；用户之间零互读。
2. cron 会话只读（用户 2026-11-26 裁定「cron 不写入」）。
3. 存量数据接上：10-25 以来的按人数据进各自的库；9 月遗留原地接管。
4. 教师域用 chat 口径出人物画像；主库保持 code。

**非目标**

- `deployMode: service`（云端多实例）——启动时直接拒绝，见 §6.6。
- v1 协议那条按人 core 路径——原样保留，不与本文统一。
- 给 cron 会话补教师身份（周报 cron 因此仍读不到教师本人的记忆）。
- tcvdb / mongo 后端。
- 通过 API 删除某位用户的数据——按人清库走 §13.3 的目录规程。
- 修复 `queryL1Records` 无视 `recordIds` 的既有缺陷（与本文无关，另案）。

## 3. 方案取舍

| 方案 | 做法 | 结论 |
|---|---|---|
| **A. 用户域实例号** | 请求入口按 `user_id` 定路由，推出 `user:<uid>`；库路径、文件根目录、管线任务由它推出 | **采用**。改动集中在选库/选目录的几个点；handler 与 worker 业务逻辑不动 |
| B. v3 复用「按人 TdaiCore」 | 把 `getCoreForUser` 接到 v3，每人一个完整 core | 否决。每人都初始化一套调度器/技能模块；任务需新增 `userId` 字段并穿过通知、状态、定时器、级联，漏一处即串库 |
| C. 共享库 + subsume | `docs/v3-user-routing-design.md` | 否决。不是用户要的隔离方式 |

另有一条不可行：让插件退回 v1 协议去用现成的按人 core——插件的原子记忆检索、场景读取、画像读取都是 v3 才有的。

## 4. 路由规则

规则 #1 在任何状态下都生效，适用于所有 `/v2/*`、`/v3/*` 路由（保留前缀与开关无关：开关关着时客户端自发这个前缀也会让网关去开别人的目录）。规则 #2–#6 仅当 `multiUser.enabled` 为真、且请求命中 v3 记忆数据面 18 条路由（`V3_ALLOWED_SUBPATHS`，`v2-router.ts:154`）时判定。技能、知识库、元数据、chat-memory 等管理面路由（`isV3Extra`）与 `/v2/*` 除 #1 外行为不变。

判定顺序（前一条命中即止）：

| # | 条件 | 结果 |
|---|---|---|
| 1 | `x-tdai-service-id` 以保留前缀 `user:` 开头 | **400**（§11） |
| 2 | `user_id` 归一化后非法（非 ASCII、含 `.`、空、超 64 字符等） | **400**，报文不回显原值 |
| 3 | 写类路由（`/conversation/add`、`/conversation/delete`、`/atomic/update`、`/atomic/delete`、`/scenario/write`、`/scenario/rm`、`/core/write`）且 uid 为 `default`（缺省身份归一后即 `default`） | **400**——default 桶只读（2026-11-27 A1 裁定：按 id 删亦属写门禁） |
| 4 | uid ∈ `ownerUserIds` | 主库 |
| 5 | uid 为 `default` | 主库（只读，见 #3） |
| 6 | 其余 | 用户库 `users/<uid>/`，实例号 `user:<uid>` |

归一化规则与 09-14 相同：`lowercase(trim(raw))` 后必须整体匹配 `^[a-z0-9_-]{1,64}$`，不剥离任何字符（fail-closed）。

**路由到用户库时，`user_id` 列一律写归一化后的 uid**（实现：把隔离上下文的 `userId` 置为归一化后的 uid；目的是防止客户端大小写不一致把行写散）。`team_id` / `agent_id` 保持请求原值（插件恒发 `default`），不做任何顶替或改写。

**主库请求的行为与 `multiUser.enabled=false` 时完全一致**，仅多了第 3 条写门禁。

**失败即拒绝（fail-closed）**：路由结果是用户库，但装配层没有提供按实例取库/取目录的钩子（`deps.resolveStore` / `deps.resolveStorage` 缺失）时返回 **503**，绝不回落主库。

## 5. 存储布局

```
<baseDir>/users/<uid>/
  vectors.db                                   独立库：l0_conversations / l1_records / 全文索引
  conversations/<日期>.jsonl                   对话留档
  records/<日期>.jsonl                         记忆留档
  .metadata/checkpoint.json                    L1 游标（本人）
  .backup/
  profiles/team%3Adefault%7Cagent%3Adefault/
    persona.md                                 本人画像
    scene_blocks/                              本人场景块
    .metadata/{scene_index.json,checkpoint.json}
```

- 子目录 `conversations / records / scene_blocks / .metadata / .backup` 由 `initDataDirectories` 创建（`pipeline-factory.ts:229`），与 Gen B 相同。
- 与 Gen B 的一处不同：画像在 `profiles/<作用域>/persona.md`，不在目录顶层。这是上游 v2 引擎的固定布局（`scopedDataDirForScope`，`pipeline-factory.ts:137`），主库现在就是这样。
- 每人一个 sqlite 连接、一份 checkpoint、一把管线锁；`StorePool` 上限默认 1000（`shark.maxInstances`），本部署十几个用户不会触发淘汰。

## 6. 改动面

### 6.1 新增纯函数模块 `MemoryCore/src/core/store/store-scope.ts`

```ts
export const USER_SCOPE_PREFIX = "user:";
/** 校验 uid 后拼出实例号；uid 非法则抛错（调用方必须先归一化）。 */
export function buildUserScopeInstanceId(uid: string): string;
/** 解析用户域实例号；不是用户域、或剩余部分非法 → null。 */
export function parseUserScopeInstanceId(instanceId: string): { uid: string } | null;
/** 由 baseDir 与实例号推出数据根目录。非用户域 → baseDir。 */
export function resolveScopeDataRoot(baseDir: string, instanceId: string): { dataDir: string; scoped: boolean };
```

无 I/O，便于单测。库路径规则、文件根目录规则、executor 取目录、请求路由四处共用，保证「同一个人四处推出同一个目录」。

### 6.2 请求入口：`handleV2Route`（`v2-router.ts:567`）

1. 鉴权后、任何处理前：保留前缀检查（规则 #1）。
2. **请求体解析提前到选库之前**（现在先选库后读请求体，所以读不到身份）。对其余路由无影响：作用域实例号等于 `serviceId`，选库结果与现在相同。
3. 隔离上下文解析与 v3 strict 检查保持原位。
4. 新的纯函数 `routeV3ByUser(opts, rawUserId, v3Subpath)` 取代 `applyMultiUserV3Routing`，实现 §4 的规则 #2–#6，返回 `{ pool, uid, scopeInstanceId? }` 或错误。
5. 选库、选文件根目录、管线通知三处用 `scopeInstanceId ?? auth.serviceId`。实现方式是把解析函数的入参换成带作用域实例号的 auth 副本，并给 `resolvedDeps.notifyPipeline` 包一层替换首参。
6. `getMetadataService`、配额等仍用 `auth.serviceId`。

handler 不改（唯一例外是删掉 `handleConversationAdd` 里 P1 加的 `subsumedTeam` 分支，见 §10）：它们只调 `deps.getStore() / getEmbedding() / getStorage() / notifyPipeline(...)`。

### 6.3 库路径：`StorePool.getSqlitePath`（`store-pool.ts:490`）

`parseUserScopeInstanceId(instanceId)` 命中 → `<dataDir>/users/<uid>/vectors.db`。已有的建目录逻辑（`createSqliteStore`，`store-pool.ts:473-476`）负责首次创建。

### 6.4 文件根目录：`resolveFileOthersForInstance`（`server.ts:2879`）

standalone 分支里，根目录由 `resolveScopeDataRoot` 推出：用户域 → `<baseDir>/users/<uid>` 并 `initDataDirectories`；否则 → `baseDir`（现状）。缓存仍按实例号。

### 6.5 管线执行：`buildTaskExecutor`（`server.ts:3056`）与 `run*WithStore`（`tdai-core.ts:1087-1200`）

`runL1WithStore / runL2WithStore / runL3WithStore` 各加一个末位可选参数：

```ts
interface RunScope { dataDir?: string; cfg?: MemoryTdaiConfig }
```

函数体内 `pluginDataDir: scope?.dataDir ?? this.dataDir`、`cfg: scope?.cfg ?? this.cfg`，其余不动。executor 在取到任务实例号后构造 `RunScope`：

- `dataDir`：用户域 → `resolveScopeDataRoot` 的结果；主库 → 不传。
- `cfg`：见 §8。

这是管线侧唯一的缺口：现在这三个方法把 checkpoint 与 `profiles/` 发现用的目录写死为主 core 的 `dataDir`（`tdai-core.ts:1126 / 1176 / 1220`）。

### 6.6 配置：`resolveMultiUser`（`gateway/config.ts`）

```yaml
multiUser:
  enabled: true
  ownerUserIds: [huangzhengbo]
  userPromptMode: chat      # 新增，可省略
```

| 键 | env | 默认 | 说明 |
|---|---|---|---|
| `enabled` | `TDAI_MULTI_USER` | `false` | 不变 |
| `ownerUserIds` | `TDAI_MULTI_USER_OWNERS` | `[]` | 不变 |
| `userPromptMode` | `TDAI_MULTI_USER_PROMPT_MODE` | 不设置 | `chat` 或 `code`；非法值在 stderr 告警并按未设置处理。env 为空串或全空白（`VAR=` 这类泄漏）视同未设置、回落 yaml；yaml 值不是字符串时同样告警 |

**启动即拒**：`multiUser.enabled=true` 且 `deployMode=service` 时，网关 `start()` 抛错退出（本文只支持 standalone）。

live 读的是仓内 `MemoryCore/tdai-gateway.yaml`（网关进程 CWD 优先于数据目录那份），改配置要改这份并提交。

## 7. 数据流

```
Hermes 轮次（教师 A；`<uid>` 指其归一化后的 uid）
  └─ 插件 POST /v3/conversation/add {user_id:"<uid>", team_id:"default", agent_id:"default"}
       │
  handleV2Route
    ├─ 读请求体 → 归一化 → routeV3ByUser → 用户库，实例号 user:<uid>
    ├─ resolveStore(user:<uid>)   → StorePool → users/<uid>/vectors.db
    ├─ resolveStorage(user:<uid>) → users/<uid>/
    └─ notifyPipeline(user:<uid>, session, rounds, "default", "default")
            │
  StatefulPipelineManager → state backend → PipelineWorker
    └─ executeL1/L2/L3：按 task.instanceId=user:<uid> 取库/目录，RunScope.dataDir=users/<uid>
         ├─ L1：L0 抽成 L1，写 users/<uid>/vectors.db；游标在 users/<uid>/.metadata/
         ├─ L2：场景块落 users/<uid>/profiles/team%3Adefault%7Cagent%3Adefault/
         └─ L3：画像落同目录 persona.md
```

- 管线状态键、checkpoint 锁键、L1/L2/L3 任务锁键都以实例号为维度，用户之间天然隔离。
- cron 会话（`user_id:"default"`）：读走主库（与今天一致），写被 400 拒绝。插件侧 `sync_turn` 在守护线程里跑且有异常兜底，不会熔断、不会重启网关（11-26 副本演练实证）。
- 管理员（owner）：读写都在主库，口径 code，与今天一致。

## 8. 口径：教师域 chat、主库 code（用户 2026-11-27 裁定）

`chat` 与 `code` 是两套完整口径，不是可混搭的开关：

| 层 | chat | code |
|---|---|---|
| L1 抽取、去重 | 个人记忆 | 工作记忆 |
| L2 场景块 | 场景日记（`buildSceneSystemPrompt`） | SOP/原则（`buildWorkSceneSystemPrompt`） |
| L3 | 四章人物画像（`PERSONA_SYSTEM_PROMPT`） | Team Operating Doctrine（`TEAM_MEMORY_SYSTEM_PROMPT`） |

画像以场景块为原料，混搭等于把 SOP 块喂给画像提示词。所以 `userPromptMode` 作用于用户域的全部四段。

实现：executor 为用户域任务构造 `cfg` 时，把 `extraction.promptMode` 与 `persona.promptMode` 同时置为 `multiUser.userPromptMode`（L1 抽取与去重读前者，L2 与 L3 读后者）。未设置时不构造，沿用全局配置。

注意：教师 10-25 以来的既有 L1 是 code 口径抽的。导入后它们原样保留，继续可用于召回；此后新抽的 L1 是 chat 口径。

## 9. 存量数据：导入脚本

新脚本 `MemoryCore/scripts/import-per-user-stores.ts`，逻辑放在可测的 `scripts/lib/per-user-import.ts`，CLI 只是薄壳。

```
node --import tsx scripts/import-per-user-stores.ts --data-dir <baseDir> [--owners a,b] [--confirm]
```

**主库永远只读打开。本脚本对主库零写入。** 默认 dry-run，`--confirm` 才落盘；可重复执行。

**用户集合** = 主库 `l0_conversations` 与 `l1_records` 两表里 `user_id ∉ ('', 'default')` 的所有 uid ∪ `users/` 下带 `vectors.db` 的目录名 − `--owners`。

候选按**归一化后的 uid** 判定与分组，与网关路由是同一套规则：

- 归一化后不是合法 uid 的候选跳过并计数（网关路由不到它）。
- 归一化后等于 `default` 的任何拼法都留在主库：网关永远把 `default` 路由到主库，建出来的 `users/default/` 只会是一份无人读到的影子库。
- `--owners` 按归一化 uid 比对——库行存的是混大小写原值时同样排除。生效的 owner 列表与被忽略的非法条目在开头打印；`--confirm` 没有有效 `--owners` 时在 stderr 告警（脚本无从得知本部署的属主；有属主而漏带，属主的行会被复制进一份网关永不路由的副本，无害但非本意，清除见 §13.3）。
- 归一化后相同的多个候选并成**一个库、一行报告**。

对每个 uid：

1. 建 `users/<uid>/` 及子目录。
2. 用引擎打开 `users/<uid>/vectors.db`：`new VectorStore(path, 0, logger)` → `init()`。库不存在则新建；Gen B 旧库则在线迁移（补列、重建 FTS）。
3. 用 `node:sqlite` 打开用户库，从只读打开的主库逐行复制该 uid 的 L0、L1（显式列清单，`INSERT OR IGNORE` 以 `record_id` 去重；复制谓词绑定的是库里实际存的拼法）。
4. 改挂：`UPDATE … SET user_id = <uid> WHERE user_id <> <uid>`（L0、L1 各一次）。依据：按人库里所有行都属于这个人；此步把 Gen B 旧行（迁移后默认标成 `default`）挂到本人名下。
5. 再次用引擎打开，调 `rebuildFtsIndex()`（公开方法，`sqlite/memory-store.ts:3189`，用引擎自己的分词重建）。
6. 留档：把主库 `conversations/*.jsonl`、`records/*.jsonl` 中 `userId` 归一化后等于该 uid 的行，逐字节追加到用户目录的同名文件；按行 `id` 去重。留档行的 `userId` 与库行同源、同拼法（网关写入时两边都是原值），所以谓词两边都要归一化。

**不迁的**：场景块、画像、checkpoint（各人从自己的记忆重新生成）；owner 的行（留在主库）；default 桶。

**dry-run 只读**：不建目录、不以写方式打开任何库；对旧库只读 `pragma table_info` 判断「将被原地升级」并报告。

**确认后的自检**（不通过则非零退出）：每个 uid 的用户库里所有行都归属本人，且 `count(user_id = uid)` 不少于主库该 uid 行数；全文索引的行数与基表逐表相等——引擎 `rebuildFtsIndex()` 对分词失败的行只打 WARN 跳过，索引短于基表即判不通过，否则关键词召回会静默缺行而脚本仍报成功；主库 L0/L1 总行数执行后**不少于**执行前（导入期间网关仍在运行，主库可能新增；脚本从不删主库行，所以减少即异常）。

**预期结果（2026-11-26 数据）**：

| uid（教师为代称，见 §1.4） | 复制 L0/L1 | 改挂 L0/L1 |
|---|---|---|
| 教师 A | +50 / +44 | 61 / 3（旧库原地升级） |
| 教师 B | +32 / +22 | 14 / 0（旧库原地升级） |
| 教师 C | +6 / +5 | 新建 |
| 教师 D | +2 / 0 | 新建 |
| 教师 E | 0 | 14 / 4（旧库原地升级） |
| 教师 F | 0 | 2 / 1（旧库原地升级） |

`zz-encourage` 无库，不动。旧位置的人物画像与场景块文件留在原地，新引擎不读。

**已知效应**：续聊的旧会话（如教师 B 那个 10-27 起的长会话）在新的用户库里没有游标，L1 会从会话头开始再抽一遍，由去重环节与已导入的 L1 合并。这与今天丢失 checkpoint 后的行为相同。

## 10. 被取代的部分

subsume 方案整体让位于本文：

| 对象 | 处置 |
|---|---|
| `applyMultiUserV3Routing`（`v2-router.ts:244`） | 由 `routeV3ByUser` 取代。保留：uid 归一化 fail-closed、default 写门禁。删除：team 槽位顶替、读路由剥离 team |
| `V3_USER_SCOPED_SUBPATHS`、`subsumedTeam` 标记及其在 `handleConversationAdd` 里跳过资产登记的分支 | 删除。资产登记恢复 `multiUser` 关闭时的行为 |
| `scripts/backfill-multiuser-teams.ts` | 删除，由 §9 脚本取代 |
| `/v3/chat-memory/clear` 的 `user_ids` 寻址模式（`chat-memory-handlers.ts:534-600`） | **下线**：请求带 `user_ids` 一律 400，与开关状态无关，提示按 §13.3 处理。原因：它会清主库里该人的休眠副本并报成功，而本人的真实库未动。`memory_ids` 资产寻址模式不变（它只作用主库，见 §13.3） |
| `multi-user.test.ts` 中 `applyMultiUserV3Routing`（9 条）、`v3 dispatch wiring`（6 条）、`chat-memory clear user-scope`（8 条） | 由 §12 的对应测试取代 |
| `gateway.multi-user.e2e.test.ts` 的 subsume 场景 | 由 §12 的物理分库场景取代 |
| `docs/v3-user-routing-design.md`、`PORT-NOTES.md` | 实施时加「v3 路由方案已被本文取代」的指引 |

v1 协议的按人 core 路径及其 11 条单测原样保留。

## 11. 安全边界

- **保留前缀**：`x-tdai-service-id` 的值只校验非空（`parseV2Auth`，`v2-router.ts:440`），客户端可以自己填 `user:<uid>` 去指到别人的库。因此该头以 `user:` 开头一律 400，与开关状态无关。用户域实例号只能由网关内部根据归一化后的 `user_id` 构造。
- **目录穿越**：uid 必须匹配 `^[a-z0-9_-]{1,64}$` 才会被拼进路径；`buildUserScopeInstanceId` 对非法 uid 抛错；`LocalStorageBackend` 另有根目录逃逸检查。
- **信任边界同 09-14**：网关绑定 127.0.0.1，本方案防用户之间串库，不防持有网关密钥的本地进程——`user_id` 是调用方自声明字段，持钥者本来就能冒充任意 uid。
- **日志**：uid 是标识符，可以进日志；记忆内容、查询文本不进日志（现有约定）。
- **遥测是另一条通道，上述约定不管它**：v3 的 `/conversation/search` 与 `/atomic/search` 会把查询原文与前 5 条命中内容（各截 200 字符）写进当前 span 的属性（`tdai.recall.query` / `tdai.recall.results`，上游为在线评测系统所写，`v2-router.ts:1124-1146`、`:1399-1432`）。没有活跃 span 时什么都不记；一旦启用了会产生并导出 span 的可观测性组件，这些内容会随 span 离开本机。本部署以 observability 全关为前提（§13.1 第 4 步核对）；日后若要开遥测，先给内容采集加开关。

## 12. 测试计划（TDD，先红后绿）

**单测**

| 对象 | 钉住的行为 |
|---|---|
| `store-scope.ts` | 拼/解/推目录；非法 uid 抛错；非用户域解析为 null |
| `routeV3ByUser` | §4 规则 #2–#6 全矩阵；非法 uid 报文不含原值 |
| `handleV2Route` 接线 | 用户写入落 `users/<uid>/vectors.db` 且 `team_id=default`、`user_id` 归一化；`notifyPipeline` 收到 `user:<uid>`；owner 与 default 身份的读落主库；default 写 400；非法 400；保留前缀 400；用户域缺钩子 503；`multiUser` 关闭时与现状逐项一致 |
| `StorePool` | `user:a` 的库文件在 `users/a/vectors.db` |
| `resolveFileOthersForInstance` | `user:a` 的根目录是 `<baseDir>/users/a` 并建好子目录；`default` 不变 |
| `run*WithStore` | 传 `RunScope` 时用它的目录与配置，不传时行为不变 |
| executor | 用户域任务构造 `RunScope`（目录 + 两个 promptMode）；主库任务不构造 |
| 配置 | `userPromptMode` 的 yaml/env 读取、非法值处理；service + enabled 启动即拒 |
| `chat-memory clear` | `user_ids` 一律 400（与开关无关） |
| 导入库函数 | 新建库复制数正确；旧 schema 库被升级且旧行改挂；重复执行不翻倍；主库行数不变；全文检索能搜到复制进来的行 |

**评审小修批补充（2026-11-28，均先红后绿）**

| 对象 | 钉住的行为 |
|---|---|
| 导入库函数 | owner 与 `default` 桶按归一化 uid 排除（库行存混大小写原值时同样排除，且不建 `users/default/`）；同一 uid 的多种拼法并成一个库、一行报告；留档行按归一化 `userId` 匹配（夹具用库行与留档行**同拼法**的真实组合）；有行未能进全文索引时自检判不通过；开头报告生效的 owner 列表并具名被忽略的非法条目 |
| 导入 CLI（真脚本子进程） | `--confirm` 无有效 `--owners` 时 stderr 告警；全由非法条目组成的 `--owners` 视同没有；自检不通过时退出码 1 并报出全文索引计数 |
| executor | 用户域 flush 任务不触达主 core 的 `handleSessionEnd`（warn 后返回）；主库实例的 flush 照常 |

旧 schema 夹具：取教师 A 旧库（`users/<uid>/vectors.db`）的 `sqlite_master` DDL（仅结构，无数据）作为测试夹具。

**e2e**（真实网关，隔离端口 + 临时目录 + mock LLM，沿用现有 `gateway.multi-user.e2e.test.ts` 的基建）

1. 两个用户各自写入后互不可见；根库无两人的行；`default` 身份写入 400；owner 写入落根库。
2. 管线按人运行：L1 抽进 `users/<uid>/vectors.db`；`users/<uid>/profiles/…/` 作用域目录出现，而根目录下没有对应目录；mock LLM 收到的 L1 系统提示词是 chat 口径。场景块与画像文件本身不由 e2e 断言——mock LLM 不产生工具调用，写不出文件；L2/L3 落在本人目录由单测钉住（`createL2Runner` / `createL3Runner` 收到的目录入参）。
3. 既有 5 条 e2e 中前 4 条（v1 按人库、开关关闭、api-key、v1 真实 L1 管线）原样续跑，确认未回归；第 5 条（subsume 场景）由上面两条取代。

**副本演练**（上 live 前的必经步骤，不属于自动化测试）

复制 live 存储 → 导入 dry-run / confirm → 测试网关开 `multiUser` 跑读写矩阵 → 核对 §9 预期表、教师 A 的旧库升级后 9 月的行能以教师 A 身份检索到、管线产物落在本人目录。隔离手法与 11-26 演练相同（独立 `TDAI_DATA_DIR`、独立端口、LLM 指向空地址、`lsof` 核对测试进程对 live 存储零句柄）。

## 13. 上线与回滚

### 13.1 顺序（每一步动 live 都等用户口令）

1. 备份：`sqlite3 -readonly <live>/vectors.db ".backup <备份目录>/vectors.db"`；`cp -R users/ <备份目录>/users/`。
2. 导入 dry-run（`--owners huangzhengbo`），核对 §9 预期表。
3. 导入 `--confirm`（此时开关未开，新库尚无人读）。
4. 改仓内 `MemoryCore/tdai-gateway.yaml`：`multiUser.enabled: true`、`ownerUserIds: [huangzhengbo]`、`userPromptMode: chat`；提交。同时核对 `observability` 块保持全关（§11 遥测面：开启后搜索的查询原文与命中内容会随 span 外发）。
5. 重启网关：结束 8420 监听进程，由插件监督器重拉（配置是网关侧读的，Hermes 不必重启）。避开周日 19:00–20:00 周报窗与 05:00 / 08:00 的 cron。
6. 补跑一次导入（`--owners` 同第 2 步；幂等），收掉第 3 步到第 5 步之间的增量。此时开关已开、网关在写用户库，而每次 confirm 都会对每个用户库重建一次全文索引：自检的索引行数对账若恰好撞上同一用户库的并发写入，可能因多出一条重复索引行而报不通过——重跑一次即重建并通过（此为代码分析所得，未实测）。
7. 验收：网关日志出现 `Multi-user routing ENABLED … layout=<baseDir>/users/<uid>/`；以教师 A 身份读能检索到 9 月与 10 月的行、画像为空；以 default 身份写被 400；下一场 cron 的 agent.log 出现 `sync failed: HTTP Error 400` 且任务照常完成。

### 13.2 回滚

`multiUser.enabled: false` + 重启网关 = 全部流量回主库。切换后写进 `users/` 的增量留在盘上，重新开启即恢复。主库从未被导入脚本修改，回滚不丢数据。Gen B 旧库的原地升级只补列、重建索引，数据行不减，回滚开关不涉及它们。

### 13.3 按人清库规程

确认该用户最后一条写入距今超过 10 分钟 → 停网关 → `mv users/<uid>/ users/<uid>.removed-<日期>/` → 起网关。可逆。若该用户此后仍会发消息，下次写入会重建空目录。

- **这一步不是擦除。** 挪走的只是她自己的库；主库里那些割接前的来源行原样还在（导入是复制，主库从未被脚本写过），`multiUser.enabled: false` 回滚后它们会重新可见。要连主库里的旧行一起清，是另一次针对主库的操作。
- **`/v3/chat-memory/clear` 的 `memory_ids` 清空只作用主库。** 该路由不走按人路由（`getStore()` 取的是主库），按人分库后清不到 `users/<uid>/` 里的内容——它报成功不代表本人的库被清。要清本人的库，走上面的规程。

## 14. 已核实的依据与风险

**读代码核实（2026-11-27）**

- 级联与定时器带实例号：`pipeline-worker.ts:1046-1056`、`local-backend.ts:126-127`、`stateful-pipeline-manager.ts:197-202`。
- 装配层对任意实例号不设防：`local-resolver.ts:54-67`（sqlite / local 与实例号无关）。
- LLM 配置解析只在 `provider=proxy` 时用到实例号（`llm-provider-resolver.ts:33`）；live 不是 proxy。
- 「预热」不是启动扫描：`enableWarmup` 只影响新会话头几轮的触发门槛（`stateful-pipeline-manager.ts:192`），不会重抽 9 月的对话。
- 旧个人目录没有 `checkpoint.json`（只有 `recall_checkpoint.json`），新引擎会新建；读取失败时回落默认值（`checkpoint.ts:280-335`）。
- `discoverProfileScopes` 只列 `profiles/` 下的目录（`pipeline-factory.ts:146`）。单凭这一点挡不住旧场景块：L3 在一个画像域都没发现时会回落到默认域（`executionScopes = scopes.length > 0 ? scopes : [DEFAULT_PROFILE_SCOPE]`，`pipeline-factory.ts:967`），而默认域读的是目录顶层的场景索引。真正挡住的是两件事叠加——导入不迁场景块，用户目录顶层是空的；场景索引为空时 L3 直接跳过、不调 LLM（`pipeline-factory.ts:1003-1008`）。主库目录顶层的旧画像、旧场景块留在原地，用户域读不到。

**风险**

| 风险 | 缓解 |
|---|---|
| 旧库原地升级出意外 | 先在副本上演练；第 1 步整目录备份；主库有同样经历的先例 |
| 续聊旧会话时 L1 重抽 | 去重环节合并；与丢失 checkpoint 后的行为一致 |
| 每人各跑一套管线，LLM 调用次数上升 | 与 9 月 Gen B 相同量级；教师总数十余人 |
| `/v3/chat-memory/clear` 的 `user_ids` 模式被某处依赖 | 插件不调用（只调 6 个端点）；上线前 grep 两个仓确认 |
| 搜索端点把查询原文与命中内容写进 span 属性（上游在线评测用，§11） | observability 保持全关；要开遥测，先给内容采集加开关 |
| 引擎将来给 L0/L1 加列，导入的显式列清单没跟上 | 导入在开头具名告警「root … has column(s) the import does not copy」；看到即先补 `COLUMNS` 再 confirm |

## 15. 决策记录

| 日期 | 决定 | 出处 |
|---|---|---|
| 2026-11-26 | 隔离方式改为物理分库 `users/<uid>/`，取代 subsume | 用户 |
| 2026-11-26 | cron 会话不写入（只读） | 用户 |
| 2026-11-27 | 口径：教师域 chat、主库 code | 用户 |
| 2026-11-27 | 9 月 Gen B 遗留原地接管 | 用户 |
| 2026-11-27 | 设计（方案 A，§1–§13）认可 | 用户 |
| 2026-11-27 | owner 留在主库 | 沿用 09-14 评审决策 1，本次设计评审未提异议 |
| 2026-11-27 | `/v3/chat-memory/clear` 的 `user_ids` 模式下线 | 本文档提出，属已认可的设计范围；已随实施落地（8c97ac6），三席评审无异议 |
| 2026-11-28 | 全文的教师 uid 改为代称（推送前脱敏） | 用户（11-28 分支评审 P1）；对照表自留本地不入仓；管理员 id 与测试账号不代称化 |
