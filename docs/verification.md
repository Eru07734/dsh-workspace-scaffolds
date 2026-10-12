# 验证记录

> ## 状态：**仅部分验证 · PARTIALLY VERIFIED**
>
> 本插件已在**真实 DSH**（profile `desktop`）中安装并热载入成功。宿主侧的安装、加载、HTTP 接口、原生服务解析与错误处理已有实测证据；**核心工作流（导入 → 关联 → 生成 → 启用 → 休眠 → 恢复）与浏览器面板仍未在真实环境跑通**，目前只有假宿主上的自动化证据。
>
> 本项目 v0.1.0 发布时未附声明，v0.1.1 起补齐；v0.1.3 起由「未验证」更新为「部分验证」。

本文件记录 `dsh-workspace-scaffolds` 的验证方式、覆盖范围与当前结论。

## 真实环境实测

2026-10-12，在本机 DSH（`DSH_PROFILE=desktop`，`DSH_HOME=D:\dsh-home-desktop`）上执行。

**安装**（经 `pluginManager/installBundle`，spec 为本地 `.tgz`）：

```
stage=enable  target=dsh-workspace-scaffolds  enabled=true  changed=true
application=applied          <-- 热载入，无需重启
packageResult.exitCode=0
warnings=[]
```

**加载结果**（`pluginManager/listPlugins`）：

```
entryId=include:workspace-scaffolds  moduleName=dsh-workspace-scaffolds  enabled=true  fiberPhase=active
```

`fiberPhase=active` 说明条目真的挂上了，而不只是写进了配置。

**HTTP 接口**（带会话 Cookie 的真实请求）：

```
GET /api/workspace-scaffolds/state -> HTTP 200
{"ok":true,"value":{"revision":0,"profileName":"desktop", ... ,
 "capabilities":{"pluginManager":true,"workspaceRegistry":true},
 "workspaces":[], "unmanagedWorkspaces":[{"title":"Artex改","path":"D:\\Artex改"}, ...]}}
```

证明：两个原生服务都解析成功；能读取真实工程注册表；`runningAgents` 正确反映当前有 agent 在跑。

**错误路径**（实测）：

| 调用 | 结果 | 判定 |
|---|---|---|
| 缺 `operationId` | 400 `invalid-request {field: operationId}` | ✅ |
| 未知 action | 400，并列出允许的 action | ✅ |
| 过期 revision 的 `sleep` | **200 no-op** | ❌ 缺陷，见下 |
| 正确 revision 的 `sleep`（未关联工作区） | 200 `{status: no-op, reason: unassociated}`，revision 不变 | ✅ |

## 真实环境发现并已修复的缺陷

### 缺陷 2：过期 revision 在 no-op 路径上被忽略

**现象**：带 `expectedRevision = revision + 99` 的 `sleep` 返回 **HTTP 200 成功**，而不是 `revision-conflict`。

**根因**：revision 校验只发生在 `store.mutate()` 内部。`#sleep` 对「工作区未关联」这一分支在调用 `mutate` **之前**就返回了，于是校验被完全绕过。`#wake` 有同样的顺序问题，且会先抛 `workspace-not-found`，把 revision 冲突掩盖成另一种错误。

**为什么危险**：调用方会收到一个成功，却无从知道自己的快照是过期的。no-op 本身不写任何东西、不会丢更新，所以危害不是数据损坏，而是**把「你的状态已过期」误报成「一切正常」**，让真实的并发问题在更晚、更难定位的地方才暴露。

**修复**：把重放检查与 revision 检查**上移到 `execute()`**，对所有写动作统一、按固定顺序执行：

1. 先查幂等日志——`operationId` 相同且参数相同即为重试，必须返回原结果，即便 revision 已经前进；
2. 再校验 revision——过期即拒绝，**无论该动作是否本来会 no-op**。

同时删除了九个写动作内部重复的重放检查（已不可达）。

### 诊断缺口 3：无法回答「现在跑的是哪个构建」

**现象**：更新到 0.1.3 后，`installBundle` 返回 `application: "restart-required"`（已实测，与源码中 `Object.hasOwn(before, name)` 分支一致），说明磁盘是 0.1.3、内存仍是 0.1.2。但**没有任何接口能直接确认这一点**——只能拿缺陷 2 的行为当探针：发一个过期 revision 的请求，200 说明还是旧代码，409 说明已是新的。

