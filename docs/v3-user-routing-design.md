# v3 面按 user 路由 — 设计文档

状态：**v3.3（P0+P1 全部落地）** · 2026-09-25 · 基线分支 `port/multi-user-stores`
前置：[PORT-NOTES.md](../PORT-NOTES.md)「Out of scope」第 1 条
修订史：v2 = 评审轮 1 修正（附录 A）；v3 = 四项决策拍板 + 实施前验证推翻两处机制假设（§2.1、附录 B）；v3.1 = 评审轮 2 修正（clear 链表述纠正、delete 剥离类、资产登记跳过、dispatch 钉测、附录 C）；v3.2 = P1 clear 链落地（user 寻址 + wipeProfiles 旗标，附录 D）+ 评审轮 3 修正（mongo profile 滤镜、契约用例、部分失败语义，附录 D 补记）；v3.3 = P1 收口（写拒绝/auto-recall 穿线/回填脚本/e2e v3 断言全落地；e2e 实证 v3 数据落 instances/{serviceId} 实例库）

---

## 0. 一句话结论

上游 v3 已把 `user_id` 做成 **L0/L1 的 filter 级隔离维度**，但 **L2/L3（scene blocks + persona）显式设计为 team+agent 共享、忽略 userId**。当前移植分支上插件始终发送 `team_id="default"`，导致**所有用户的 persona 塌缩进同一个 scope**。

**已拍板方案（B′-subsume，2026-09-23）**：在 `multiUser.enabled` 下，v3 dispatch 层把 userId **并入** teamId（缺省或 placeholder `default` 时 `teamId := userId`），让 L2/L3 全链路走上游原生 team 机器——解析器/正则/行存/同步**零改动**；配合 fail-closed 归一化与 default 桶写拒绝。**注意：不是"剥离 teamId 让 userId 顶替"**——顶替语义在代码里存在写入/读取两侧列错位，直接激活会静默失效（§2.1，本轮实施前验证发现）。

---

## 1. 上游 v3 隔离模型（实测，非推测）

### 1.1 四层隔离键

| 层 | 隔离键 | 机制 | 证据 |
|---|---|---|---|
| instance（物理） | `instanceId = auth.serviceId`（API key → 服务身份） | 每实例独立 store pool / TCVDB / COS / MetadataService | `server.ts:1245` `resolveStore(instanceId)` |
| L0 conversations | `(teamId, userId, agentId, sessionId, taskId)` | **单实例内 filter 级**：写路径 record 带 userId，读路径 searchFilter | `v2-router.ts:727-740`（写）、`:837-851`（读） |
| L1 memories | 同上 | 同上；L1 提取**按 (userId, agentId, sessionId) 重分组**，每组独立写 | `pipeline-factory.ts:533-544` groupKey、`:599-611` |
| L2/L3 profiles | `team:{teamId \|\| userId \|\| "default"}\|agent:{agentId \|\| "default"}` | **userId 在 teamId 存在时被忽略**（仅在缺 team 时顶替）；存储前缀 `profiles/{scope}/`，行存走 profileScopeFilter | `profile-scope.ts:32-42`、`v2-router.ts:1556-1558` |
| chat-memory / knowledge / skill | (team, agent) / team / instance+ACL | 管理面资产，无 user 维度 | `v2-router.ts:698-710` `ensureChatMemoryAsset` |

### 1.2 请求侧解析

- `resolveIsolation()`（`v2-schemas.ts:364-393`）：body 字段优先，其次 `x-tdai-{team,user,agent,session,task}-id` 头。**关键不对称**：`teamId` 缺失时**真正缺席**（`:391` 条件展开不补占位），而 user/agent/session 缺失补 `"default"` 占位。
- `V3_STRICT_ISOLATION=1`（`env-config.ts:187`）时缺三元组 → 422（`collectV3Missing`，`v2-router.ts:145-147`）；**默认 OFF**，但 env-config 注释建议生产开启。与本设计正交（B′ 下三元组仍齐全，可叠加）。
- v3 数据面读写端点（`V3_ALLOWED_SUBPATHS`，`v2-router.ts:153-172`）全部经 `deps.requestIsolation` 消费该 ctx。

### 1.3 与本地多用户意图的根本分歧

`profile-scope.ts:38-40` 原文：

> L2/L3 are team+agent-level memories. L0/L1 keep user/session/task-level isolation, but profiles intentionally ignore userId/sessionId/taskId so one team's agent memory can accumulate across multiple sessions/users.

本地场景（lt-tutor：一个 bot 服务教师 + 被转发的多位家长）要求**每个自然人有独立 persona**。上游模型下同一 `(team, agent)` 的所有人共享一份 L2/L3——这是设计分歧，不是实现缺陷。

---

## 2. 移植分支现状：一个已存在的正确性问题

