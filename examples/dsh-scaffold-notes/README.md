# dsh-scaffold-notes

示例脚手架包：本身不提供工具，价值在于随包发布的模板集合。

- `scaffold.json` 声明变量 `projectName`（必填）与 `owner`（可选）。
- `templates/PROJECT-NOTES.md` → `docs/PROJECT-NOTES.md`
- `templates/DECISIONS.md` → `docs/DECISIONS.md`

由「工程脚手架」插件导入并关联到某个工程后，可在面板中预览并生成；生成过程不覆盖任何已存在的文件。
