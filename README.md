# 工程脚手架 · dsh-workspace-scaffolds

> ## ⚠️ 已验证但存在已知缺陷 · VERIFIED WITH KNOWN DEFECTS
>
> **一次独立代码评审发现 14 项可复现缺陷（5 项 P1、9 项 P2），我已逐条对照源码确认全部成立。**
> **已修复 10 项（全部 5 项 P1 + 5 项 P2）并在隔离实例上验证；仍有 4 项 P2 未修。**逐条状态与理由见
> [docs/review-response-2026-10-12.md](docs/review-response-2026-10-12.md)。
>
> **已在真实 DSH 0.2.0-rc2 隔离实例上验证**（`D:\dsh-verify-020rc2`，独立 home / profile / 端口，不触碰日常工作 profile）：
>
> - 完整工作流：**注册工程** → 导入脚手架包 → 关联 → 预览 → 生成文件 → 启用 → 休眠 → 恢复；
> - 插件的安装与**热载入**（`application: "applied"`，无需重启）；
> - 休眠真正在原生侧**停用** bundle，恢复后重新启用；休眠不误停用别的工程仍在使用的包；
> - **重启后的状态对账**：关联、版本、原生状态与归档保持一致，且对账不会误钉；
> - HTTP **进度**：导入运行期间可轮询到中间步骤；
> - 脚手架注册的工具在**真实 agent 回合**中被提供、被调用，其返回载荷出现在消息记录里；
> - 评审 P1 的现场复核：解绑只释放被移除的那个关联；自动恢复登记共享持有者。
> - 评审 P2 的现场复核：未满足的声明依赖被拒、equires 跨重启存活；重复导入不改写归属；部分绑定更新被接受；必需脚手架关闭时 eady=false。
>
> **未验证**：浏览器面板的视觉渲染。**未修复**：4 项 P2（F08、F09、F10、F11），其中 F08 会把原生安装失败伪装成成功导入。
>
> 详细证据、缺陷记录与验证方法见 [docs/verification.md](docs/verification.md)。

把 DSH **工程**（Workspace）与工程使用的**脚手架插件**关联起来的插件。

- **开工前**：选择工程需要的脚手架，预览并生成初始文件，然后恢复插件。
- **工作中**：随时给工程追加脚手架；新增能力从**下一次模型请求**开始生效。
- **不用时**：休眠工程，插件被停用并保留在硬盘上；工程文件、安装包和配置都不动。
- **再次使用时**：恢复工程，按记录的版本和关联把插件重新装回运行状态。

## 目录