**为什么是问题**：用一个已知缺陷去探测版本，意味着一旦缺陷修好，探测手段也随之失效；而且它只能回答「是不是那一版」，不能回答「到底是哪一版」。

**修复**：`list` 与 `GET /state` 增加 `pluginVersion`（读自**运行中模块自身**的 `package.json`，而非 profile 声明）、`profileSpec`（profile 声明的 spec）与 `restartPending`。面板标题行显示版本，并在两者不一致时给出重启提示。

**边界**：`restartPending` 只对 `file:` / `link:` 这类把具体产物写进字符串的本地 spec 判定；注册表范围（`^0.1.0`）描述的是可接受集合而非另一个构建，永不报告为待重启。版本读不到时返回 `false`，不把「未知」伪装成结论。

**回归测试**（`test/operations.test.mjs`）：三项，分别锁定「过期 revision 即使会 no-op 也必须拒绝」「`wake` 的过期 revision 报冲突而不是找不到工作区」「重放仍优先于 revision 校验」。修复前的行为就是实测到的 200。

## 运行方式

```bash
node --test test/*.test.mjs
```

测试不接触用户的日常 profile：全部在临时目录中运行，通过 `test/helpers/fake-host.mjs` 构造内存服务，再由**真实的** `src/host.js` 适配层包装。因此适配层自身的契约（尤其 `installBundle(spec, {enabled:false})`、`setBundleEnabled`、`workspaceRegistry` 的实体形状）是被真实执行的，而不是被桩掉的。

## 覆盖矩阵

| 编号 | 场景 | 断言的事实 | 测试位置 |
|---|---|---|---|
| A1 | 开工前准备 | 导入不启用；预览准确；生成文件；恢复后包被启用；工程就绪 | `operations.test.mjs` |
| A2 | 工作中追加 | `wake` 返回 `effectiveFrom: next-model-request`，不伪称当前请求已变 | `operations.test.mjs` |
| A5 | 两工程共享一个包 | 一个工程休眠不会停用该包，保留原因 `other-workspace` | `operations.test.mjs` |
| A6 | 全部使用方休眠 | 托管包被停用，安装与归档保留 | `operations.test.mjs` |
| A7 | 原本全局启用的插件 | 标记 `external` + `pinned`，休眠不关闭它 | `operations.test.mjs` |
| A8 | 同包不同版本 | 关联与恢复都报 `version-conflict`，不替换运行中的版本 | `operations.test.mjs`（A9 用例） |
| A9 | 必需包失败 | 工程不就绪，并回滚本次新启用且无人需要的包 | `operations.test.mjs` |
| A11 | 有任务时请求休眠 | 返回 `pending-idle`，包保持启用；空闲后队列自动完成 | `operations.test.mjs` |
| A11b | 休眠排队后被唤醒 | 取消的休眠不会在空闲后反向停用 | `operations.test.mjs` |
| A12 | 并发修改 | 过期 `revision` 被拒绝，错误里带当前 revision | `operations.test.mjs`、`store.test.mjs` |
| A13 | `operationId` 重试 | 重放返回记录结果，不重复安装；换参数报 `operation-id-reused` | `operations.test.mjs`、`store.test.mjs` |
| A14 | 预览后目标被改 | `template-apply` 整批拒绝，用户内容保留 | `operations.test.mjs`、`templates.test.mjs` |
| A14b | 文件已存在且相同 | 跳过而不是覆盖；重复生成无副作用 | `operations.test.mjs` |
| A15 | 路径穿越 | `../`、绝对路径、ADS、junction 逃逸全部拒绝 | `archive.test.mjs` |
| A16 | 状态损坏 / 未来版本 | 有备份则恢复；无备份报 `state-corrupt`；未来 `schemaVersion` 拒绝 | `store.test.mjs` |
| A18 | 归档仍被引用 | 拒绝删除（`archive-in-use`） | `operations.test.mjs` |
| A20 | 解除关联 | 释放占用并停用，但生成的文件保留 | `operations.test.mjs` |
| A21 | 无归档的已安装包 | 记录为 `installed-only`，不谎称有完整备份 | `operations.test.mjs`（A7） |
| A22 | 重启后恢复 | 新建 Store 重新读取后关联与版本仍在，可再次唤醒 | `operations.test.mjs` |
| — | 包格式校验 | 非 bundle 目录、非法 `scaffold.json` 在安装**之前**被拒绝 | `operations.test.mjs` |
| — | 归档安全 | `..`、绝对路径、符号链接、硬链接、重复条目、超限全部拒绝 | `archive.test.mjs` |
| — | 决策规则 | 租约推导、依赖顺序、环路检测、缺失依赖、pinned/external 保护 | `coordinator.test.mjs` |
| — | 变量与占位符 | 必填校验、`maxLength`、未知占位符拒绝、未知变量拒绝 | `templates.test.mjs` |
| — | 面板渲染 | 用**真实** `list` 载荷渲染面板不抛异常；错误码与降级状态可见 | `client.test.mjs` |
| — | agent 工具 | 写操作必须带 revision；会话工作目录解析；工作区外不猜测 | `tool.test.mjs` |
| — | 插件装配 | `apply` 挂载两条路由、一个工具、四个生命周期监听；拆除不抛异常 | `plugin.test.mjs` |
| — | HTTP 端到端 | `/state` 与 `/execute` 的信封、409 版本冲突、400 非法输入 | `plugin.test.mjs` |
| — | 示例包 | 两个示例走完 导入 → 关联 → 预览 → 生成 → 恢复 → 休眠，占位符全部替换 | `examples.test.mjs` |

