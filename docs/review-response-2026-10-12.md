# 对独立代码评审的回应

- **评审报告**：[reviews/dsh-workspace-scaffolds-review-2026-10-12.md](../../reviews/dsh-workspace-scaffolds-review-2026-10-12.md)（14 项：5 P1 / 9 P2）
- **回应日期**：2026-10-12
- **被审基线**：提交 `b042049`（v0.1.9）
- **当前状态**：**评审 14 项已全部修复**（5 P1 + 9 P2）；修复过程中另发现并修复 1 项评审之外的缺陷（**F15**）。文档末尾列出**仍未关闭的残余风险**——没有一项是「已修就不用管了」。

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
| F08 | P2 | 原生安装失败仍按成功提交 | **成立**，已现场复现（真实失败的安装被记成成功导入） | **已修** |
| F09 | P2 | tar 路径写 UTF-8、读 Latin-1 | **成立**，范围仅限 name/prefix | **已修** |
| F10 | P2 | 多文件生成边检查边写入 | **成立** | **已修** |
| F11 | P2 | 状态刷新清除操作错误 | **成立**：`refresh()` 的 `setError(null)` 覆盖操作错误 | **已修** |
| F15 | — | **评审之外，修复过程中发现**：`splitName` 静默截断超长路径 | **成立**：产出的归档连自己的读取器都拒绝（报误导性的 `duplicate-path`） | **已修** |
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

## 第三批：F08、F09、F10、F11

### F08 — 原生安装失败必须让导入失败

`#import` 里 `installOutcome` 只是把 `result.application` 抄下来，`'failed'`/`'cancelled'` 之后照样走 `store.mutate` 写包记录并返回成功。而 `#enableForWorkspace`（约 1251 行）与 `#releaseKeys`（约 1423 行）**早就**正确处理了这两个值——只有导入路径漏了。

现在 `failed`/`cancelled` 在 `store.mutate` **之前**抛 `native-operation-failed`（details 带 `packageName`/`version`/`application`/`error`/`diagnostic`）：状态与 revision 不动，重试就是一次干净的首跑。归档**有意保留**——内容寻址、无引用，重试直接复用这些字节。

**这是我第一次拿到它的现场证据**（不只是代码阅读）。复核第二批时我的脚本出现「导入成功但原生安装从未发生」：

```
IMPORT RESULT: { ..., "installOutcome": "failed", "nativeEnabled": false }
profile dependencies 中无该包；node_modules 中无该包
```

触发原因是**我自己的环境操作**，如实记录，因为这是个真实陷阱：我用 `Remove-Item workspace-scaffolds` 做重置，而 `archives/` 就在这个目录里，profile 的 `package.json` 却仍以 `file:` 声明着那些归档 → pnpm 依赖图无法满足（`ENOENT`）→ **任何**安装都失败。表现与插件缺陷完全一样，实际不是。已把「重置只删 `state.json`、绝不碰 `archives/`」写进 `verify-cycle.ps1 -Reset`，并让验证脚本在 V0 自愈悬空声明。修好 F08 之后，这类失败会**报出来**而不是被伪装成成功——这也是它值得优先修的原因。

**残留**：成功分支仍信任 `application`；若原生报 `applied` 却没真正落地，导入依旧算成功。且 `application` 缺失时默认成功——这属于定义上无法探测的失败。

### F09 — tar 路径读写编码必须一致

写侧 `block.write(entry.name, ..., 'utf8')`、读侧 `block.toString('latin1', ...)`。**我在真实实例的旧代码上直接证实了后果**：

```
entries: [..., "package/templates/æ¨¡æ¿-è¯´æ.md"]
```

修复是让读侧走同一个 `decodePathField(block, offset, length)`（UTF-8）。数值字段、`typeflag`、`octal()` 的 latin1 **有意保留**并加了注释，避免后人「统一」掉。

**策略选择：严格 UTF-8，不做「见到 U+FFFD 就回退 latin1」的启发式。**理由：U+FFFD 本身就是合法文件名字符（Node 对孤立代理项就会写它），启发式会**悄悄弄坏正确**的归档；对真正的单字节旧归档也只是把猜测换个位置，而 `extractTarball` 一旦落盘就不可撤销。行为由两个测试钉死：旧字节 → `\uFFFD`，以及合法 `package/\uFFFD.txt` 原样保留。

**影响面比想象的窄，这一点我如实说明**：`inspectTarball`/`extractTarball` 的条目名确实会乱码，但模板渲染走的是 `#descriptorOf` → `host.packageDir()`，读的是**安装到 node_modules 的目录**（文件名完好），所以乱码从未到达渲染路径——我的端到端 CJK 检查在修复前后都通过，**它不是判别性检查，只是守卫**。判别性证据在 `test/archive.test.mjs` 的往返测试。修它是因为往返必须无损，而不是因为用户看见了乱码。

