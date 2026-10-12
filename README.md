# 工程脚手架 · dsh-workspace-scaffolds

> ## ⚠️ 本项目尚未经过验证 · UNVERIFIED
>
> **这个插件从未在真实的 DSH 环境中安装或使用过。**
>
> 仓库中的测试与 CI 只能说明**代码逻辑在受控的假宿主下自洽**，**不能**说明它装进你的 DSH 之后能正常工作。请把它当作**实验性代码**：先在非关键环境试用，不要直接用在实际工程上。
>
> 以下关键环节**全部未经真实验证**：
>
> - 真实 profile 中通过 `pnpm` 安装本插件的端到端表现；
> - 真实插件管理器的启用／停用行为，以及 `restart-required` 的实际表现；
> - `agent/created` 中启用插件与原生 HMR 锁的真实先后顺序；
> - 浏览器面板的真实渲染、交互与样式；
> - 客户端 bundle 的更新与热加载行为；
> - 与真实 DSH 版本升级后的兼容性。
>
> 详细说明与后续验证清单见 [docs/verification.md](docs/verification.md)。

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
dsh plugin add ./dsh-workspace-scaffolds-0.1.1.tgz
```

安装后需要为本插件启用 bundle（默认 `cordis.patch.yml` 已声明）。面板出现在 **插件页 → 本插件卡片**，使用 `plugins.bundle.config` 插槽。

## 使用流程

### 1. 导入脚手架包

在面板「导入脚手架包」中填写**绝对路径**，可以是：

- 一个包含 `package.json`（且声明了 `dsh.bundle`）的目录；
- 一个 `.tgz` 包。

导入会依次完成：校验原生 bundle 声明 → 校验可选的 `scaffold.json` → 打包并计算 SHA-256 → 存入本地归档 → 通过原生插件管理器**安装但不启用**。

### 2. 关联到工程

在「已关联脚手架」区域选择包并点击「添加到该工程」。关联只写配置，不加载插件、不写工程文件。

### 3. 生成初始文件（可选）

对声明了模板的包点击「生成预览」：

- 预览会列出每个目标文件的 `create` / `identical` / `conflict` 状态；
- 有任何 `conflict` 时整批阻止，不会写入部分文件；
- 确认后点击「生成文件」。已存在且内容相同的文件被跳过，内容不同的文件不会被覆盖。

### 4. 恢复工程

点击「恢复」。所有**必需**的包都会依次启用；失败时不会把工程标成「已就绪」，并且会回滚本次新启用、且没有其他工程需要的包。

### 5. 休眠

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

## agent 工具

工具名 `workspace_scaffolds`，动作与 HTTP 接口一致。默认工程取自当前会话的工作目录（通过原生工程注册表按规范化路径精确匹配，不做前缀猜测）。

读操作：

- `list` — 完整状态，包含 `revision`、工程、关联、包和阻塞项。
- `operation-status` — 按 `operationId` 查询进度与结果。
- `scaffolds` — 读取某个包的模板描述。

写操作（必须携带 `list` 返回的 `expectedRevision` 与一个**新的 UUID** `operationId`）：

- `import`、`bind`、`unbind`、`update-binding`、`set-pin`
- `wake`、`sleep`
- `template-preview`、`template-apply`
- `delete-archive`

`operationId` 与参数一起构成幂等键：同参数重试会返回**记录过的结果**而不重复执行；同 ID 换参数会被拒绝（`operation-id-reused`）。

`wake` 返回 `effectiveFrom: "next-model-request"` —— 这是准确语义：当前已经发给模型的工具列表不会改变，新增能力在**下一次请求**生效。

## HTTP 接口

```
GET  /api/workspace-scaffolds/state
POST /api/workspace-scaffolds/execute
```

成功：`{ "ok": true, "value": ... }`；失败：`{ "ok": false, "code": "...", "details": { ... } }`。

请求体上限 1 MiB。配置、版本、模板冲突返回 409，输入错误 400，找不到 404。

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

> **先说清楚这套验证证明不了什么。** 下面全部测试都在**假宿主**上运行，从未接触真实 DSH。它们能证明代码逻辑自洽、边界处理正确；**不能**证明本插件在真实 DSH 中可用。参见顶部声明。

```bash
node --test test/*.test.mjs
```

| 验证了什么 | 没验证什么 |
|---|---|
| 71 项 `node:test` 用例全部通过 | 真实 DSH 中的安装与加载 |
| Linux（Node 22 / 24）与 Windows 上均通过 | 真实插件管理器的启停与重启行为 |
| 真实 `src/host.js` 适配层被实际执行（非桩替换） | 浏览器面板的真实渲染与交互 |
| 发行包可解包、可 `import`、`apply` 可挂载路由与工具 | 与具体 DSH 版本的兼容性 |

测试覆盖的验收场景与结果见 [docs/verification.md](docs/verification.md)。测试使用内存假宿主验证真实的 `src/host.js` 适配层，因此原生 `installBundle(..., {enabled:false})` 这类契约本身也在测试范围内。

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
