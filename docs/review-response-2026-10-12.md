# 对独立代码评审的回应

- **评审报告**：[reviews/dsh-workspace-scaffolds-review-2026-10-12.md](../../reviews/dsh-workspace-scaffolds-review-2026-10-12.md)（14 项：5 P1 / 9 P2）
- **回应日期**：2026-10-12
- **被审基线**：提交 `b042049`（v0.1.9）
- **当前状态**：**14 项中已修 10 项**（5 P1 + 5 P2）→ v0.1.11；**4 项 P2 未修**，逐项列在下面，没有当作已完成。

## 逐条对照

| 编号 | 等级 | 评审结论 | 我的核对 | 状态 |
|---|---|---|---|---|
| F01 | P1 | 解绑一个关联会停用同工程其他脚手架 | **成立**，是我引入的回归 | **已修** v0.1.10 |
| F02 | P1 | 状态写锁未覆盖原生副作用与最终提交 | **成立**（结构确认） | **已修** v0.1.10 |
| F03 | P1 | 模板目标只做字符串路径检查，可经 junction 越界写 | **成立** | **已修** v0.1.10 |
| F04 | P1 | 目录打包用 `stat` 跟随链接，外部内容进归档 | **成立**，注释与实现不符 | **已修** v0.1.10 |
| F05 | P2 | `requires` 在摘要与规范化中丢失 | **成立**：依赖机制在真实链路上是死代码 | **已修** v0.1.11 |
| F06 | P2 | 重复导入覆盖所有权与常驻标记 | **成立**：会覆盖 0.1.6 引入的 `lastAppliedEnabled` | **已修** v0.1.11 |
| F07 | P2 | 部分更新丢失「字段未提供」语义 | **成立**：`jsonSafe` 把 `undefined` 变 `null` | **已修** v0.1.11 |
| F08 | P2 | 原生安装失败仍按成功提交 | **成立**，且已现场复现（见下） | 未修 |
| F09 | P2 | tar 路径写 UTF-8、读 Latin-1 | **成立**，范围仅限 name/prefix | 未修 |
| F10 | P2 | 多文件生成边检查边写入 | **成立** | 未修（README 承诺已先改正） |
| F11 | P2 | 状态刷新清除操作错误 | **成立**：`refresh()` 的 `setError(null)` 覆盖操作错误 | 未修 |
| F12 | P1 | 自动恢复提前返回，未建立工程使用关系 | **成立** | **已修** v0.1.10 |
| F13 | P2 | 热载入未初始化已有 agent 状态 | **成立**：`attach` 从不播种 `statuses` | **已修** v0.1.11 |
| F14 | P2 | `ready` 排除必需包未启用的阻塞 | **成立** | **已修** v0.1.11 |

**14 项我逐条对着代码核过，没有一项是虚的。**评审对 F03 的影响范围（只证明能创建工程外新文件、不声称能覆盖任意已有文件）和 F04 的边界（只有本地归档、未观察到网络外传）都做了准确限定，没有夸大。

---

## 第一批（v0.1.10）：全部 5 项 P1

### F01 — 解绑只释放被移除的那个关联

根因是我自己引入的：为了修「解绑后没什么可释放」，我把 `planSleep` 移到了删除之前——它算的是**整个工程休眠**的计划，于是从「释放不到」变成「释放全部」。

新增纯函数 `planUnbind(state, workspaceId, bindingId)`（`src/coordinator.js`）：只把被移除关联对应的包当作候选，并在模拟删除后的状态上重新计算使用关系；被禁用的关联直接返回空计划，因为它本来就没占用任何东西。

**我未采纳评审建议的一部分**，并说明理由：评审还建议「让原生释放遵守空闲保护」。我没有加。休眠排队是因为它是关于一个**正在使用中**的工程的背景意图；而解绑是用户刚刚做出的**显式重配置**，且工具列表按模型请求固定，进行中的回合不会被切断。这是判断分歧，不是遗漏。

### F02 — 操作级串行

新增 `#critical()`（`src/operations.js`）：一条 promise 链，把**完整变更操作**（版本校验 → 原生副作用 → 提交 → 事件对账）包成互斥段。延迟休眠与事件对账也走同一条链。不可重入，注释写明。

**背景模式顺带补了两个隐患**：进度条目原先依赖 `#dispatch` 同步登记，串行后不再保证；队列内的失败原先会被静默吞掉（正是 F08 那类「失败报成成功」），现在写入进度条目。

### F03 / F04 — 真实路径边界

- **F04**：`walk()` 改用 `lstat()`（`stat()` 会先跟随链接，原来的 `isSymbolicLink()` 永远为假），并对 dirent 直接判链接。实测确认 Windows junction 在 `lstat` 下 `isSymbolicLink()` 为真。
- **F03**：新增 `resolveInsideReal()`——字面检查之后，`realpath` 工程根，并解析目标**最近的已存在祖先**的真实路径，要求落在真实根内。`resolveInside` 一字未改。