- [核心概念](#核心概念)
- [安装](#安装)
- [使用流程](#使用流程)
- [面板说明](#面板说明)
- [agent 工具](#agent-工具)
- [HTTP 接口](#http-接口)
- [数据与状态](#数据与状态)
- [能力边界](#能力边界)
- [验证](#验证)
- [脚手架包格式](#脚手架包格式)

## 核心概念

| 术语 | 含义 |
|---|---|
| 工程 | DSH 原生 `workspaceRegistry` 中的 Workspace，用原生 `workspaceId` 标识 |
| 脚手架包 | 声明了 `dsh.bundle` 的原生 DSH 插件包，可以另外携带文件模板 |
| 关联 | 把某个**精确版本**的包记入工程清单；关联本身不加载任何东西 |
| 准备 / 恢复 | 通过原生插件管理器启用插件能力；**不**生成模板文件 |
| 生成 | 依据模板向工程写入新文件；必须单独执行，永不覆盖已有文件 |
| 休眠 | 释放工程对插件的占用；没有其他工程需要时才真正停用，磁盘文件全部保留 |
| 解除关联 | 从工程清单移除记录；已生成的文件保留 |
| 全局常驻 | 标记某个包始终启用，任何工程休眠都不会关闭它 |

**租约（lease）是推导出来的，不是存下来的。** 一个工程持有某个包的租约，当且仅当它处于「使用中」且该关联处于启用状态。这样就不会出现「存的租约和实际关联不一致」这类问题。

## 安装

本插件是一个原生 DSH bundle。开发目录没有第三方依赖，Host 代码和浏览器代码都是普通 JavaScript。

```bash
# 在 DSH 中通过插件管理器安装本目录或发行包
dsh plugin add /absolute/path/to/dsh-workspace-scaffolds
# 或安装打包好的发行包
dsh plugin add ./dsh-workspace-scaffolds-0.1.9.tgz
```

安装后需要为本插件启用 bundle（默认 `cordis.patch.yml` 已声明）。面板出现在 **插件页 → 本插件卡片**，使用 `plugins.bundle.config` 插槽。

## 使用流程

### 1. 注册工程

在面板「注册工程」中填写项目目录的**绝对路径**。插件会在原生工程注册表中登记它，并建立自己的管理记录——此时**不关联任何脚手架、不启用任何插件、不写任何文件**。

已注册的目录再次注册不会报错，也不会产生第二个工程：原生注册表按路径去重，插件会接管既有的那个，并保留它已有的关联。

### 2. 导入脚手架包

在面板「导入脚手架包」中填写**绝对路径**，可以是：

- 一个包含 `package.json`（且声明了 `dsh.bundle`）的目录；
- 一个 `.tgz` 包。

导入会依次完成：校验原生 bundle 声明 → 校验可选的 `scaffold.json` → 打包并计算 SHA-256 → 存入本地归档 → 通过原生插件管理器**安装但不启用**。

### 3. 关联到工程

在「已关联脚手架」区域选择包并点击「添加到该工程」。关联只写配置，不加载插件、不写工程文件。

### 4. 生成初始文件（可选）

对声明了模板的包点击「生成预览」：

- 预览会列出每个目标文件的 `create` / `identical` / `conflict` 状态；
- 预览阶段发现任何 `conflict` 时**整批阻止**，此时不会写入任何文件；
- 确认后点击「生成文件」。已存在且内容相同的文件被跳过，内容不同的文件不会被覆盖。
- ⚠️ **预览之后**才出现的冲突是在应用阶段逐个发现的（已知缺陷 F10，未修）：此时会中止后续写入并在错误详情里报告**已经创建**的文件，也就是说**可能留下部分生成物**。评审记录见 [docs/review-response-2026-10-12.md](docs/review-response-2026-10-12.md)。

### 5. 恢复工程

点击「恢复」。所有**必需**的包都会依次启用；失败时不会把工程标成「已就绪」，并且会回滚本次新启用、且没有其他工程需要的包。

### 6. 休眠

点击「休眠并保留」：

- **有任务正在执行时**，休眠会排队，等环境空闲后自动完成，不会打断正在运行的任务；
- 其他工程仍在使用的包保持不变，面板会说明保留原因；
- 标记为「全局常驻」或原本就由外部启用的包不会被关闭；
- 只调用原生「停用」，**不会**删除安装、归档或工程文件。

## 面板说明

面板分为四块：

1. **导入脚手架包** — 路径输入与导入。
2. **工程** — 选择工程；显示期望状态、是否就绪、待处理项；提供「恢复」与「休眠并保留」。
3. **已关联脚手架** — 每个关联的版本、原生状态、归档状态、是否多工程共享；提供生成预览与解除关联。声明了模板变量的包会在行内给出变量输入框。
4. **本地仓库与已装插件** — 本地仓库中的包、是否已安装、归档是否存在、当前有哪些工程在用它；提供全局常驻开关与删除归档。

所有写操作都携带当前 `revision`；版本冲突时面板会重新读取状态并提示，不会盲目重放。

面板标题行显示三个标签：`配置版本`、profile 名称、以及**当前运行的构建版本**（`pluginVersion`）。当 profile 声明的构建与内存中运行的不是同一个时，面板会额外显示一行提示和所声明的 spec —— 也就是「更新已写盘，但需要重启才生效」这个状态，不必再靠行为反推。

## agent 工具

工具名 `workspace_scaffolds`，动作与 HTTP 接口一致。默认工程取自当前会话的工作目录（通过原生工程注册表按规范化路径精确匹配，不做前缀猜测）。

读操作：

- `list` — 完整状态，包含 `revision`、工程、关联、包和阻塞项。
- `operation-status` — 按 `operationId` 查询进度与结果。
- `scaffolds` — 读取某个包的模板描述。

写操作（必须携带 `list` 返回的 `expectedRevision` 与一个**新的 UUID** `operationId`）：

- `workspace-register` — 把一个已存在的目录注册为受管工程（`path`，可选 `title`）
- `import`、`bind`、`unbind`、`update-binding`、`set-pin`
- `wake`、`sleep`
- `template-preview`、`template-apply`
- `delete-archive`

`operationId` 与参数一起构成幂等键：同参数重试会返回**记录过的结果**而不重复执行；同 ID 换参数会被拒绝（`operation-id-reused`）。

`wake` 返回 `effectiveFrom: "next-model-request"` —— 这是准确语义：当前已经发给模型的工具列表不会改变，新增能力在**下一次请求**生效。

## HTTP 接口

```
GET  /api/workspace-scaffolds/state
GET  /api/workspace-scaffolds/progress            # 只读进度，适合高频轮询
GET  /api/workspace-scaffolds/progress?operationId=<id>
POST /api/workspace-scaffolds/execute
```

成功：`{ "ok": true, "value": ... }`；失败：`{ "ok": false, "code": "...", "details": { ... } }`。

请求体上限 1 MiB。配置、版本、模板冲突返回 409，输入错误 400，找不到 404。

### 进度

`import` 会真的跑包管理器，`wake` 要逐个原生启用 bundle；这些请求在完成前如果不返回任何中间信息，调用方就只看到一个卡住的连接。因此耗时的动作会被登记成一条**进度记录**，可以在它还在跑的时候查询：

```jsonc
// POST /execute  { "action": "import", ..., "background": true }
{ "ok": true, "value": {
    "operationId": "…", "action": "import", "status": "running", "background": true,
    "progress": { "phase": "validate package", "steps": [ /* … */ ] } } }
```

```jsonc
// GET /progress        （或包含在 GET /state 的 progress 字段里，一次轮询即可）
{ "ok": true, "value": {
    "running": [ {
      "operationId": "…", "action": "import", "status": "running",
      "phase": "install without enabling",
      "steps": [
        { "label": "validate package", "status": "done", "detail": "dsh-scaffold-notes@0.1.0" },
        { "label": "install without enabling", "status": "active" },
        { "label": "record in warehouse", "status": "pending" }
      ] } ],
    "recent": [ /* 最近完成的，保留 20 条 */ ] } }
```

实际轮询效果（真实输出，`install` 被注入 1.2s 延迟以便观察）：

```
tick 2
  import  running  phase=install without enabling
      [x] validate package  (dsh-scaffold-notes@0.1.0)
      [x] hash and archive  (8700a0a14de3)
      [x] read scaffold descriptor  (1 template(s))
      [>] install without enabling
      [ ] record in warehouse
```

要点：

- **`background: true`** 让耗时动作立刻返回 `operationId`，而不是把连接挂到跑完为止；配合 `/progress` 轮询即可。适用于 `import`、`wake`、`sleep`、`template-apply`。
- 步骤状态为 `pending` / `active` / `done` / `failed` / `skipped`；`wake` 与 `sleep` 会按包**动态追加**步骤（每个包一行），因为这些步骤在计划时就已确定但数量取决于关联。
- 进度**只在内存中**，刻意不持久化：它描述的是一个活着的进程，重启后读到过期记录比读不到更糟。持久的结果仍在操作日志里（`operation-status`）。
- `operation-status` 对**进行中**的操作同样可用（读实时进度），不必等它写入操作日志。
- 面板在动作执行期间轮询 `/progress` 并逐步渲染，而不是只显示一个转圈。

### 构建标识

`list`（以及 `GET /state`）的返回值里带有三个诊断字段，用来回答「现在到底是哪个构建在跑」：

| 字段 | 含义 |
|---|---|
| `pluginVersion` | **正在内存中运行的**构建版本，读自该模块自己的 `package.json` |
| `profileSpec` | profile manifest 为该插件声明的依赖 spec（即「请求的是哪个」），读不到时为 `null` |
| `restartPending` | 前者与后者不一致，需要重启 DSH 才会生效 |

`pluginVersion` 取自**运行中的模块自身**，而不是 profile 声明——后者恰恰是会在「更新已写盘、进程仍持旧代码」时说谎的那个。

`restartPending` 是**保守启发式**：只对 `file:` / `link:` 这类把具体产物写进字符串的本地 spec 判定；`^0.1.0` 这类注册表范围描述的是一个可接受集合，不是另一个构建，因此永不报告为待重启。读不到版本时一律返回 `false`，不会把「未知」伪装成任何结论。

### 错误码

`invalid-request`、`workspace-not-found`、`workspace-unavailable`、`revision-conflict`、`operation-id-reused`、`package-content-conflict`、`version-conflict`、`dependency-missing`、`dependency-cycle`、`protected-bundle`、`restart-required`、`native-overridden`、`native-operation-failed`、`template-conflict`、`preview-expired`、`preview-stale`、`path-outside-workspace`、`archive-in-use`、`state-corrupt`、`unsupported-host`、`not-a-bundle`、`package-unknown`、`scaffold-invalid`、`archive-invalid`。

`sleep` 在有空闲问题时返回 `status: "pending-idle"` —— 这是正常的异步状态，不是错误。

## 数据与状态

全部状态位于当前 profile 目录下：

```
<profileDir>/workspace-scaffolds/
  state.json          权威状态（含 revision、工程、包、预览、操作日志）
  state.json.bak      上一次成功的状态，用于损坏恢复
  archives/<sha>.tgz  内容寻址的脚手架包快照
  operations/         预留的操作目录
  staging/            临时解包目录（用完即删）
```

规则：

- 所有写操作串行化，写前校验 `revision`，写入使用「临时文件 + 原子改名」。
- `state.json` 损坏时先从 `.bak` 恢复；**没有**可用备份就报错停止，绝不把损坏状态当成空状态。
- 存储的 `schemaVersion` 高于本插件支持的版本时只读报错，不做降级。
- 操作日志保留最近 200 条，用于幂等重放。
- 预览记录带 10 分钟有效期，`template-apply` 必须引用预览 ID。

工程目录里**只有**你显式生成的模板文件；本插件不写隐藏清单、不改 `.gitignore`。

## 能力边界

这些是**已知且有意的**限制，请按此预期使用：

1. **原生插件是全 profile 共享的。** 关联到工程**不等于**运行隔离。本插件用「工程使用记录 + 全局常驻保护」来避免误停用，但一个启用的 bundle 会向该 DSH 环境中的所有会话提供它的能力。
2. **不做工程级配置隔离，也不支持同一包的多版本并行。** 两个工程要求同包不同版本时会明确报 `version-conflict`，不会替换正在运行的版本。
3. **`agent/created` 自动恢复只走快路径**：只对**已安装**的包做启用，绝不在创建 agent 时运行包管理器。需要安装时，面板会显示待处理项，由「恢复」显式完成。自动恢复有 15 秒预算；超时会记录并标记为 `degraded`，不会挂起启动。
4. **原生侧边栏单纯切换到一个已存在的会话不会触发恢复。** 请用面板的「恢复」，或在新建／恢复 agent 时依赖自动恢复。
5. **休眠时如果环境中有任务在执行会排队**，不会打断。
6. **停用不保证卸载模块内存。** Node 的模块缓存不保证回收，所以本插件只说「停用并保留」，不承诺完全释放内存。
7. **离线恢复分两级**：休眠后再恢复不需要网络；如果包被从 profile 里移除，则只有归档存在、且重新安装成功后才能恢复（第三方依赖是否可离线重装未经验证）。
8. **模板没有覆盖更新、三方合并或升级迁移。** 用户改过的文件永远保留。
9. **本插件自身被停用时**不会去关闭第三方插件（此时宿主服务可能正在释放），只释放自己注册的路由、工具和监听器；下次启动重新对账。

## 验证

验证分两层，两层都要看：

```bash
node --test test/*.test.mjs        # 141 项单元测试（假宿主）
```

**第一层：单元测试**（内存假宿主，但执行的是真实的 `src/host.js` 适配层）：

| 验证了什么 | 没验证什么 |
|---|---|
| 141 项 `node:test` 用例全部通过 | 浏览器面板的真实渲染与交互 |
| Linux（Node 22 / 24）与 Windows 上均通过 | — 真实环境由第二层覆盖 |
| 真实适配层被实际执行（非桩替换）：`installBundle(..., {enabled:false})` 等契约在测试范围内 | |

**第二层：隔离 DSH 0.2.0-rc2 实例上的端到端验证**（主流程 + 评审 P1/P2 复核共 58/58、重启对账 9/9、agent 层 12/12）：

| 验证了什么 | 没验证什么 |
|---|---|
| 完整工作流：注册 → 导入 → 关联 → 预览 → 生成 → 启用 → 休眠 → 恢复 | 浏览器面板的视觉渲染（布局与样式） |
| 休眠真的在原生侧停用 bundle；恢复真的重新启用 | 与 0.2.0-rc2 以外版本的兼容性 |
| 两个工程共享同一 bundle 时，休眠不误停用别人仍在用的包 | |
| 重启后的状态对账（关联、版本、原生状态、归档一致，且不会误钉） | |
| HTTP 进度可在长操作运行期间轮询到中间步骤 | |
| **真实 agent 回合中**脚手架注册的工具被提供、被调用，且其返回载荷出现在消息记录里 | |

验证环境：独立 home `D:\dsh-verify-020rc2`、独立 profile `verify`、独立端口 —— 与日常工作 profile 完全隔离，验证产物也留在隔离区内。

测试覆盖的验收场景与结果见 [docs/verification.md](docs/verification.md)。

**试用前请自行确认**：本插件会在 `<profileDir>/workspace-scaffolds/` 下写入状态，并会调用原生插件管理器启用／停用 bundle。请先在非关键 profile 或副本工程上验证。

## 脚手架包格式

一个可运行的脚手架包就是**原生 DSH bundle**，可以额外声明模板：

```json
{
  "name": "dsh-scaffold-notes",
  "version": "0.1.0",
  "type": "module",
  "exports": { ".": "./plugin.js" },
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } },
  "workspaceScaffold": "./scaffold.json"
}
```

`scaffold.json`：

```json
{
  "schemaVersion": 1,
  "title": "工程笔记",
  "variables": {
    "projectName": { "type": "string", "required": true, "maxLength": 100 }
  },
  "templates": [
    {
      "id": "notes",
      "files": [
        { "source": "templates/NOTES.md", "target": "docs/NOTES.md", "render": "text" }
      ]
    }
  ]
}
```

- `render: "text"` 只支持 `{{variableName}}` 替换，不支持表达式、脚本或递归 include。
- `render: "copy"` 原样复制二进制资源。
- 目标是固定的相对路径，必须是相对路径且不能越出工程目录。
- `requires` 用于声明依赖其他脚手架包（精确版本），由本插件做依赖排序与环路检测。

`examples/` 下有两个可直接导入的示例：`dsh-scaffold-notes`（只提供模板）与 `dsh-scaffold-checks`（提供 `project_checklist` 工具与模板）。

## 许可

MIT