## 当前结果

```
ℹ tests 88
ℹ pass 88
ℹ fail 0
```

## 自举测试：用本插件管理它自己的工程

2026-10-12，把插件仓库 `C:\Users\jyj20\DSH 插件\dsh-workspace-scaffolds` 注册为 DSH 工程（`workspaceId = 0b97b770-1295-4098-ac7e-badebb9be055`），然后用本插件管理它自己。

已完成并在真实环境中验证：

| 步骤 | 结果 |
|---|---|
| 导入两个示例包 | `installOutcome=applied`，`nativeEnabled=false`（安装与启用分离），内容哈希 `1c7ee7c5…`、`93fdad26…` |
| 关联到工程 | 两个 binding 建立成功 |
| 读取模板描述 | 变量正确读出：notes 有 `projectName`/`owner`，checks 只有 `projectName` |
| 生成预览 | 3 个文件全部 `create`，无冲突 |
| 应用模板 | `created=["docs/PROJECT-NOTES.md","docs/DECISIONS.md"]`、`["docs/CHECKS.md"]` |
| 变量替换 | 生成内容为 `# dsh-workspace-scaffolds · 工程笔记`、`负责人：Eru07734` |
| 延迟休眠 | 有 agent 在跑时返回 `pending-idle` 并排队，bundle 保持 enabled，`ready=false` |

**这一步立刻抓出了缺陷 4**（见下）。两个示例包的预览与应用路径是正确的；缺陷出在恢复（启用）环节。

### 重启后复验（0.1.5）

重启后确认 0.1.5 已载入，并复验缺陷 4 的修复在真实环境生效：

```
pluginVersion  : 0.1.5
profileSpec    : file:C:/Users/jyj20/DSH 插件/.../dsh-workspace-scaffolds-0.1.5.tgz
restartPending : false

wake -> applied: [already-enabled, already-enabled]  failures: []  ready: true
   dsh-scaffold-notes   native=enabled  pinned=false  heldBy=1
   dsh-scaffold-checks  native=enabled  pinned=false  heldBy=1
```

修复前完全相同的序列必然把两个包钉死（12:57:21 与 13:04:22 两条 `reconcile` 日志即证据）。**这是缺陷 4 修复的真实验证。**

### 能力可用性（关键证据）

启用 `dsh-scaffold-checks` 之后，在**下一次模型请求**中直接调用它注册的工具，成功返回真实数据：

```
project_checklist(path: "...\dsh-workspace-scaffolds")
-> { ok: true, present: [README.md, docs, .gitignore, LICENSE, package.json], missing: [] }
```

这一条同时证明了整条链路：**关联 → 热启用（无重启）→ bundle 注册工具 → 下一次请求即可调用**，即 `effectiveFrom: "next-model-request"` 的字面含义。插件自己的 `workspace_scaffolds` 工具同样可调用，返回完整状态（`pluginVersion=0.1.5`、`pinned=false`、`ready=true`）。

### 一次被推翻的判断（方法教训）