插件 v3 client（`client.py:110-131` 等）所有方法**默认且始终发送** `team_id="default"`、`agent_id="default"`；provider 侧 `self._team_id = _DEFAULT_TEAM_ID`（`__init__.py:347`）。叠加 §1.1 的 scope 规则：

| 层 | 现状 | 判定 |
|---|---|---|
| L0/L1 | 插件传 `user_id=capture_uid` / `_effective_user_id()`，写读两端 filter 均带 userId | ✅ 按人隔离成立 |
| L2/L3 | `buildProfileIsolationScope({teamId:"default", userId, agentId:"default"})` → `team:default\|agent:default`，**userId 被忽略** | ❌ **全用户共享一份 persona** |

后果：混合用户会话里，L2 提取把多个人的 L1 合成进同一个 scene 集、L3 生成混合 persona——**正是 2026-09-17 生产事故（教师转发家长消息被错记身份）在 persona 层的重演类别**。插件虽然给 `core_read/scenario_ls` 传了 user_id（`__init__.py:715/724`），但因 teamId 在场而被丢弃。

另注：移植的 v1 `_resolveCore` 物理路由对当前插件是**死路径**（插件已全量走 v3 端点），仅服务 v1 遗留调用方。

### 2.1 顶替语义的列错位（实施前验证发现，推翻两处机制假设）

评审轮 1 曾认定（claim 5）"插件省略 team_id 即可让 userId 顶替、端到端可行"。本轮实施前逐列追踪发现**顶替形状在写入侧与读取侧的列不一致，四处接缝全部错位**：

| # | 接缝 | 写入侧 | 读取/查询侧 | 结果 |
|---|---|---|---|---|
| 1 | L2 提取查 L1 | L1 行 `team_id` 存 `record.teamId ?? ""`（`memory-store.ts:677`；ctx 无 team → **空串**） | L2 任务键 `profile:team:{uid}\|agent:{a}` 解析回 `{teamId: uid}`（`pipeline-factory.ts:107-110`），查询 `team_id = "{uid}"`（`:738-743`） | **查空 → L2 永远提取不到 L1，persona 永不积累（静默）** |
| 2 | profile 行列 | 行存绑定解析后的 `{teamId: uid}` → 行 `team_id={uid}, user_id=""`（`profile-row-backend.ts:240-242`） | — | user 信息丢失在 team 槽 |
| 3 | profile 读滤镜 | —（接缝 2 的行） | core/scenario 用**请求 ctx** `{userId: uid}` 绑行存 → `profileScopeFilter` else 分支钉 `team_id="" AND user_id="{uid}"`（`profile-scope.ts:68-73`，`v2-router.ts:1783`） | **persona 写得进、读不回** |
| 4 | 同步匹配 | 同接缝 2 | `profileMatchesScope` teamId 在场时只比 `team+agent`（`profile-sync.ts:28-32`） | 同步集合同样错位（id 短路部分掩盖） |

**根因**：`buildProfileIsolationScope` 的 `ctx.teamId || ctx.userId` 顶替只在这一个函数内自洽；scope 字符串一经 `parseProfileIsolationScope` 解析就变成普通 team（`:107` team 分支），下游全部按 team 对待，而请求 ctx 派生侧按 user-only 对待——两半永不合拢。**上游从未踩过这条路**：所有真实客户端（含上游自家插件）都发具体 team_id（至少 placeholder `"default"`），顶替是从未被端到端行使过的纸面回退。这也反证 §1.3：上游"intentionally ignore userId"之所以安全，是因为顶替从来不是真机制。

**推论**：
- ❌ P0（插件省略 team_id，评审轮 1 认可、v2 文稿排期）——**不可行**，会按接缝 1+3 静默失效；
- ❌ B′-strip（dispatch 剥离 teamId）——同样走顶替，同样错位；
- ✅ **B′-subsume（dispatch 归一 `teamId := userId`）**——下游全程只见 team，四处接缝全部走原生 team 语义，自洽。

**作用域注（评审轮 2）**：接缝 1/3 的列错位是 **tcvdb/rowfs 特有**——sqlite standalone 后端把缺席 team 归一成 `"default"`，顶替在该路径的表现是"静默不生效"（顶替被吞）而非"L2 饿死"。结论对生产 service 路径（TCVDB）成立；向上游提 PR 时评审者大概率先在 sqlite 上复现，PR 描述需先声明作用域。

---

## 3. 方案空间