**残余风险如实保留**：检查与写入是两次系统调用，能替换目录的人在两者之间插入 junction 仍可改写目标；Node 没有 `openat` 类 API 把检查与写入绑定，无法在这一层关闭。

### F12 — 自动恢复必须登记使用关系

`index.js` 删掉了「所有包都已启用就提前返回」的判断。原先它把「原生没什么要启用的」等同于「没什么要恢复的」，于是工程停在 `sleeping`、从不登记为持有者，随后另一个工程休眠就把共享包停掉了。

---

## 第二批（v0.1.11）：F05、F06、F07、F13、F14

### F05 — 依赖声明必须真的生效

`requires` 在**两处**被丢弃：`summarizeDescriptor` 不返回它、`normalizePackage` 也不保留它。于是 `dependencyOrder` 读到的永远是 `[]`——依赖排序、缺失依赖拒绝、环检测在真实链路上**从未生效**；单元测试能过是因为它们手工构造了带 `requires` 的记录。

新增共享的 `readRequires()`（`src/schema.js`），同时供描述符读取与状态规范化使用（一份定义，两条路径都不可能出现未校验的边）。

**旧记录的选择**：缺 `requires` 键的记录规范化为 `[]`，即依赖规则对它不生效。理由：`normalizeState` 是纯同步函数（还被 `Store.mutate` 直接调用），从归档重新补读 descriptor 是它做不到的 I/O；`[]` 也是对旧文档最诚实的读法。代价可挽回——重新导入同一快照会用 descriptor 重写记录并恢复边；面板上看不出「旧记录」与「真的没声明依赖」的区别，这一残留已记录。

### F06 — 重复导入不得改写归属

`#import` 原先无条件用 `after.enabled`（**当前原生是否启用**）重推归属。一个被本插件启用过的受管包重复导入一次就会变成 `external` + `pinned=true`，**从此再也休眠不掉**；用户显式设的 `pinned` 也会被冲掉；`lastAppliedEnabled` 同时被覆盖，等于 0.1.6 的跨重启修复在重复导入后失效。

现在记录已存在时用 `{ ...previous, ...archive }`：只刷新归档派生元数据，保留 `ownership`/`pinned`/`lastAppliedEnabled`/`initiallyEnabled`/`importedAt`。

### F07 — 部分更新

根因是 `src/store.js` 的 `jsonSafe` 把 `undefined` 变成 `null`，于是「字段未提供」与「显式 null」不可区分：只传 `enabled:false` 会被拒（报 `required` 类型错），而省略的 `templateId` 会被写成 `null`。

现在在**原始 request** 上判断字段是否提供，构造稀疏对象后再交给 `jsonSafe`；全局 `jsonSafe` 未改（它有很多调用点）。

**显式 `null` 的语义**（已由测试固定）：`enabled`/`required`/`autoRestore` 是布尔，显式 `null` 拒绝；`templateId: null` **接受并清空**（存储层 `null` 本义就是「用描述符默认模板」）；`templateValues: null`/数组/非对象拒绝，清空用 `{}`。

> **超出评审原文的一处收紧**：`templateValues` 传数组或非对象以前会被存储层**静默变成 `{}`**，现在报 `invalid-request`。这属于顺带修正的静默降级，有测试固定。

### F13 — 热载入漏掉空闲转换

`Activity.attach` 从不把挂载时已存在的 agent 播种进 `statuses`，而状态处理器靠 `before && !busy()` 判断「由忙转闲」；DSH 又是**先更新状态、再发事件**，所以缓存是唯一见证——缓存为空时该转换被吞掉，排队的休眠永不排空。

两处改动：`attach()` 用 `host.listAgents()` 播种缓存；两个处理器改调 `#settleIdle()`，判据从「我刚跟踪的 agent 停了吗」改为「**现在**还有在跑的吗」。

**机制隔离验证**（subagent 做的，值得记录）：只加播种 → 仍有 1 条测试失败（「running 事件丢失」那条）；只加兜底 → 全过。也就是说**兜底规则是承重的**，播种是评审明确要求、并让缓存成为可信见证。我另外独立确认了「过度通知」这个设计前提成立：`SleepQueue.drain()` 在队列空时立即返回，重入调用 join 在飞的那次，所以多通知几次是安全的。

### F14 — ready 必须与 blockers 同源

`requiredBlocked` 原先显式排除 `not-enabled`，于是必需脚手架实际没启用时仍报 `ready: true`。现在 `ready` 完全由 blockers 推出，`binding.enabled === false`（用户主动 opt-out）仍在循环开头跳过。