中途我曾判断「重启对账把两个包都钉住了」。核对 revision 后**推翻**：全程正好 12 次写、每次都有日志条目，**重启后没有任何 reconcile 写入**。真实原因是旧进程（0.1.2）在我安装 0.1.5 时收到 `plugin-manager/changed`，被有缺陷的监听器重新钉住。**教训：状态时间线要靠 revision 计数与操作日志交叉核对，不能只看当前字段值就归因。**

## 缺陷 4：唤醒时把自己刚启用的包误判为「外部启用」并钉住

**现象**：`wake` 返回 `409 revision-conflict`。操作日志给出了直接证据：

```
reconcile  result={"drift":[{"key":"dsh-scaffold-notes@0.1.0",
             "change":"enabled-outside-management","action":"pinned"}]}
```

`dsh-scaffold-notes` 的 `pinned` 变成 `true`。而 `pinned` 的包 `sleep` 永远不会停用——**整个「休眠」功能对它失效**，而休眠正是本插件存在的理由。

**根因**：`plugin-manager/changed` 对**每一次**写入都会发出，包括本插件自己的写入。于是链条成为：

1. `wake` 调用 `setBundleEnabled` → 原生发出 `plugin-manager/changed`；
2. 本插件的 `reconcile` 监听器被触发，去读状态；
3. 此刻 `wake` 的 `requestedState=awake` 还没提交（它的 mutate 被这次 reconcile 挤掉，正是那个 409）；
4. reconcile 看到「包已启用、但没有任何活跃工作区认领」→ 判定为外部意图 → pin。

**为什么这是最严重的一个**：它不报错、不崩溃，只是**静默地把核心功能关掉**。而且它是竞态——reconcile 读到的是两次启用之间的快照，两个包里只有先被看到那个被钉住，所以可能钉 0 个、1 个或 2 个。

**修复（两处，均已验证各自承重）**：

1. **归属**：本插件自己的原生写操作包在 `#nativeWrite` 里计数；写入期间到达的变更事件被推迟，等**整个操作**提交完自己的状态后再统一结算（`#drainReconcile` 放在 `execute()` 的 `finally`，而不是放在原生写之后）。
2. **租约解释权**：`reconcile` 不再把「已启用且无人认领」直接当作外部意图——只要存在租约，启用就是被解释的。提交时再复查一次租约，堵住读与写之间的缝隙。

**验证**：拆掉第 1 处 → 回归测试失败；拆掉第 2 处（含提交时复查）→ 回归测试失败；只拆外层那一处则仍通过，因为内层复查兜住了，属纵深防御。同时补了一条反向测试：**无人认领的启用仍必须被保护**（不得停用不是自己开的东西），确保修复没有把安全规则一起削掉。

**教训**：`wake` 里「先启用、后提交意图」的顺序本身就把两者之间的窗口暴露给了任何监听器。这类自指事件流（自己的写触发自己的监听器）在假宿主上完全测不出来——测试必须显式模拟「原生为自己的写入发出变更事件」，否则这条路径永远不被覆盖。已把该模拟加进假宿主。

## 缺陷 5：跨重启时无法区分「自己的遗留」与「他人的意图」

**发现方式**：读缺陷 4 的修复时推演出来的，**不是观测到的**。触发路径：`sleep` 返回 `pending-idle` 并把释放排进**内存**队列 → 队列还没执行就重启 → 队列丢失、bundle 仍 `enabled`、工作区已是 `sleeping` → 启动对账无租约可解释 → 按缺陷 4 的新规则被当成外部意图**再次钉死**。

即缺陷 4 的修复解决了进程内竞态，但没解决跨重启的归属：重启后没有任何信息能说明「这个已启用的包是本插件开的」。

**修复**：持久化归属。包记录新增 `lastAppliedEnabled`，在每次本插件执行原生启用/停用后记录（`Store.recordApplied`），导入/关联建立记录时以观察到的状态初始化。`reconcile` 从「一种猜测」改为**四种明确情形**：

| 情形 | 判定 | 动作 |
|---|---|---|
| 有租约（活跃工作区认领） | 被解释 | 不报告 |
| 本插件应用的状态、尚未释放 | 自己的遗留 | `enabled-by-us-unreleased`，**不钉** |
| 本插件知道自己最后是关的 | 他人的意图 | `enabled-outside-management`，**钉住** |
| 来源未知（旧版本写入的记录） | 无法判断 | `provenance-unknown`，**既不钉也不释放**，只上报 |