| # | 方案 | 一句话 | 评估 |
|---|---|---|---|
| A | 插件省略 team_id | 让 userId 走顶替语义 | ~~零网关改动~~ **已被 §2.1 推翻**：顶替列错位，L2 饿死 + persona 读不回。仅存的价值是 §4.4 卫生项（dispatch 归一后省略与否行为等价）。 |
| B | profile scope 增加 user 维度（3 段语法） | `team:{t}\|agent:{a}\|user:{u}` | 改动面 ~8 处（构造/过滤/解析三层 + 两正则 + 旁路，见 v2 文稿 §4.2）；scope 字符串自描述、上游 PR 论据最强。**已拍板不采用**（选 B′），留作上游反馈 B′ 时的升级路径——subsume 数据形状 `team:{uid}` 与 B 的解析器改动兼容（`parseProfileIsolationScope:107` 已保留 user 段只需小改）。 |
| **B′** | **dispatch 归一：userId 并入 teamId（已拍板）** | enabled 时写/profile 端点 `teamId := userId`（缺省或 placeholder 时），L0/L1 读端点剥离 team 维度 | **引擎层 dispatch 以下零改动**（解析器/正则/行存/同步/profile-sync 全部原样）；默认关闭逐比特兼容。代价：scope 字符串语义上 user 冒名 team、team 维度被 user 占用（lt-tutor 无真实 team，可接受）；真实 team_id 在场时 team 语义优先（§4.2 残余语义）。 |
| C | 把 `_resolveCore` 搬进 v3 dispatch | instanceId ≈ `(serviceId, userId)` | 重量级 + service 模式绕过 TCVDB/COS 实例边界（`server.ts:572-598` vs `:1241-1249`）。否决。 |
| D | 每个"人"当一个 team | team_id = 人 id | 与 B′ 同族，但改在客户端且污染管理面 team 实体；B′ 改在 dispatch 且不动管理面（placeholder team 的资产登记被归一自然消除）。否决（被 B′ 吸收）。 |

---

## 4. 推荐设计（Option B′-subsume，已拍板）

### 4.1 配置面

复用已移植的 `multiUser` 块（`MemoryCore/src/gateway/config.ts`），无新增字段：

```yaml
multiUser:
  enabled: false        # true 时激活本设计全部行为
  ownerUserIds: []      # 已有字段：静态 initialize 允许的 user 白名单
```

不新增子开关：per-user 路由、归一化、default 桶写拒绝是一个不可拆的隔离契约。`enabled=false`（默认）：所有行为与上游 v3 完全一致，保证向上游 PR 的零风险基线。

### 4.2 改动面：dispatch 一点 + 两个 P1 旁路（引擎其余零改动）

**(a) v3 dispatch ctx 归一（唯一引擎改动，P0）**

挂点：`dispatchV2Request`（`v2-router.ts:594-630`），`resolveIsolation` 之后、`depsWithIsolation` 之前；仅当 `multiUser.enabled` 且路径 ∈ `V3_ALLOWED_SUBPATHS`：

1. **归一化（fail-closed）**：`user_id` 经已移植的 `normalizeUserId`（`^[a-z0-9_-]{1,64}$`，ASCII trim，与插件侧 `_normalize_user_id` 逐字对齐）。非法 → **400**，报字段名不报值。封死 scope 字符串注入（userId 即将进 team 槽，进 filter 串与存储前缀）整个类别。
2. **写端点 + profile 端点（subsume）**：`conversation/add`、`atomic/update`、`scenario/*`、`core/*` —— ctx.teamId 缺省或为 placeholder `"default"` 时 **`teamId := userId`** 并标记 `subsumedTeam`。真实 team_id（≠"default"）在场则不动（team 语义优先，见残余语义）。`subsumedTeam` 供消费方跳过 team 语义副作用：**chat-memory 资产登记跳过**（`handleConversationAdd` 的 `ensureChatMemoryAsset` 守卫加 `!iso?.subsumedTeam`）——subsume 形状下该登记必抛 `team_mismatch`（agent `"default"` 不属于 team `{uid}`，`metadata-service.ts:1395-1401`，且失败不进 LRU 缓存），不跳过则每次写一次注定失败的 metadata 往返 + warn。per-user 资产/clear 链是 P1（§4.2(c)）。
3. **L0/L1 user 维度端点（剥离 team：读 + 按 id 删）**：`conversation/query|search|count|delete`、`atomic/query|search|count|delete` —— ctx.teamId 置 undefined（`buildIsolationConditions` 对 undefined 跳过，`memory-store.ts:191`；handler 两路径均容忍缺席，`v2-router.ts:843/872`；删除走按 id/按 session 路径，filter 非空性不受影响，`atomic/delete` 的滤镜构造本就条件展开）。**目的**：user_id 本身就是 per-user 隔离维度，剥离 team 后割接前（`team_id="default"`）与割接后（`team_id={uid}`）两个时代的行对同一用户都**可见且可删**——conversation 历史（钻取工作流）不丢，删除语义与读对称（若 delete 走 subsume，旧行"读得到删不掉"：返回成功但 `deleted_count: 0`）。**注**：读端点对 team 的剥离是无条件的（真实 team_id 在场也剥）——与写侧"真 team 优先"不对称，按"user 维度端点 team 不参与"的语义如此实现；multiUser 模式假设无真实 team，若有则该 team 维度在这些端点不生效（已知行为）。

