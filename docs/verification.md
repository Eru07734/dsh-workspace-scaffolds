# 验证记录

> ## 状态：**未经验证 · UNVERIFIED**
>
> 本插件**从未在真实的 DSH 环境中安装或运行过**。本文件记录的是**假宿主上的自动化验证**：它能证明代码逻辑自洽、边界处理正确，**不能**证明本插件在真实 DSH 中可用。
>
> 本项目 v0.1.0 发布时未附此声明，v0.1.1 起补齐。请按实验性代码对待。

本文件记录 `dsh-workspace-scaffolds` 的验证方式、覆盖范围与当前结论。

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
ℹ tests 71
ℹ pass 71
ℹ fail 0
```

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

## 尚未在真实 DSH 中验证的部分

以下内容需要一次真实的 DSH 会话才能确认，本文件明确记录为**未验证**：

1. 真实 profile 中通过 `pnpm` 安装 `.tgz` 的端到端表现（测试用假宿主在内存中复现了同样的契约）。
2. 真实插件管理器的启用／停用行为，以及 `restart-required` 的实际表现。
3. `agent/created` 中调用 `setBundleEnabled` 与原生 HMR 锁的实际顺序（实现已加 15 秒预算与降级上报，避免挂起）。
4. 面板在真实浏览器中的渲染、交互与样式（已用真实载荷做渲染级验证，但未做视觉验证）。
5. 客户端 bundle 的更新与热加载行为：本插件是普通 bundle，改动需要重新安装并刷新页面。
6. 与具体 DSH 版本升级后的兼容性。

## 结论

**本项目未经验证。** 现有的自动化证据只支持一个结论：核心闭环（关联 → 生成 → 启用 → 休眠 → 恢复）的**逻辑**在假宿主上是自洽的——并发冲突、幂等重放、路径穿越、归档安全、状态损坏恢复、多工程共享与休眠排队都有回归保护。它**不**支持「这个插件能在真实 DSH 里正常工作」这一结论。

## 完成验证需要做什么

按顺序执行，每步记录实际输出：

1. 在**非关键 profile** 中 `dsh plugin add` 本发行包，确认能够加载、面板出现在插件页且不报错。
2. 导入 `examples/dsh-scaffold-notes`，关联到一个测试工程，走完 预览 → 生成 → 恢复 → 休眠 → 再恢复。
3. 确认休眠后 bundle 在原生插件页显示为停用，且安装仍保留；再确认恢复后工具真实可用（不是仅状态显示为启用）。
4. 在两个工程共享同一个包的条件下重复休眠／恢复，确认不会互相误停用。
5. 在真实浏览器中检查面板的布局、变量输入与错误提示。
6. 重启 DSH，确认关联、版本与运行状态对账正确。
7. 若第 3 或第 6 步失败，请连同 `plugin-manager` 的 `application` 返回值一起记录——那正是本插件依赖但尚未实测的接口行为。

完成上述步骤后，请把结论写回本文件，并移除 README 顶部的未验证声明。