最后一档是关键：**绝不在未知上做决定**。猜成「钉住」会把 bundle 焊死，猜成「释放」会停用本插件从未开启的东西；报告是唯一安全的选择。

**关键实现细节**：`recordApplied` **不递增 revision**（与预览记录一致）。第一版递增了，结果 `wake` 自己的 mutate 立即冲突——10 项测试同时报 `revision-conflict`。归属是诊断元数据，不是调用方用 `expectedRevision` 守护的配置变更；状态锁仍然串行化它与其它写入。

**回归测试**：两条，分别锁定「自己的遗留重启后不被钉、且休眠仍能完成」与「未知来源既不被钉也不被释放」。逐条验证承重：破坏「自己的遗留」分支 → 前者失败；让未知分支去钉 → 后者失败。

## 缺陷 6：agent 工具拿到的门面缺少方法，省略 workspaceId 的调用全部失败

**发现方式**：**用 agent 会用的方式调用工具**时立刻暴露：

```
{ "ok": false, "code": "native-operation-failed",
  "details": { "message": "operations.workspaceIdForPath is not a function" } }
```

`index.js` 通过 `registerTool(ctx, guarded)` 交给工具的是**门面对象**，而门面只导出了 `execute`。于是**凡是省略 `workspaceId`、依赖「当前会话自己的工作区」的调用全部失败**——而这正是工具描述里推荐的默认用法、也是 agent 的主用法，等于工具的人体工学主路径是坏的。

**为什么测试没抓到**：`test/tool.test.mjs` 注入的是**真实的 `Operations` 实例**，而宿主注入的是门面。测试替身与生产接线不一致，典型测试失真——测试全绿，生产挂。

**修复**：门面补齐 `workspaceIdForPath` 与 `reconcileFromEvent`，并注明「工具调用的每个方法都必须在这里列出」。**测试侧**：`tool.test.mjs` 改为走同样的门面形状；并在 `plugin.test.mjs` 新增一条**走真实 `apply()` 接线**的测试——从 `ctx.tools.register` 捕获工具，以省略 `workspaceId` 的调用验证解析结果。已验证：把门面方法去掉，该测试报出**完全相同**的生产错误。

**教训**：测试必须注入**宿主实际注入的那个对象**。用更「完整」的替身会掩盖接口缺口；这类缺陷只有真的调用一次才会出现。

## CI 发现并已修复的缺陷

自动化测试在本机全绿，但**第一次推送后的 CI 在 Node 24 上失败了**（Node 22 通过）。这是一个真实缺陷，记录如下：

**现象**：`test/tool.test.mjs` 中「连续两次导入同一个未改动的包」第二次返回失败。

**根因**：`packDirectory()` 给合成的 `package/` 根目录项写了 `Math.floor(Date.now() / 1000)`。归档哈希因此依赖**打包发生在哪一秒**：同一份未改动的内容，只要两次打包跨过秒边界，就会得到两个不同的 SHA-256。而上层把「同一版本、不同哈希」判定为 `package-content-conflict` 并拒绝，于是合法的重复导入被误判。

**为什么本机没发现**：本机两次打包落在同一秒内；CI 更慢，正好跨秒。缺陷本身与 Node 版本无关，Node 24 只是恰好先撞上。

**修复**：根目录项的时间戳改为取自被打包目录自身的 mtime，不再读时钟。同时审计了其余 `Date.now()` 用法，确认它们只用于预览有效期（本就应当依赖时钟）。

**回归测试**：`test/archive.test.mjs` 中新增一项——先把目录 mtime 固定到 `2001-02-03T04:05:06Z`，再断言归档根项携带的正是这个时间。这样只要实现里重新引入挂钟时间，测试就会**必然**失败，而不是依赖「恰好跨秒」这种运气。已验证：重新引入缺陷时该测试失败，修复后通过。

**教训**：内容寻址的实现必须对时间与读取顺序不敏感；「本机全绿」不能替代在另一台机器、另一个 Node 版本上真实执行。

## 发行包验证

```bash
node scripts/pack.mjs ..
```

产物为 `dsh-workspace-scaffolds-<version>.tgz`，由本插件自己的 USTAR 写入器生成（无网络、无第三方工具）。已验证：

