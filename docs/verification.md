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
ℹ tests 83
ℹ pass 83
ℹ fail 0
```

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

§真实环境实测 已确认下列第 1、2 项（就本插件自身的安装与加载而言）；其余仍然待验证：

1. ~~真实 profile 中通过 `pnpm` 安装 `.tgz` 的端到端表现~~ —— **已验证**：pnpm 从本地 `.tgz` 安装成功，`exitCode=0`。
2. ~~真实插件管理器的启用行为~~ —— **已验证**：`application="applied"`，条目 `fiberPhase=active`。**停用行为尚未验证**（`setBundleEnabled(name,false)` 的真实返回）。
3. **完整工作流**：导入示例包 → 关联真实工程 → 生成文件 → 启用该脚手架 bundle → 休眠 → 恢复。目前只有假宿主证据。
4. `agent/created` 中调用 `setBundleEnabled` 与原生 HMR 锁的实际顺序（实现已加 15 秒预算与降级上报，避免挂起）。
5. 面板在真实浏览器中的渲染、交互与样式（已用真实载荷做渲染级验证，但未做视觉验证）。
6. 客户端 bundle 的更新与热加载行为：本插件是普通 bundle，改动需要重新安装并刷新页面。
7. **重启后的状态对账**：`<profileDir>/workspace-scaffolds/state.json` 在真实重启后的恢复表现。
8. 与具体 DSH 版本升级后的兼容性。

## 结论

**部分验证。** 已有证据支持：

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