> **我随后补的一处同源不一致**：`absent`/`mismatch` 两类 blocker 原先不带 `required`，导致**可选**关联「只是关着」不阻塞、但「不在盘上」却阻塞——同一类不一致的反方向。已给这两处补上 `required`，并加了回归测试（拆掉这两行后测试失败）。

---

## 验证过程中额外发现的：F08 的现场复现

复核第二批时，我的验证脚本出现「导入成功但原生安装从未发生」，排查后拿到完整证据链：

```
IMPORT RESULT: { ..., "installOutcome": "failed", "nativeEnabled": false }
profile dependencies 中无该包；node_modules 中无该包
```

即：`pluginManager/installBundle` 返回 `application: "failed"`，而 `#import` 仍返回一个**看似成功**的结果并把包记入状态。这正是评审 F08 所述的「原生安装失败仍按成功提交」，现在有了真实的现场证据（而不只是代码阅读）。

**触发它的原因是我自己的环境操作**，如实记录，因为它是一个真实的陷阱：我用 `Remove-Item workspace-scaffolds` 做「重置」，而 `archives/` 就在这个目录里，profile 的 `package.json` 却仍以 `file:` 声明着那些归档。于是 pnpm 的依赖图无法满足（`ENOENT`），**任何**安装都失败。表现与插件缺陷完全一样，实际不是。

已做两件事：把「重置只删 `state.json`、绝不碰 `archives/`」写进 `.dsh-inspect/verify-cycle.ps1 -Reset`；并让验证脚本在 V0 自愈——清理归档已不存在且属于本验证探针命名空间的声明。**但 F08 本身仍未修**，所以这类失败仍会被报成成功。

---

## 验证

全部修改都在**隔离的 DSH 0.2.0-rc2 实例**（`D:\dsh-verify-020rc2`，端口 19400）上验证，不触碰日常工作 profile。

**单元测试：141/141**（原 106；第一批 +13，第二批 +22）。每项修复都补了**能区分**的回归测试——把修复拆掉后测试确实失败：

| 拆分哪处修复 | 失败的测试 | 失败信息 |
|---|---|---|
| F01 → 换回 `planSleep` | 解绑后其他脚手架仍运行 / 解绑未启用的关联不改原生状态 | 两个脚手架都被停用 |
| F02 → 令 `#critical` 直通 | 延迟休眠不得留下「awake 但包已关」 | `requestedState=awake must agree with native enabled=false` |
| F12 → 恢复提前返回 | 自动恢复必须登记共享持有者 | `the automatically restored workspace must be awake` |
| F05 → 还原 `operations.js` 到 27fd003 | 7 条中 5 条 | 缺失依赖的 `wake` 竟然成功；环也成功；`requires` 字段为 `undefined` |
| F06 → 同上 | 3 条中 2 条 | `ownership actual 'external' expected 'managed'`；`pinned actual false expected true` |
| F07 → 同上 | 4 条中 3 条 | `invalid-request {field:'required'}` |
| F14 → 同上 | 2 条中 1 条 | `ready actual true expected false` |
| 可选的缺失包阻塞 ready → 撤销两行 | 1 条 | 可选关联比「只是关着」还严格 |
| F13 → 还原 `lifecycle.js` | 4 条中 3 条 | 排队的休眠不排空（2100 ms 超时） |

**隔离实例端到端：58/58**（第一批后为 46），零失败。两批的现场复核：

```
V10  F01：unbind 一个脚手架 → released=[notes] checksEnabled=true，工程仍 ready
V11  F12：真实 agent 回合触发自动恢复 → 第二个工程 awake，持有者 1→2
V12  F05：未满足的声明依赖 → wake 报 dependency-missing；
         且 requires 跨状态重载存活（[{name:'pkg-that-does-not-exist',version:'9.9.9'}]）
V13  F06：重复导入后仍 managed/pinned=false，且仍能休眠（outcome=applied）
V14  F07：只传 enabled:false 被接受，required/templateId/templateValues 不变
V15  F14：必需脚手架被停用 → ready=false 且带 not-enabled blocker；重新启用 → ready=true
```

**未在现场做判别性检查的一项**：F13 只能靠单元测试。热载入要求「插件装配时恰好有 agent 在跑」，而那时插件还没有任何工程状态可排队，回合又只有几秒——现场无法构造，已在前面如实标注。

## 仍未修（4 项 P2）

**第三批**：F08（原生安装失败报成功）、F09（tar 中文路径乱码）、F10（应用阶段部分写入）、F11（面板吞掉操作错误）。

其中 **F08 最该先修**：它会把任何原生安装失败伪装成成功导入，本次验证过程中已现场撞到（见上），并且它让「安装成功」这个前提在其余所有判断里都不可信。