- 解包后有 30 个条目，含 `package.json`、`plugin.js`、`index.js`、`client.js`、`cordis.patch.yml`、`README.md`、`LICENSE`、`icon.svg`、15 个 `src/` 文件、2 个 `locale/` 文件；
- 不含 `test/`、`node_modules/`、`state.json` 等不应发布的内容；
- 从解包目录 `import` 得到 `name = workspace-scaffolds`、`inject = ["connection","tools"]`、`apply` 为函数；
- 对解包产物调用 `apply` 可成功挂载 `/api/workspace-scaffolds/state`、`/api/workspace-scaffolds/execute`、工具 `workspace_scaffolds` 以及 `agent/created`、`agent/status`、`agent/disposed`、`plugin-manager/changed` 监听。

v0.1.0 的发行包 SHA-256（保留作历史记录）：

```
d3fa6c6d2398d7c4d69b1e62e67ffa8929874ab1fc3b75f8706bdf4a3436d034
```

（重新运行 `node scripts/pack.mjs ..` 后此值会变化；`docs/` 与 `README.md` 的改动也会改变它。）

## 接口依据

实现前对当前安装包做了只读核查，以下文件的接口与 `app.asar` 中内容逐字节一致（SHA-256 前缀）：

| 包 | 用途 | 前缀 |
|---|---|---|
| `dsh-workspace` | `workspaceRegistry` 的 `get` / `list` / `create`、实体形状 | `dbc8cc80e2b33c6b` |
| `dsh-plugin-manager` | `listBundles` / `setBundleEnabled` / `installBundle` 的 `options.enabled` 语义与 `application` 取值 | `0332934b288025bb` |
| `dsh-agent` | `agents.list()`、`agent/created` 串行事件 | `7e7c47fc0b82f071` |
| `dsh-agent-loop` | `agent.status` 的 `idle` / `running` 取值 | `00c4814d63f3d1e2` |
| `dsh-tools` | `ctx.tools.register` 的形状 | `05d701b98fa465ad` |
| `dsh-client-ui-workspace` | 客户端插槽契约 | `29c34ce1c2a437cf` |

关键实现事实：

- `pluginManager.installBundle(spec, options)` 用 `options.enabled !== false` 决定是否激活；已存在于 `package.json` 的包会返回 `restart-required`。本插件的适配层固定传 `enabled: false`，把「安装」和「启用」拆成两个可分别报告结果的步骤。
- `installBundle` 失败时会还原 `package.json` 与 `pnpm-lock.yaml`。
- `agent/created` 是**串行（await）**事件；`agent/status` 是**发射（不等待）**事件且载荷带 `{status, agent}`。
- `ctx.profileContext` 由宿主 `provide`，提供 `dir` / `name` / `home`。
- `plugins.bundle.config` 是 keyed 插槽，key 为 bundle 包名。

## 仍未在真实 DSH 中验证的部分

§真实环境实测 已确认下列第 1、2 项（就本插件自身的安装与加载而言）；其余逐项状态见下：

1. ~~真实 profile 中通过 `pnpm` 安装 `.tgz` 的端到端表现~~ —— **已验证**：pnpm 从本地 `.tgz` 安装成功，`exitCode=0`。
2. ~~真实插件管理器的启用行为~~ —— **已验证**：`application="applied"`，条目 `fiberPhase=active`。**停用行为**亦已验证（见 §隔离实例验证 V7）。
3. ~~**完整工作流**：导入示例包 → 关联真实工程 → 生成文件 → 启用该脚手架 bundle → 休眠 → 恢复。~~ —— **已验证**（V2–V8，见 §隔离实例验证）。
4. `agent/created` 中调用 `setBundleEnabled` 与原生 HMR 锁的实际顺序（实现已加 15 秒预算与降级上报，避免挂起）。**仍未验证。**
5. 面板在真实浏览器中的渲染、交互与样式（已用真实载荷做渲染级验证，但未做视觉验证）。**仍未做视觉验证。**
6. 客户端 bundle 的更新与热加载行为：本插件是普通 bundle，改动需要重新安装并刷新页面。**仍未验证。**
7. ~~**重启后的状态对账**~~ —— **已验证**（9/9，见 §隔离实例验证 §重启对账）。
8. 与具体 DSH 版本升级后的兼容性。**仍未验证**（本插件只在 0.2.0-rc.2 上实测过；0.1.x 到 0.2.0 的 DSH 升级路径未测）。
9. ~~**agent 层：脚手架注册的工具对模型真实可用**~~ —— **已验证**（12/12，见 §agent 层验证）。

