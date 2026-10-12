# dsh-scaffold-checks

示例脚手架包：价值在于**能力**而不只是模板。

- 注册只读工具 `project_checklist`，报告工程根目录下约定文件的存在情况。
- `scaffold.json` 声明 `docs/CHECKS.md` 自检清单模板。

关联到某个工程并「恢复」后，`project_checklist` 才会出现在该 DSH 环境中的会话里；「休眠」该工程会把它停用。原生 bundle 是全 profile 共享的，因此另一个工程仍在使用时不会被关闭。
