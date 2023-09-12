# Fork Modification (by adventure-yunfei)

## `api-extractor`

- 新增 `import Foo = Bar.Baz;` 语法支持（根节点声明场景）(3d696a3305c050a21c092de5378430e2851d61a0)
- 新增完整的引用类型链接支持, 包括未导出的类型 (59e634c68baa4cac277bec171f4c6f404c9d384b)
- fix：修复 API JSON 中的导出命名 (297e6c70dd7d5f4ea5bd28c4b20e49e94ed277d2)
- 修正 Entity 变量和 namespace 内的变量的命名冲突 (c103df149fc202f1b8b28f401c4c848b6b566b1e)
- 修正 import type `import('abc')` 语法支持 (fb6318877dbccb07ab6261bf3b2a2632aa28c297)
- 优化 `AstNamespaceImport` 输出结果 (5ffd9dde49218c26b146de7ffa6701a4bf761309, 8c2d1295f1e6cbe09d0f8282cd09556f43551321)
- 新增 Release Trimming 功能 (33c17c2c814a8b2ecd7058a9dc93b99a1e3243df)

## `api-documenter`

- 新增完整的引用类型链接支持, 包括未导出的类型 (59e634c68baa4cac277bec171f4c6f404c9d384b)
