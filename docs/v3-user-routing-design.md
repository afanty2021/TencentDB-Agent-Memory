# v3 面按 user 路由 — 设计文档

状态：设计稿（待评审）· 2026-09-23 · 基线分支 `port/multi-user-stores` @ 6194392
前置：[PORT-NOTES.md](../PORT-NOTES.md)「Out of scope」第 1 条

---

## 0. 一句话结论

上游 v3 已把 `user_id` 做成 **L0/L1 的 filter 级隔离维度**，但 **L2/L3（scene blocks + persona）显式设计为 team+agent 共享、忽略 userId**。当前移植分支上插件始终发送 `team_id="default"`，导致**所有用户的 persona 塌缩进同一个 scope**——这是 v3 面多用户的真实缺口，也正是本设计要解决的问题。推荐方案：**在 `multiUser.enabled` 下给 profile scope 增加 user 维度（Option B）**，配合网关侧 fail-closed 归一化与 owner 门禁；不建议把 v1 的每用户物理 core（`_resolveCore`）搬进 v3 dispatch。

---

## 1. 上游 v3 隔离模型（实测，非推测）

### 1.1 四层隔离键

| 层 | 隔离键 | 机制 | 证据 |
|---|---|---|---|
| instance（物理） | `instanceId = auth.serviceId`（API key → 服务身份） | 每实例独立 store pool / TCVDB / COS / MetadataService | `server.ts:1245` `resolveStore(instanceId)`；`v2-router.ts:959` `instanceId: auth.serviceId` |
| L0 conversations | `(teamId, userId, agentId, sessionId, taskId)` | **单实例内 filter 级**：写路径 record 带 userId，读路径 searchFilter | `v2-router.ts:729-733`（写）、`:939-946`（读） |
| L1 memories | 同上 | 同上；L1 提取**按 (userId, agentId, sessionId) 重分组**，每组独立写 | `pipeline-factory.ts:533-537` groupKey、`:609-611` |
| L2/L3 profiles | `team:{teamId \|\| userId \|\| "default"}\|agent:{agentId \|\| "default"}` | **userId 在 teamId 存在时被忽略**（仅在缺 team 时顶替）；存储前缀 `profiles/{scope}/`，行存走 profileScopeFilter | `profile-scope.ts:32-42`、`v2-router.ts:1556-1567` |
| chat-memory / knowledge / skill | (team, agent) / team / instance+ACL | 管理面资产，无 user 维度 | `v2-router.ts:709-716` `ensureChatMemoryAsset` |

### 1.2 请求侧解析

