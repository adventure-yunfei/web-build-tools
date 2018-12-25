# api-extractor@7 流程设计记录

# 核心概念

- `Extractor`: 整个流程的控制器
- `Collector`: 负责收集所有需要被处理的类型信息，是基础的数据源
- 多个数据消费者: 来自 `Collector` 统一的一份数据源可以被用于多个功能实现 (当前位于 `src/generators/` 下)
  - `ApiModelGenerator`: `api.json` 生成器，输出序列化后的 api 描述信息
  - `ReviewFileGenerator`: 生成一份简单的接口列表，可以用来快速查看接口及变动
  - `DtsRollupGenerator`: `*.d.ts` 打包器，将接口所需的 ts 描述文件合并成一个描述文件
- 数据类型:
  - `ApiItem`: `api.json` 对应的数据对象表达
  - `AstSymbol`: 与 `ts.Symbol` 相对应的内部封装，具体参考代码注释
  - `AstDeclaration`: 与 `ts.Declaration` 相对应的内部封装，具体参考代码注释

# 整体流程

整体流程实现在 `Extractor` 中。

- `Extractor.processProject()` 开始流程
- 收集数据: `Collector.analyze()`
- 生成 `api.json` (如果启用):
  - 根据 `Collector` 数据，生成 `ApiPackage` (内含 `ApiItem` 树): `ApiModelGenerator.buildApiPackage()`
  - 序列化并保存到文件: `ApiPackage.saveToJsonFile()`
- 生成 api review 文件 (如果启用): `ReviewFileGenerator.generateReviewFileContent()`
- 生成 `*.d.ts` 打包文件 (如果启用): `DtsRollupGenerator.writeTypingsFile()`

# 详细设计

### 收集数据 - `Collector`

typescript 编译文件后会把该文件以及被引入的其他文件的所有类型都识别出来，但对于导出接口来说，并不是所有的类型都是需要的。`Collector` 仅会收集导出接口以及其引用的类型，最终存储为 `Collector.entities` 数组。

整个数据收集的过程都实现在 `Collector.analyze()` 中。

首先，解析指定的入口文件 `ts.SourceFileObject` 节点 (`AstSymbolTable.fetchEntryPoint()`)，并收集导出接口。然后对于其中的每一个导出项，找出其中所有的间接引用类型。

每一个导出接口本身都作为一个 `CollectorEntity`; 其中间接引用的类型也作为一个 `CollectorEntity`。每一个 `CollectorEntity` 都是一个“顶层”的描述类型，对应一个 `AstSymbol`，存储了其下的完整类型树。

##### AstSymbol: 外部 package 导入项

对于 `import * as pkg from 'pkg';` 这样的外部package导入声明，`AstSymbol` 会用一个特殊的 `astImport` 属性来标记，后续的流程会特殊处理。

### 生成 `api.json` - `ApiModelGenerator`

##### 生成 `ApiItem` 树

首先，以 `Collector.entities` 中导出的类型作为起点，遍历其中的类型树，为其创建对应的 `ApiItem`。

需要注意的是，创建的 `ApiItem` 树包含的是定义类型的 id，而非值类型。如 `Namespace - Class - classMember`。

示例:

```typescript
export interface Bar {}
export class Foo {
  member: Bar;
}
```

其生成的 `ApiItem` 树为:

- `<xxx_package>`
  - `Bar`
  - `Foo`
    - `member`

其中 `member: Bar` 中的值类型节点 `Bar` 并不会被处理为 `ApiItem`。

> 该值类型节点 `Bar` 应当标记为对 `interface Bar` 类型的链接，当前还没做。
>
> 目前自己补充了一个类型链接的实现，其方法为：
> 1. 生成 `ApiItem` 时，用一个 `Map`，记录下每一个 `ApiItem` 对应的 `ts.Symbol`
>   - 比如上面的 `interface Bar`，对应生成了一个 `ApiInterface`，相应的 `ts.Symbol` 为 `"Bar"`
> 2. 生成 `ExcerptToken` 时 (暂时理解为声明以及值类型的文本描述)，记录下其中包含的引用的类型定义
>   - 比如上面的 `member: Bar`，其中值类型包含了一个 `ts.IdendifierObject` 对应到刚才的 `"Bar"` 类型定义，则在生成该段 `ExcerptToken` 时用一个 `Map` 记录下对应的引用的 `ts.Symbol`
> 3. 生成 `ApiItem` 树结束时，根据上述两个信息，对于每一个包含类型定义引用的 `ExcerptToken`，尝试找到该 `ts.Symbol` 对应的 `ApiItem`，并设置对应的路径。该路径即为 `api.json` 内的类型链接

##### 序列化 `ApiItem` 树

序列化相对简单，每一个 `ApiItem` 实现都会定义序列化函数 `.serializeInto()`，将其存储的数据序列化为 json 对象。

##### 反序列化 `ApiItem` 树

同样对应于序列化，每一个 `ApiItem` 实现都会定义静态的反序列化函数 `static .onDeserializeInto()`。整个流程控制在 `Deserializer` 中，其实现也很简单，根据 json 对象中的类型调用对应的 `ApiItem` 实现的函数。

### `ApiItem` 实现

`ApiItem` 定义了基类，公共的功能扩展通过 Mixin 的方式实现 (如`ApiItemContainerMixin`、`ApiReleaseTagMixin`)，其他的具体实现 (比如 `ApiPackage`，`ApiInterface`) 通过 继承 + Mixin 组合 的方式实现具体的定制功能。