**为什么这样就够**（对照 §2.1 四接缝）：subsume 后 L0/L1/L2/L3 全链路只见 team：
- L0 写行 `team_id={uid}, user_id={uid}`；L1 分组/写行同；L2 键 `profile:team:{uid}|agent:{a}`，解析回 `{teamId: uid}`，L1 查询 `team_id={uid}` ✅ 命中（接缝 1 消除）；
- profile 行 `team_id={uid}`（isolation 来自解析后 scope，接缝 2）；core/scenario 读侧 ctx 已 subsume → `profileScopeFilter({teamId})` → `team_id={uid}` ✅（接缝 3）；
- 同步匹配 team 分支 ✅（接缝 4）；
- 两处刚性正则（`timer-member.ts:44`、`pipeline-worker.ts:1133`）两段语法原样匹配 ✅；
- D12 ③ 不变式（id/filter/parse 同集）：id 哈希自 `team:{uid}|agent:{a}`、filter `team_id={uid}`、parse `{teamId: uid}`——三者同集 ✅。

**残余语义（明示）**：multiUser 模式假设"无真实 team"。若调用方发来非 placeholder 的真实 team_id，team 语义优先——该 team 内所有 user 共享 persona（等价上游行为）。lt-tutor 不存在此场景。

**(b) default 桶写拒绝（P1）**

数据面写端点 user_id 缺失（归一化后为 `default` 占位）→ 400，要求显式身份；带显式 user_id 的写放行；读端点不门禁。（原 owner 白名单写门禁经评审轮 1 推翻：会拒掉 lt-tutor 全部核心流量，且自报身份下无防冒充语义——`/seed` 守卫 `server.ts:1833-1835` 原文自认 "guards against misuse, not forgery"。防冒充 = 绑定认证信道，非目标。）

**(c) 旁路消费者（P1）**

- `auto-recall.ts:163-175`：v1/standalone 面独立构造 scope，`:166` 硬编码 `{teamId:"default", agentId:"default"}` 回退。修法：v1 dispatch（multiUser 时）传入 `{teamId: uid}` 作 `profileIsolation`，保留 default 回退服务 legacy standalone。**已拍板：修。**
- `clearMemoryContent`（`memory-store.ts:2016-2020`）：**已修（P1 落地，2026-09-24，附录 D）**。定案的 per-user 资产形状是**不建 per-user 元数据实体**：standalone multiUser 部署的 metadata 库是空的（上游自己的 placeholder 登记（team="default", agent="default"）在那里也只会 `agent_not_found`——资产/面板链本是 service 部署专属），为每个自然人建 user+team+agent 实体需要合成 owner（user_key 物料）、吃 team 配额、且把 team（组织语义）错配给人。取而代之，`/v3/chat-memory/clear` 增加 **user 寻址模式**（与 `memory_ids` 资产寻址互斥，同请求双字段 → 400，zod object 会剥未知键故互斥须在 schema 前显式判定）：
  - 请求 `{user_ids: string[] (≤100, trim/去重), agent_id? (缺省 "default")}`，仅 `multiUser.enabled` 下可用（否则 400）；user_id 经 `normalizeUserId` fail-closed（非法 400 报字段不报值，整批拒绝零清空），归一后去重（"Alice"/"alice" 同人）。不经过 metadata 面与资产（user 模式不要求 metadata service 可用）。
  - 每个 uid 覆盖**两代数据**：① 自有 scope（`team={uid}`）全清——L0/L1（team+user 收窄）+ per-user persona 的行与文件（`clearProfileStorage`）；② 共享时代扫尾（`team="default"` 行按 user 收窄）**跳过 profile 删除**（新 store 旗标 `wipeProfiles:false`——profiles 是 team+agent 粒度，按 user 收窄的清除若带 profile 删除会误删整个共享 persona；tcvdb/mongo 生效，sqlite 本就不在 clearMemoryContent 动 profile）。`uid="default"` 时两代重合退化为单次全清。
  - memory_id 返回确定性伪 id `chat_memory-{uid}-{agent}`（与真实资产 id 同构：未来若配真实实体两侧一致），审计两模式同形（L1/L2/L3 各一条）。
  - **部分失败语义（评审轮 3 明示）**：重试包住整个两代清除——自有 scope 已清成而共享扫尾终败时，item 报 `cleared:false` + 全零计数且不发审计（fail-loud + 幂等重试，audit 落在成功那次；详见附录 D 补记）。
  - **残余（明示）**：共享时代 persona（`team:default|agent:default`）是跨用户共享物，per-user clear 不（也无法）摘除单人贡献；割接后它本就不可见（scope 已换），回填脚本 + 冷启动再生是正解。P0 的 ensure 跳过守卫保留不变（依旧不登记 per-user 资产）。

