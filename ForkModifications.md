# Fork Modification (by adventure-yunfei)

## `api-extractor`

- 新增 `import Foo = Bar.Baz;` 语法支持（根节点声明场景）(3d696a3305c050a21c092de5378430e2851d61a0)
- ~~新增完整的引用类型链接支持, 包括未导出的类型 (59e634c68baa4cac277bec171f4c6f404c9d384b)~~ api-extractor 本身已支持, 已回滚 (62809e68ec1198506ca8a0604fd9eeace10110da)
- fix：修复 API JSON 中的导出命名 (297e6c70dd7d5f4ea5bd28c4b20e49e94ed277d2)
- 修正 Entity 变量和 namespace 内的变量的命名冲突 (c103df149fc202f1b8b28f401c4c848b6b566b1e)
- 修正 import type `import('abc')` 语法支持 (fb6318877dbccb07ab6261bf3b2a2632aa28c297)
- 优化 `AstNamespaceImport` 输出结果 (5ffd9dde49218c26b146de7ffa6701a4bf761309, 8c2d1295f1e6cbe09d0f8282cd09556f43551321)
- 新增 Release Trimming 功能 (33c17c2c814a8b2ecd7058a9dc93b99a1e3243df)
- 修正 DeclarationReference 解析 (e5fdc6c83bfff078c1d19ad50b47063d17641f1b)
  <details>

    此前的错误场景：
    ```ts
    // 原始文件：index.ts
    interface ConstructorOf<T> {
      new (...args: any[]): T;
    }
    function createSomeBaseClass<T>(): ConstructorOf<T> {
      return class {} as ConstructorOf<T>;
    }

    export class Foo extends createSomeBaseClass<{ prop: number }>() {}

    // 编译出 dts 文件：index.d.ts
    interface ConstructorOf<T> {
      new (...args: any[]): T;
    }
    declare const Foo_base: ConstructorOf<{
      prop: number;
    }>;
    export declare class Foo extends Foo_base {
    }
    export {};
    ```

    此时使用 api-extractor (并配置`"includeForgottenExports": true`) 编译，`extends Foo_base` 中的 Foo_base 的 DeclarationReference 引用链接生成错误，导致找不到实际对象。

  </details>
- 修正 `includeForgottenExports` 激活时不必要的 api 内容生成；修正 `AstNamespaceImport` members 的 DeclarationReference 解析 (cb9eee4a45d0cce9661d6282c7fc8d994fdc22e2)
  <details>

    此前的错误场景：
    ```ts
    // 原始文件: index.ts
    import * as FooModule from './foo-reexport';
    export { FooModule }
    // 原始文件: foo.ts
    export class OriginClass {}
    export class Foo {
      declare fooProp: OriginClass;
    }
    // 原始文件: foo-reexport.ts
    import { OriginClass as AnotherClass, Foo } from './foo';
    export { AnotherClass, Foo };
    ```

    - 问题1: 激活 `includeForgottenExports` 时，除了正常的 namespace 节点树 (`FooModule.AnotherClass`/`FooModule.Foo`) 外，还会额外在根节点生成重复的 `~OriginClass`/`~Foo` 节点
    - 问题2: 解析 DeclarationReference 时，没有考虑 `AstNamespaceImport`, 导致在 `Foo.fooProp` 中生成了无效的 `FooModule.OriginClass` 引用路径

  </details>
- 优化 `nameForEmit` 在冲突时的命名策略，添加文件路径以区分声明来源 (1b8a738a6880d31ac80a6c719254deccbbfed9f1, bfbfe5610f65ff908ec0ec843335bab9bdb5c9f4, d38122b09c990aac3946fee936b184f2757aa38f)
  <details>

    输入类型：
    ```ts
    // propA.d.ts
    export interface Prop {}
    // propB.d.ts
    export interface Prop {}
    // index.d.ts
    import { Prop as PropA } from './propA';
    import { Prop as PropB } from './propB';
    export declare class Foo {
      prop: PropA | PropB;
    }
    ```

    优化前的 dts 输出：
    ```ts
    interface Prop {}
    interface Prop_2 {}
    export declare class Foo {
      prop: Prop | Prop_2;
    }
    export {};
    ```

    优化后的 dts 输出：
    ```ts
    interface Prop__propA {}
    interface Prop__propB {}
    export declare class Foo {
      prop: Prop__propA | Prop__propB;
    }
    export {};
    ```

    冲突概率也会更小，输出文件不会频繁大面积变更。

  </details>
- 新增 api-review string union type 结果排序 (4869e262d5de89051cd689230d52207daa8f15f4)
  <details>

    输入类型：
    ```ts
    export type Foo = 'b' | 'c' | 'a';
    ```

    优化前的 dts 输出：
    ```ts
    export type Foo = 'b' | 'c' | 'a';
    export {};
    ```

    优化后的 dts 输出：
    ```ts
    export type Foo = 'a' | 'b' | 'c';
    export {};
    ```

    某些情况下 ts 会自动编译产出一些 string union 类型（比如 `Omit` 类型），这些 string 类型有时候会变更顺序，导致不必要的 api review 变更；排序可以消除这类变更。

  </details>
- 优化&裁剪 api-review 导出 (b2c51d7b0ce7a7afa6d7b01beeabbd129d3c05ff)
  - 默认开启 `@beta` release 裁剪，移除 `@internal` 变更
  - 新增 entity 有效引用分析，`includeForgottenExports` 下仅导出实际被引用的 entity
  - 新增 rootExportTrimmings 选项，裁剪根节点导出内容 (通过 `env.API_REPORT_EXPORT_TRIMMINGS` 环境变量设置)

## `api-documenter`

- 新增完整的引用类型链接支持, 包括未导出的类型 (59e634c68baa4cac277bec171f4c6f404c9d384b)
- markdown 输出结果兼容 mdx@1.x，以支持 Docusaurus 文档工具 (73be47af637970a5a54240a752e8fc579bbbde1f)
- 支持移除 Home 导航链接 (59afa81a5545a93449e3a22a60a22a78054188b1)
- `ApiPackage` 页面仅生成导出接口内容 (90c1a4efb1ca60b2347163432710fe957f2ce6db)