## 隔离实例验证（2026-10-12）

一次完整的端到端验证，运行在**独立的 DSH 0.2.0-rc2 实例**上：

| 项 | 值 |
|---|---|
| home | `D:\dsh-verify-020rc2`（独立 `profiles` / `storages` / `.credentials.yaml`） |
| profile | `verify` —— 从官方 `web` 模板创建，仅含 `dsh-base` + `dsh-web-app` |
| 端口 | 19400（日常工作实例在 19387，两者独立） |
| 版本 | 0.2.0-rc.2（node 24.21.0 / pnpm 11.7.0） |
| 被测版本 | `dsh-workspace-scaffolds@0.1.8` |

**为什么用隔离实例**：此前的验证跑在真实的 `desktop` profile 里，会往用户的工作环境里装插件、启用示例 bundle、反复重启。隔离实例用**同一个 0.2.0-rc2 二进制**，所以结论对生产构建有效，但不动工作环境。验证产物（生成的文件）也留在隔离区内。

### 主流程：35/35 通过

```
V0  原生基线（清理上一轮遗留的启用状态）                       1/1
V1  干净起点：0.1.8 已载入 / profile=verify / 无待重启 / 状态为空   4/4
V2  插件自己注册工程（不再需要原始 RPC）                        4/4
V3  后台导入 + 运行期间轮询 /progress                           5/5
V4  导入第二个示例并关联两个                                    1/1
V5  预览 + 生成文件 + 变量替换                                  3/3
V6  唤醒（缺陷 4/5 的修复）                                     4/4
V7  休眠（原生侧真的停用）+ 文件留存                             4/4
V8  休眠后恢复                                                  2/2
V9  两个工程共享同一 bundle                                     7/7
```

三项此前从未在真实环境跑过的：

- **V3 实时进度**：导入运行期间 `/progress` 观测到中间步骤（`validate package -> record in warehouse`），不只是"接口存在"。
- **V7 休眠真正执行**：此前在 `desktop` profile 里因为始终有 agent 在跑，`sleep` 永远返回 `pending-idle`，释放路径从未跑完。隔离实例没有 agent 占用，第一次跑通 `sleep → 原生停用 → 恢复` 闭环。
- **V9 共享包**：两个工程都唤醒后，休眠其中一个返回 `kept: [{reason: "other-workspace", holders: [...]}]`，**另一个仍在用的包没有被停用**；两者都休眠后 `applied` 释放。

### 重启对账：9/9 通过

同一实例重启后：

```
PASS  同一构建仍载入（0.1.8）
PASS  无待重启
PASS  工程、关联、包记录全部保留
PASS  原生状态重新读取为 match
PASS  归档仍在
PASS  对账没有把任何包钉住（pinned: false）
PASS  启用状态与重启前一致
```

### agent 层验证：12/12 通过

这是唯一无法用 HTTP 或假宿主证明的一环：bundle 被启用，不等于它注册的工具真的进了**模型的工具列表**。所以在隔离实例里跑了一次真实 agent 回合。

```
A1  提问前 bundle 确实已启用（wake 生效、原生启用、未被钉住）      3/3
A2  创建会话并把提示交给 agent                                     2/2
A3  真实回合跑完，模型给出了回答                                    5/5
A4  消息记录里确实有工具调用与它的返回载荷                          2/2
```

关键读数（`session/projections` 的实时投影）：

```json
{ "turnOutline": [ { "turn": 1,
    "response": "TOOL_NAME=project_checklist CHECKLIST_KEYS=ok, value" } ],
  "sessionStats": { "turns": 1, "steps": 2, "toolMs": 15 },
  "contextBreakdown": { "toolsTokens": 6309 } }
```

- `toolsTokens: 6309` —— 模型确实拿到了一份非空的工具列表。
- `steps: 2` 且 `toolMs: 15` —— 中间发生了一次真实的工具调用。
- 消息记录里出现了 `topLevelEntries` —— 那是**这个工具自己的返回字段**，只有它真的执行了才会存在。仅凭「模型说它调用了」不足以证明，这个字段才是硬证据。