**(d) 配置穿线**

dispatch 在 gateway 进程内，`V2RouterDeps` 加一个 `multiUserEnabled: boolean`（server.ts 组 deps 时从 `this.config.multiUser.enabled` 注入，`server.ts:1200-1218`）。无跨进程/跨配置域问题（I3 就此消解——L2/L3 runner 无需感知，team 归一在数据进管道之前完成）。

### 4.3 插件面

**无需任何改动**：插件继续发 `team_id="default"`，dispatch 归一为 `teamId := userId`；身份链（turn_author → on_turn_start → initialize user_id → default）已接通，user_id 已随全部端点发送。省略 placeholder（`team_id`/`agent_id`）降级为可选卫生项（归一后省略与否行为等价；顺带消除 `ensureChatMemoryAsset` 对 default team 的无意义登记）。

### 4.4 明确的非目标

- **service 模式物理隔离**：user 维度在单实例内生效，不产生独立 TCVDB/COS；数据驻留级需求另立设计。
- **每用户 memory-prompt**：prompt 按 (team, agent, layer) 解析是配置分发，保持 agent 级。（注意：subsume 后 l1/l2 prompt 的 teamId 维度收到 `{uid}`——lt-tutor 未配 per-team prompt，落全局缺省，无影响。）
- **每用户配额**：`checkMemoryQuota(auth.serviceId)` 仍是服务级。
- **管理面（/v3/meta/*、knowledge、skill）**：资产粒度保持 (team, agent)/(team)/instance。subsume 不进管理面。
- **防冒充 / 身份认证**：user_id 始终是调用方自报；绑定认证信道（如 api-key → user 映射）另立设计。

---

## 5. 兼容与迁移

| 场景 | 行为 |
|---|---|
| `enabled=false` | 逐比特等于上游现行为（dispatch 归一整段不执行） |
| 开启瞬间（L2/L3） | 已有 `profiles/team:default\|agent:default/` 共享 persona **对读写双双不可见**（新 scope `team:{uid}`）——灰度语义即"冷启动"，旧目录原样保留可回滚（**已拍板接受**） |
| 开启瞬间（L0/L1 历史） | **不丢**：读端点剥离 team，按 user_id 过滤，割接前后两个时代的行同可见；删除（按 id/session）同剥离，语义与读对称；无需回填 |
| 非 SDK/第三方调用方的 400 兼容 | `multiUser.enabled` 后，原先合法的自由串 user_id（如 `wendy.li`，上游 schema 无值域约束）在全部 18 个 v3 数据面端点变 **400**（fail-closed 归一化）。插件侧已按同规则归一（`_normalize_user_id`）不受影响；**任何直连 v3 数据面的第三方 SDK 需先对齐值域** `^[a-z0-9_-]{1,64}$`——上线前需盘点调用方 |
| P0→B′ 过渡 | **同形免迁移**：P0（dispatch 归一）写出的就是 `team:{uid}\|agent:{a}`，B′ 完整版（+写拒绝/auto-recall）落在同一形状上——不存在第二次冷启动（原 B 的 3 段语法才有此问题） |
| 跨代混合会话 | L1 分组的 teamId 取自组内首行（时间序最早）的列（`pipeline-factory.ts:540`）：割切前开始的旧会话若含旧行（`team="default"`），其后续新消息仍归入共享 scope——**旧会长线程不享受 per-user persona**。缓解（可选 ops 步骤，非 P0 依赖）：一次性回填脚本 `team_id="default" → user_id`（L0/L1，user_id≠"default" 的行），使混合列归一。已拍板"接受 P0→B 数据迁移"精神下，此脚本列为 P1 交付 |
| `V3_STRICT_ISOLATION` | 正交可叠加（B′ 下三元组仍齐全——插件照发 team_id，归一在服务端） |
| chat-memory 管理面 clear | **已修（P1，2026-09-24）**：`/v3/chat-memory/clear` 新增 user 寻址模式（`{user_ids}`，multiUser 门控，两代扫除 + `wipeProfiles` 旗标），per-user 清空端到端可用（§4.2(c)）；`memory_ids` 资产寻址原样保留（面板/service 部署） |

回滚：`multiUser.enabled=false` 即回上游行为，无数据破坏。

---

## 6. 测试计划

1. **单元（vitest，`src/gateway/__tests__/multi-user.test.ts`，P0 已落地）**
   - 纯函数 `applyMultiUserV3Routing` 矩阵：写端点 subsume（placeholder/缺席 team、真实 team 优先、`subsumedTeam` 标记）、user 维度端点剥离（读 6 + 删 2 全子路径）、归一化（大小写/ASCII trim/非法 400）、`user_id=default` 占位时行为不变（fail-open 兼容）；
   - **dispatch 级（`handleV2Route` 直调 + fake L0 store，P0 已落地）**：subsume 下 `/v3/conversation/add` 落库行 `team_id=user_id={uid}` + 资产登记跳过；flag off 时行为逐比特不变（team 保持 "default"、资产正常登记）；真实 team 优先 + 资产正常登记；`/v3/conversation/query` 滤镜无 team 维度、双代行同可见（total=2）；非法 user_id 400（错误体不含原值、零写入、零登记）。
   - **chat-memory clear dispatch 级（P1 已落地，`handleV2Route` + `makeChatMemoryRouteTable` 直调 + fake clear store/storage）**：user 模式两代调用形状（自有 scope `wipeProfiles:true` + 扫尾 `team="default"` `wipeProfiles:false`，顺序钉死）；profile 文件只删 user 自己的 scope 前缀；计数合并；审计伪 id 同形（L1/L2/L3）；`uid="default"` 单次全清退化；归一/去重/自定义 agent_id；multiUser off → 400；非法 user_id → 400 不回显值且零清空；双模式同请求 → 400 / 双缺席 → 400；资产模式回归（multiUser on/off 均走 metadata 解析不受影响）。
2. **集成**：v3 数据面双用户回归——alice/bob 各自 conversation/add → 查询互不可见 → core_read 各自 scope（fake store 级）。
3. **e2e（P1 已落地，2026-09-25）**：`gateway.multi-user.e2e.test.ts` 新增 v3 subsume 场景（真实网关于进程 + HTTP + mock LLM）：写门禁（缺席身份 add → 400 零落库）→ 双用户 v3 写 → **L0/L1 行 `team_id=user_id` 列级断言（真实管线）** → **per-user profile 存储域目录 `profiles/team:{uid}|agent:default/` 落盘断言**（§2.1 接缝 1 的端到端证明；L2 任务键另见子进程 trace）→ `/v3/conversation/search` 双向不可见。运行：`TDAI_E2E_REAL_GATEWAY=1 npx vitest run --config vitest.e2e.config.ts`（新配置解除默认 exclude；afterAll 停子进程偶发超时为存量 flake，P0 轮已基线定性）。**e2e 实证的新事实**：v3 数据面按 serviceId 走 store pool 实例路由，行落 `<dataDir>/instances/<serviceId>/vectors.db`（standalone 也是；v1 物理 core 面才落 `users/<uid>/`）——回填脚本 --db 须指向实例库（脚本头已注明）。
4. **pytest（插件侧）**：现有 `test_multi_user_identity.py` 全绿不动（插件零改动，应原样通过）。

---

## 7. 实施排期（已拍板后修正）

- **P0（本次，网关侧）**：§4.2(a) dispatch 归一（subsume + user 维度端点剥离[含按 id 删] + 归一化 400 + `subsumedTeam` 资产登记跳过）+ server deps 接线 + §6.1 单测（纯函数矩阵 + dispatch 级钉测）。**前置条件（已拍板确认）**：`V3_STRICT_ISOLATION` 保持 off（归一后其实可开，但 P0 不改部署面）；接受共享 persona 一次冷启动；~~P0→B 数据迁移~~（同形免迁移，条件自动满足）。
- **P1**：✅ 全部落地（2026-09-25）：§4.2(b) default 桶写拒绝 + §4.2(c) auto-recall/per-user core isolation 穿线（6d17ba9）+ 跨代回填脚本（73f1744，dry-run 默认 + --confirm，自测含幂等/保护行）+ §6.3 e2e v3 断言（含 vitest.e2e.config.ts 接线，86d260e）。clear 链先行落地并过评审轮 3（附录 D）。§6.2 集成面已被 dispatch 级钉测等价覆盖，未单列。
- **P2**：文档转正 + pytest 钉测复核。
- **P3（09-29 上游 PR 材料）**：以"per-user routing via team-slot normalization at dispatch"独立 feature 进 PR；B（3 段语法）作为上游反馈时的升级路径备选写入讨论。

---

## 8. 决策记录（2026-09-23 拍板）

1. **目标形态：B′（系统化顶替）** ✅ —— 实施形态经 §2.1 验证修正为 **subsume**（userId 并入 teamId），而非字面"顶替"（剥离 teamId）；两者的差异即 §2.1 四接缝。
2. **P0 先行** ✅ —— 三前置确认：strict isolation 保持 off；接受共享 persona 一次冷启动；P0→B 数据迁移（后经同形结论免除，跨代会话回填列为 P1 可选项）。
3. **default 桶写拒绝** ✅（P1）；**clearMemoryContent 按 per-user 收窄** ✅/⚠️ —— store 层原语达成（team 列即 user）；但管理面 `/v3/chat-memory/clear` 链在 subsume 下断裂（无 per-user 资产 → 静默 no-op 返回 `cleared: true`），**per-user 资产 + clear 链列 P1**（§4.2(c)，评审轮 2 纠正了"零改码达成"的原表述）；**auto-recall.ts 修** ✅（P1，v1 dispatch 穿 `profileIsolation`）。
4. **机制修正两处（实施前验证，详见 §2.1/附录 B）**：P0 由"插件省略 team_id"改为"网关 dispatch 归一"（原方案会静默失效且更晚发现）；B′ 由"剥离"改为"并入"。决策意图（最快最稳解封 per-user L2/L3）不变，实现路径更稳。

---

## 附录 A：评审轮 1 记录（2026-09-23）

独立 code-review（subagent）+ 逐点代码复核，2 Critical / 6 Important / 3 Minor：

- **C1（已修）**：原稿 §4.2"两个函数收敛全部"不成立——`parseProfileIsolationScope` 丢弃 user（`profile-scope.ts:107`）、`profileMatchesScope` 仅比 team+agent（`profile-sync.ts:28-32`）、两处刚性正则（`timer-member.ts:44`、`pipeline-worker.ts:1133`）、`profileRowInScope`/row-backend 不穿 opts、`clearMemoryContent` 刻意不按 user 收窄、`auto-recall.ts` 独立构造 scope。v2 稿已改为完整清单（v3 起 B 方案搁置，清单降级为 B 的升级路径参考）。
- **C2（已修）**：原稿 §4.3 owner 写门禁会拒掉 lt-tutor 的全部核心流量，且在自报身份下不具防冒充语义。重设计为 default 桶写拒绝。
- Important（均已并入正文）：I1 P0 与 `V3_STRICT_ISOLATION` 互斥（P0 改网关侧后自然消解）；I2 P0→B 过渡数据孤儿（B′ 同形免迁移）；I3 配置穿线路径（dispatch 内单 flag 消解）；I4 `clearMemoryContent`（subsume 免改码）；I5 `auto-recall.ts`（P1 修）；I6 测试缺解析往返钉测（subsume 下无解析改动，改为 e2e L2 任务键落位断言）。
- Minor（已修）：M1 引用行号漂移；M2 `agent_id="default"` 卫生项；M3 "上游明文反对"措辞过重（v3 进一步发现顶替实为**从未端到端行使过的纸面回退**，比"设计内回退"更弱）。

## 附录 B：实施前验证记录（2026-09-23，决策后、编码前）

对"顶替语义可否直接激活"做逐列追踪（§2.1 四接缝表），全部经代码实读验证：`v2-schemas.ts:391`（teamId 缺席不补占位）、`pipeline-factory.ts:107-110/738-743`（L2 键解析→L1 查询）、`memory-store.ts:191/677`（filter 严格相等 / L1 落库 `?? ""`）、`profile-row-backend.ts:240-242`（行列取绑定 isolation）、`v2-router.ts:1783`（scenario 读用请求 ctx）、`profile-sync.ts:24-33`、`v2-router.ts:837-851/872`（读端点容忍 team 缺席）。

结论：评审轮 1 的 claim 5（P0 端到端可行）在**形状接受层**成立、在**列一致层**不成立；据此修正 P0 与 B′ 的实现路径（§8-4）。教训入档：**隔离机制的正确性验证必须落到"写入列 vs 查询条件"逐列对照，形状能解析 ≠ 数据能往返**。

## 附录 C：评审轮 2 记录（2026-09-23，P0 实施后）

独立 subagent 全链路复核（列级追踪 + 重跑测试 + 构建）：总评 **With fixes，无 Critical**——subsume 机制、dispatch 挂钩位置、端点分区（无死项）、注入封堵、默认关闭逐比特兼容全部核验通过。两条报告声明被证伪 + 四 Important，本轮全部修复：

- **声明纠正 1**："clearMemoryContent 零改码达成"→ 端到端不成立。store 层确实按人收窄，但 `/v3/chat-memory/clear` 的目标从资产记录解析（`chat-memory-handlers.ts:406-414`），subsume 下 `ensureChatMemoryAsset({team_id: uid, agent_id: "default"})` 必抛 `team_mismatch`（`metadata-service.ts:1395-1401`，且失败不进 LRU）→ 无 per-user 资产 → clear 静默 no-op 返回 `cleared: true`（隐私语义缺陷）。§4.2(c)/§8-3/§5 已改准确表述，per-user 资产 + clear 链列 P1。
- **声明纠正 2**："e2e 4/4 通过"未覆盖 subsume——e2e 文件是 v1 物理 core 套件、零 v3 断言、默认排除；测试文件里"column-level behavior is asserted end-to-end by the e2e suite"注释为假，dispatch 接线当时无任何钉测。已删假注释、补 dispatch 级钉测 5 条（§6.1）。
- **I1 资产登记必败往返**：subsume 时跳过 `ensureChatMemoryAsset`（`subsumedTeam` 标记 + `handleConversationAdd` 守卫），消除每写一次的 team_mismatch 抛错 + warn；真实 team 路径不受影响（钉测覆盖）。
- **I2 割接 delete 不对称**：`/conversation/delete`、`/atomic/delete` 从 subsume 类移入剥离类（删除语义与读对称："该用户的数据"跨两代可删；store 侧按 id/按 session 路径安全，filter 非空性不受影响）。
- **I3 dispatch 钉测缺失**：补齐（见声明纠正 2）。
- **I4 400 兼容未文档化**：§5 迁移表补"第三方 SDK user_id 值域对齐"行。
- Minor：§2.1 补 tcvdb/rowfs 作用域注（sqlite 下顶替是"静默不生效"非"饿死"，上游 PR 需先声明）；§4.2(a)-3 补读剥无条件性注；剥离测试补全 8 子路径。

## 附录 D：P1 clear 链落地记录（2026-09-24）

per-user 资产形状定案：**不建实体，clear 面加 user 寻址**（§4.2(c)）。实施面：

- store 契约 `MemoryContentClearFilter.wipeProfiles?: boolean`（缺省 true 逐比特兼容；tcvdb `memory-store.ts:2030s`/mongo `:737s` 跳过 profile 删除，sqlite 本就恒 0 天然兼容）；
- `chat-memory-handlers.ts`：`chatMemoryUserClearRequestSchema` + 模式分流（互斥在 schema 前显式判定——zod object 剥未知键，union 会让双字段请求静默落进资产模式）+ `clearChatMemoryContentForUser`（两代扫除）+ 重试泛化（`withClearRetry`，`isNonRetryableClearError` 补新错误串）+ `ChatMemoryRouterDeps.multiUserEnabled`（经 `depsWithIsolation` 从 v2Deps 自动透传，server.ts 零改动）；
- 伪 id `buildChatMemoryAssetId(uid, agent)`（复用 metadata/utils 同一构造器，审计/响应与真实资产 id 同形）；
- dispatch 级钉测 6 条（§6.1-3），multi-user 套件 33/33 绿。

决策要点存档：评审轮 2 曾把"每用户一个资产 → 管理面污染"列为担忧，实施时验证发现 standalone 下登记根本走不到那一步（metadata 空 → `agent_not_found`），真正的问题面是**资产寻址在 multiUser 部署无实体可解析**——所以修复不在这侧补实体（会引入合成 owner/key 物料/配额/team 语义错配四重新债），而在 clear 面补**与部署模型匹配的寻址维度**。user 寻址与资产寻址互斥并存：service/面板部署继续走资产，standalone multiUser 走 user。

### 附录 D 补记：评审轮 3 修正（2026-09-24，提交前）

独立 subagent 评审（列级追踪 + 重跑 48/48）：**1 Critical / 2 Important / 4 Minor**，已全部处置：

- **C1（已修）**：mongo `clearMemoryContent` 曾用同一个带 `user_id` 的 match 删 L0/L1/profiles 三表——per-user persona 是混合列 population（网关直写行带 `user_id`，管线行经 scope 解析 `user_id=""`），按 user 收窄的 profile 删除会漏掉管线行，mongo 行又内联 content → user 模式在 mongo 是"报 `cleared:true` 的部分静默擦除"。修复：profile 改独立 `profileMatch = {team_id, agent_id}`（与 tcvdb 契约对齐；自有 scope 调用下 team 槽位即 user，粒度足够）。
- **I2（已补，休眠态如实标注）**：per-user 清空契约用例加入 `__contract__/memory-store.contract.ts`（两形状钉死：扫尾 `userId+wipeProfiles:false` profile 零删；自有 scope `userId` 缺省全删含 `user_id=""` 管线行 + 旁观 team 不动）。**注**：本分支无任何后端 spec 消费该契约套件（全树仅 3 个 test 文件）——该用例此刻不被执行，待后端 harness 接线（上游 CI）后生效；mongo 修复的本地验证以 tcvdb 参照镜像 + 类型检查 + 全量套件为凭。
- **I3（已文档化）**：部分失败语义明示（代码注释 + 本节）：重试包住整个两代清除，自有 scope 已清成而共享扫尾终败时，item 报 `cleared:false` + 全零计数且不发审计——fail-loud + 幂等重试（audit 落在成功那次），终败响应低估已删量，靠 error 日志与重试收敛；逐代计数/审计列 P2 候选。
- Minor：门控与解析先后（先 zod 后 multiUser 门，均为 400，不改）；user 模式 `agent_id` 仅 trim 不做值域（管理面凭据信任级，记一笔）；文档"profiles 按 team+agent"表述随 C1 修复后两后端皆成立。