### F10 — 应用阶段必须整批原子

原先检查与写入在同一个循环里，第 3 个文件冲突时前两个已经落盘。现在严格两阶段：**检查阶段**只读（真实路径 → `inspectPath` → 内容比对），任何冲突在写入前抛出，`created` 是真的空数组；**写入阶段**只写缺失文件，写前先记录本次仍缺失的各级目录。

I/O 失败实现了**回滚**（`rollBackCreated`）：反序 unlink、再反序 rmdir 且只删空目录。安全性论证：检查阶段已证明目标原本不存在，文件由 `writeFileAtomic(..., {overwrite: false})`（`open 'wx'`，不可能覆盖或截断已存在条目）独占创建，因此这些路径属于本次调用。额外一道保险：unlink 前重读并比对**摘要**，若有人在「创建→回滚」窗口内改写过就保留并上报（`rollbackFailed`），因为盲删会毁用户数据。

**F15 之外的诚实边界**（README 已按此校准，不再是无条件强承诺）：

1. **回滚自身失败**（`unlink` 遇占用/权限/EIO）→ 文件留下，但 `rollbackFailed`/`leftBehind`/`partial` 如实上报；
2. **创建→回滚窗口内被用户改写** → 有意保留并报 `rollback-incomplete`；
3. **进程被硬杀或断电** → 两次写入之间没有回滚路径，会留下部分文件（只有「暂存目录 + rename」能解决，超出本次范围）；
4. 本次创建的目录若届时非空则保留（正确，但算残留）。

### F11 — 面板的两条错误通道

`refresh()` 成功时的 `setError(null)` 会把刚设的操作错误抹掉，于是**操作失败的原因永远不显示**。修复采用**两条独立通道**（`error` = 操作失败，`loadError` = 快照读取失败），两者同屏渲染、操作错误在前。

**没有采用「先 `await refresh()` 再 `setError`」这个最直接的改法**，因为它仍是单槽零和：`run()` 的 catch 里若刷新自身失败，后写的那条必然盖掉另一条——修复前实测正是**加载错误反过来盖掉操作错误**。分开之后语义可判定：操作失败不被成功刷新清除；刷新失败只写加载通道；两者同时为真则都显示。新增 1 个 locale key（`loadFailed`），由 `scripts/locales.mjs` 生成。

**这一项只有单元测试，没有现场检查**——它需要真实浏览器。面板的**视觉渲染**自始至终是本项目唯一未人眼验证的部分。


## 验证

全部修改都在**隔离的 DSH 0.2.0-rc2 实例**（`D:\dsh-verify-020rc2`，端口 19400）上验证，不触碰日常工作 profile。

**单元测试：171/171**（原 106；第一批 +13，第二批 +22，第三批 +30）。每项修复都补了**能区分**的回归测试——把修复拆掉后测试确实失败：

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
| F08 → 还原 `operations.js` | 5 条中 4 条 | `Missing expected rejection`（失败的安装被记成成功导入） |
| F09 → 还原 `tar.js` 为 latin1 读取 | 7 条中 6 条 | `actual ['package/æ¨¡æ\x9D¿'…]`、`package/å¾\x88é\x95¿…`、emoji 路径乱码 |
| F10 → 还原 `templates.js` | 8 条中 7 条 | `a blocked batch must report zero created files; actual: ['conflict/a.txt','conflict/b.txt']` |
| F11 → 还原 `client.js` | 5 条 | 操作错误被随后的刷新抹掉（`sectionResult` 整段消失） |
| F15 → 还原截断版 `splitName` | 4 条中 3 条 | 归档被产出但 `inspectTarball` 报 `duplicate-path`；`field` 为 `undefined` |

**隔离实例端到端：66/66**（第一批后 46，第二批后 58），零失败。三批的现场复核：

```
V10  F01：unbind 一个脚手架 → released=[notes] checksEnabled=true，工程仍 ready
V11  F12：真实 agent 回合触发自动恢复 → 第二个工程 awake，持有者 1→2
V12  F05：未满足的声明依赖 → wake 报 dependency-missing；
         且 requires 跨状态重载存活（[{name:'pkg-that-does-not-exist',version:'9.9.9'}]）
V13  F06：重复导入后仍 managed/pinned=false，且仍能休眠（outcome=applied）
V14  F07：只传 enabled:false 被接受，required/templateId/templateValues 不变
V15  F14：必需脚手架被停用 → ready=false 且带 not-enabled blocker；重新启用 → ready=true
V17  F09：CJK 模板源渲染正确（守卫，非判别性——见上文影响面说明）
V18  F10：预览后冲突 → template-conflict 且 leftovers=[]（修复前为 [docs/PROJECT-NOTES.md]）
V19  F08：真实失败的安装 → code=native-operation-failed、recorded=false、工作区无绑定；
         排掉环境故障后重试成功（outcome=applied），证明未留脏状态
```