- `resolveIsolation()`（`v2-schemas.ts:364-393`）：body 字段优先，其次 `x-tdai-{team,user,agent,session,task}-id` 头；**缺失字段静默落 `"default"` 桶**（fail-open）。
- `V3_STRICT_ISOLATION=1`（`env-config.ts:187`）时缺三元组 → 422；**默认 OFF**。
- v3 数据面读写端点（atomic/search、conversation/*、scenario/*、core/*）全部经 `deps.requestIsolation` 消费该 ctx。

### 1.3 与本地多用户意图的根本分歧

`profile-scope.ts:37-39` 原文：

> L2/L3 are team+agent-level memories. L0/L1 keep user/session/task-level isolation, but profiles intentionally ignore userId/sessionId/taskId so one team's agent memory can accumulate across multiple sessions/users.

本地场景（lt-tutor：一个 bot 服务教师 + 被转发的多位家长）要求**每个自然人有独立 persona**。上游模型下同一 `(team, agent)` 的所有人共享一份 L2/L3——这是设计分歧，不是实现缺陷。

---

## 2. 移植分支现状：一个已存在的正确性问题

插件 v3 client（`client.py:110-131` 等）所有方法**默认且始终发送** `team_id="default"`、`agent_id="default"`；provider 侧 `self._team_id = _DEFAULT_TEAM_ID`（`__init__.py:347`）。叠加 §1.1 的 scope 规则：

| 层 | 现状 | 判定 |
|---|---|---|
| L0/L1 | 插件传 `user_id=capture_uid` / `_effective_user_id()`，写读两端 filter 均带 userId | ✅ 按人隔离成立 |
| L2/L3 | `buildProfileIsolationScope({teamId:"default", userId, agentId:"default"})` → `team:default|agent:default`，**userId 被忽略** | ❌ **全用户共享一份 persona** |

后果：混合用户会话里，L2 提取把多个人的 L1 合成进同一个 scene 集、L3 生成混合 persona——**正是 2026-09-17 生产事故（教师转发家长消息被错记身份）在 persona 层的重演类别**。插件虽然给 `core_read/scenario_ls` 传了 user_id（`__init__.py:715/724`），但因 teamId 在场而被丢弃。

另注：移植的 v1 `_resolveCore` 物理路由对当前插件是**死路径**（插件已全量走 v3 端点），仅服务 v1 遗留调用方。

---

## 3. 方案空间

| # | 方案 | 一句话 | 评估 |
|---|---|---|---|
| A | 插件省略 team_id | 让 userId 走 §1.1 的顶替语义，scope 变 `team:{userId}\|agent:default` | **零网关改动、当天可解封**；但依赖一条上游明文反对的语义（"profiles intentionally ignore userId"），scope 字符串把 user 误标成 team，未来任何真实 team_id 注入即静默塌缩。只作过渡。 |
| **B** | **multiUser 下 profile scope 增加 user 维度** | `team:{t}\|agent:{a}\|user:{u}`（仅 `multiUser.enabled` 时），归一化 + owner 门禁同步进 v3 dispatch | **推荐**。加法式改动、单点收敛（§4.2）、默认关闭时与上游逐比特兼容；向上游提 PR 的形态最干净。 |
| C | 把 `_resolveCore` 搬进 v3 dispatch | instanceId ≈ `(serviceId, userId)`，每用户全套 pipeline/state/skill/metadata | 重量级：每用户独立管线管理器、定时器、配额、元数据；service 模式下 user 虚拟实例会绕过 TCVDB/COS 实例计费边界；LRU 64 core × 全管线内存不可控。否决（standalone 数据驻留需求未来单议）。 |
| D | 每个"人"当一个 team | team_id = 人 id，白嫖 team+agent scope | 隔离成立但污染管理面（team 是有 ACL/资产语义的实体），元数据面板不可用。否决。 |

---

## 4. 推荐设计（Option B）

### 4.1 配置面

复用已移植的 `multiUser` 块（`MemoryCore/src/gateway/config.ts`），语义细化：

```yaml
multiUser:
  enabled: false        # true 时激活本设计全部行为
  ownerUserIds: []      # 已有字段：静态 initialize 允许的 user 白名单
```

不新增子开关：per-user scope、归一化、owner 门禁是一个不可拆的隔离契约，拆开会出现"归一化了但 scope 不分人"这类半隔离态。

`enabled=false`（默认）：所有行为与上游 v3 完全一致（含 fail-open default 桶），保证向上游 PR 的零风险基线。

### 4.2 改动点：两个函数收敛全部

L2/L3 的 scope 由 `buildProfileIsolationScope()`（构造 scope 字符串）与 `profileScopeFilter()`（行查询条件）这一对镜像函数派生，`v2-router.ts` 与 `pipeline-factory.ts` 各自只有一个本地包装（`buildIsolationScope` / `scopedStorage`）。改动即：

1. `profile-scope.ts`：
   - `buildProfileIsolationScope(ctx, opts?: { perUser?: boolean })` — `perUser` 时输出 `team:{teamId || "default"}|agent:{agentId || "default"}|user:{userId || "default"}`；
   - `profileScopeFilter(ctx, extra?, opts?)` 镜像：`perUser` 时 `filter.userId` 无条件参与（不再仅顶替 team）。
2. 两个包装函数把 `multiUser.enabled` 从 gateway config 传入（dispatch 侧走 deps，pipeline 侧走构造参数）。

派生面自动跟随、无需逐点改：存储前缀 `profiles/{scope}/`（v2-router.ts:1556）、`buildProfileL2Key`（pipeline-factory.ts:102）、`buildProfileStableId`（版本号哈希入 scope，新 scope 自然新版本线）、L2 分组键 `buildIsolationScope(record)`（pipeline-factory.ts:783 —— **混合用户会话自动按人分组提取**）、core/scenario 读写（scopedProfileStorage）。

### 4.3 请求面：归一化 + 门禁（fail-closed）

在 v3 dispatch（`dispatchV2Request` 解析 isolation 处）当 `multiUser.enabled`：

1. **归一化**：body/header 的 `user_id` 经已移植的 `normalizeUserId`（`^[a-z0-9_-]{1,64}$`，ASCII-only trim）；
   - 非法（超长/非法字符）→ **400**，报字段名不报值（与 v1 `_resolveCore` 契约一致）——封死 scope 字符串注入（`user_id="x|team:admin"` 构造 scope 碰撞）与 filter 注入整个类别；
   - 缺失 → 落 `default` 桶（兼容存量调用方），**不**强制 422（与 `V3_STRICT_ISOLATION` 正交，那是要不要三元组，这是值域约束）。
2. **owner 门禁**：数据面**写**端点（conversation/add、atomic/update、scenario/write、core/write）`user_id ∉ ownerUserIds`（当白名单非空）→ 403，复用 `/seed` 已有的 `resolveUserIdRouting` 判定与错误体形状。读端点不门禁（owner 模型语义是"谁的记忆允许写"，非读取 ACL）。
3. `team_id`/`agent_id` 不做值域约束（上游自由字符串，管理面已有自己的实体校验）。

### 4.4 插件面

**无需任何改动**：身份链（turn_author → on_turn_start → initialize user_id → default）已在移植时接通 v3，`user_id` 已随全部端点发送；`team_id="default"` 在 per-user scope 下无害（user 维度独立生效）。

可选卫生项（随本设计一并提）：placeholder `team_id` 改为省略——消除 `ensureChatMemoryAsset` 对 default team 的无意义登记，也让 scope 字符串语义干净。

### 4.5 明确的非目标

- **service 模式物理隔离**：user 维度在单实例内生效，不产生独立 TCVDB/COS；数据驻留级需求另立设计。
- **每用户 memory-prompt**：prompt 按 (team, agent, layer) 解析是配置分发，保持 agent 级。
- **每用户配额**：`checkMemoryQuota(auth.serviceId)` 仍是服务级；per-user quota 记为扩展点。
- **管理面（/v3/meta/*、knowledge、skill）**：资产粒度保持 (team, agent)/(team)/instance；记忆内容隔离不涉及。

---

## 5. 兼容与迁移

| 场景 | 行为 |
|---|---|
| `enabled=false` | 逐比特等于上游现行为（scope 构造函数 `opts` 缺省走原路径） |
| 开启瞬间 | 已有 `profiles/team:default\|agent:default/` 下的共享 persona **对读写双双不可见**（新 scope 前缀不同）——灰度语义即"冷启动"，旧目录原样保留可回滚 |
| 共享数据归因 | 不做自动迁移：混合人类的共享 persona 无法机器归因，需要时人工拷贝到 `profiles/...|user:{owner}/` |
| L0/L1 | 不受影响（filter 维度未变）；`V3_STRICT_ISOLATION` 可独立叠加 |

回滚：`multiUser.enabled=false` 即回上游行为，无数据破坏。

---

## 6. 测试计划（对齐现有套件）

1. **单元（vitest，`src/gateway/__tests__/`）**
   - scope 构造钉测：per-user 开/关两种模式下 `buildProfileIsolationScope` / `profileScopeFilter` 输出（含 userId 缺省落 default、team 缺省、注入串被归一化挡下）；
   - dispatch 门禁：非法 user_id 400（错误体不含原值）、非 owner 写 403、读不门禁；
   - L2 分组：混合 userId 的 L1 记录集在 per-user 模式下产出 N 个 scope 组（直接测 pipeline-factory 分组键路径）。
2. **集成（默认 vitest 可跑）**：v3 数据面双用户回归——alice/bob 各自 conversation/add → atomic_search 互不可见 → core_read 各自 persona（fake store 级）。
3. **e2e（`TDAI_E2E_REAL_GATEWAY=1` 门控，沿用现有排除约定）**：真实网关双用户写读 + L2 触发后 per-user persona 文件落位断言。
4. **pytest（插件侧）**：现有 `test_multi_user_identity.py` 全绿不动；新增一条"placeholder team_id 省略"的请求体形状钉测（若做 §4.4 卫生项）。

---

## 7. 实施排期（建议）

- **P0（解封，可先行独立合并）**：插件 placeholder `team_id` 省略 —— 用 userId 顶替语义立刻拿到 per-user L2/L3，封住 persona 混线；风险与代价最小，且与 B 不冲突（B 落地后该语义自然退役为普通缺省）。
- **P1**：§4.2 scope 双函数 + §4.3 dispatch 归一化/门禁 + §6.1-6.2 测试。
- **P2**：e2e + 文档（本文件转正）+ pytest 钉测。
- **P3（09-29 上游 PR 材料）**：本设计以"per-user profile scope mode"独立 feature 面目进 PR，与 api-key 加固链分开。

---

## 8. 决策请求

1. 是否接受 Option B 为目标形态（P1-P2）？
2. P0（插件省略 placeholder team_id）是否先行——它当天可消除 persona 混线，但短期依赖 userId 顶替语义？
3. owner 门禁只挂写端点、读端点放行，是否符合 lt-tutor 的信任模型？