**踩到的两个坑，都值得记下来：**

1. **`session/prompt` 的请求形状猜不出来。** 我按 ACP 的形状（`{sessionId, prompt:[...]}`）试了八种组合全部被网关拒绝。最后从解包出的描述符里读到真实定义：

   ```
   SessionPromptRequest { requestId, sessionId, mode: 'queue'|'steer', content: PromptContentPart[] }
   ```

   字段是 `content` 而不是 `prompt`，还必需 `requestId` 与 `mode`。**遇到 gateway 边界校验失败时应去读描述符，而不是继续猜字段。**

2. **读会话记录不能读磁盘文件。** 我第一次用 `sessions/**/session.v4.jsonl.zstd` 读，解压后只有 226 字节的会话头，于是误判成「回合根本没跑」。实际上回合**已经跑完**（`turnOutline` 里有完整回答）——会话文件只在 flush 时落盘，实时视图在 `session/projections`。

   如果我当时就此收手，就会把一个**已经通过的验证**误报成失败。

### 一处方法论教训：什么算「干净起点」



第一次跑 V1–V9 时出现了 11 项失败，一度看起来像缺陷 4/5 的修复失效（`wake` 后 `pinned=true`）。实际原因是我**只清了插件的状态，没有清原生的启用状态**：两个示例 bundle 仍是 enabled，于是导入时**正确地**判定为 `external` + `pinned`，后续休眠自然全被挡下。

插件的行为是对的，是我的"干净起点"定义错了。**重置"插件的账本"不等于重置"环境的状态"**——已验证的 `V0` 现在会先把原生侧的遗留启用状态清掉。

### 本轮补上的功能缺口

验证过程中为了把工程纳入管理，我不得不绕过插件、直接用原始 RPC 调原生 `workspace/create`。而 `src/host.js` 里**早就写好了 `createWorkspace(path, title)`，只是从未接到任何动作上**——能力存在但外部够不着。

新增 `workspace-register` 动作（HTTP + agent 工具 + 面板齐备）后，注册走插件自己：V2 的四个检查覆盖了新建、接管已注册目录（原生注册表按路径去重，不会产生第二个工程）、以及保留既有绑定。验证脚本里的原始 RPC 助手已删除——**没有它也能跑完整个流程**，这本身就是缺口已补的证明。

## 结论

**已验证。** 两层证据支持：

- **宿主编译期之外的真实运行**：本插件能在真实 profile 中安装、热载入（无需重启）、挂载 loader 条目、解析两个原生服务、读取真实工程注册表、通过 HTTP 接口正确返回数据，并对非法输入返回正确错误码。
- **逻辑正确性**：核心闭环（关联 → 生成 → 启用 → 休眠 → 恢复）在假宿主上自洽——并发冲突、幂等重放、路径穿越、归档安全、状态损坏恢复、多工程共享与休眠排队都有回归保护。

证据**不**支持：完整工作流在真实工程上可用、浏览器面板可用、重启后状态对账正确。这两类缺口性质不同——前者是逻辑，后者是集成。

值得注意的是，**两项真实缺陷都不是假宿主测试发现的**：一项由 CI（跨秒边界）发现，一项由真实 DSH 实测（no-op 路径绕过 revision 校验）发现。这说明集成验证不可省略。

## 完成验证需要做什么

按顺序执行，每步记录实际输出。**第 1 步已完成，从第 2 步继续**：

1. ~~安装本发行包~~ —— **已完成**（`application=applied`，无需重启）。
2. 导入 `examples/dsh-scaffold-notes`，关联到一个**测试**工程，走完 预览 → 生成 → 恢复 → 休眠 → 再恢复。
3. 确认休眠后 bundle 在原生插件页显示为停用，且安装仍保留；再确认恢复后工具真实可用（不是仅状态显示为启用）。
4. 在两个工程共享同一个包的条件下重复休眠／恢复，确认不会互相误停用。
5. 在真实浏览器中检查面板的布局、变量输入与错误提示。
6. 重启 DSH，确认关联、版本与运行状态对账正确。
7. 若第 3 或第 6 步失败，请连同 `plugin-manager` 的 `application` 返回值一起记录。

完成上述步骤后，请把结论写回本文件，并相应更新 README 顶部的状态声明。