**两项没有现场判别性检查，如实标注**：

- **F13** 只能靠单元测试。热载入要求「插件装配时恰好有 agent 在跑」，而那时插件还没有任何工程状态可排队，回合又只有几秒——现场无法构造。
- **F11** 需要真实浏览器。它只在无头环境验证了状态、渲染文本与请求序列；面板的**视觉渲染**自始至终未被人眼确认。

**V19 的搭台方式**值得记录，因为我的第一次尝试是错的：我原以为「模块 import 时抛错」能让 `installBundle` 失败——实测**不能**，安装阶段不导入模块（该探针报 `applied`，而直接 `import()` 它确实 reject）。那会让检查在修复前后都失败、测不到任何东西。最终改用**真实触发条件**：往 profile 里声明一个指向不存在归档的 `file:` 依赖，使 pnpm 依赖图无法满足。这不是 mock，就是当初真实撞到的那个故障；运行结束后在 `finally` 里撤销，并断言重试成功。

## F15 — 评审之外，本轮发现的缺陷

**发现者**：修 F09 的那位 worker，在写往返测试时撞到；它按边界要求**没有**越界修改，而是报告了现象。我判断值得当场修，因为它产出的是**自我矛盾的归档**。

`splitName(relativePath)` 负责把路径拆进 USTAR 的 `name`(100B) / `prefix`(155B)。它只校验「最后一段 ≤ 100」与「候选 prefix ≤ 155」；候选 prefix 超长时它从尾部 pop 目录段**然后直接返回**——被 pop 掉的段就丢了，返回的路径比输入短。

实测（6 层各 30 字节的中文目录 + 文件，应有路径 203 字节）：第 6 层目录项与它的文件**都被折叠成第 5 层路径**（162 字节），于是 `inspectTarball` 用 `archive-invalid / duplicate-path` 拒绝了 `packDirectory` **刚刚产出的**归档。也就是说：包一旦深到 prefix 装不下，得到的是**不可导入的包**，而且错误信息指向 `duplicate-path`（误导），而不是「路径太长」。相比之下单个路径段 >100 字节时会正确地报 `path-too-long`。

修法：`splitName` 由深到浅搜索合法切分，搜不到就抛 `archive-invalid / path-too-long`（details 带 `bytes`/`field`/`nameBytes`/`nameLimit`/`prefixLimit`），**绝不返回截断路径**。

---

## 仍未关闭的残余风险

修复完成了，但这些不是「已修就不用管」：

1. **F02/F03 的 TOCTOU**：真实路径检查与写入是两次系统调用，Node 没有 `openat` 类 API 把二者绑定，能替换目录的人仍可在窗口期内改写目标。
2. **F10 —— 回滚自身失败时**（`unlink` 遇文件占用/权限/EIO）文件会留下；**进程被硬杀或断电**时两次写入之间没有回滚路径。两种情况都会如实上报（`rolledBack`/`leftBehind`/`partial`），README 已按此校准，不再是无条件强承诺。
3. **F10 的回滚摘要保险是死分支**：它需要「创建→回滚」亚毫秒窗口内被改写，无法稳定构造，因此**没有被测试覆盖**（作者如实说明，我未假装覆盖）。
4. **F08 —— 成功分支仍信任 `application`**：若原生报 `applied` 却没真正落地，导入仍算成功；`application` 缺失时默认成功，属于定义上无法探测的失败。
5. **F09 —— 模板渲染路径不消费归档条目名**（走 `host.packageDir()` 读已安装目录），所以这次修的是**内部往返保真**；我没有证明任何用户可见症状，也没有那样声称。端到端 CJK 检查只是守卫，判别性证据在单元测试。
6. **旧记录缺少 `requires` 时依赖规则不生效**（F05 的取舍）：重新导入同一快照可恢复边；面板上看不出「旧记录」与「真的没声明依赖」的区别。
7. **F13 的窄口子**：刚创建的 agent 尚未在 `listAgents()` 里显示为 running 时若收到一次空闲事件，可能提前排空队列（仅在已有排队休眠时有影响）。
8. **F15 —— Windows MAX_PATH 在本模块仍未处理**；单个路径段 >100 字节会让整个包被拒（正确，但用户可能不理解原因）。
9. **面板的视觉渲染自始至终未被人眼验证**。F11 让两条错误通道同屏之后，这一点比以前更值得看一次。
10. **F11 只在无头环境验证了状态与渲染文本**，没有验证真实浏览器里的观感与 `role="alert"` 的行为。

