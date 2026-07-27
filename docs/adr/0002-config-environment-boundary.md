# ADR-0002：新业务内核的配置与环境边界

- 状态：Accepted
- 日期：2026-07-26
- 范围：新建的 `src/server/core/**`、`src/server/adapters/**`、`src/server/interfaces/**`、`src/server/composition/**`

## 背景

旧运行路径同时存在直接 `process.env` 读取/写入、`getAppConfig()`、`getAppContext()`、`getDb()` 和模块级缓存实例。把环境读取改成导出的 TypeScript 变量不会消除隐式依赖、测试污染、多实例串配置和更新时机不确定问题。

Provider 启动又确实需要少量宿主平台事实、工具链路径和第三方认证变量。因此决策不能是机械地禁止所有环境变量，而应隔离原始环境读取并建立明确的子进程协议边界。

## 决策

1. 当前只存在认证产品策略，由认证 Composition 显式构造并注入；不得为了未来模块提前创建全局 AppConfig。
2. 未来业务模块引入产品配置时，必须先实现唯一 Resolver、固定覆盖顺序、输入校验和不可变快照，再接入 Composition。
3. 安全硬约束优先于所有配置来源；沙箱要求、认证 Cookie 属性和密码策略不能被低优先级输入放宽。
4. 原始 `process.env` 只允许在 Desktop/Standalone 启动、宿主环境采集和 Worker 进程协议边界读取；Core/Application 禁止读写。
5. 宿主平台环境由 `HostEnvironmentSource` 形成只读快照，Provider 配置和单次 Turn 控制使用类型化对象传递。
6. Provider 子进程环境由统一 Environment Compiler 生成；CodeTask 内部控制键不得整体继承到子进程。
7. 认证 Runtime 及其数据库、清理器和服务由 `createRuntime()` 创建，由返回的 `ApplicationRuntime.shutdown()` 显式销毁；不存在 Server Core 全局 AppContext Getter。
8. 新 SQLite 连接由 `KernelSqliteDatabase` 实例持有，禁止调用旧 `getDb()`。
9. Thread、Conversation、Project、Plan、Job、Task、Settings、MCP、SSE 和 Retention 等业务模块已从当前底座删除；以后逐个功能重新设计，不恢复旧全局状态。

## 自动门禁

`npm run check:core-boundaries` 使用 TypeScript AST 检查：

- Domain/Application 的非法跨层 import。
- 新内核反向 import Legacy、旧 Application、V3 HTTP 或旧 control-plane SQLite。
- 非 Environment Adapter 的 `process.env` 访问。
- 全部 `process.env` 写入。
- 模块顶层 `let`/`var`。
- 未来 Config Defaults 绕过唯一 Resolver 的导入。

脚本包含违规源码自测，防止门禁因实现错误而静默失效。

## 后果

- Desktop/Server 仍可从环境取得少量部署启动输入，但必须在入口转换为显式参数。
- Provider 第三方认证环境变量仍可存在，但变量名必须由版本化 Profile 声明，值不得进入 AppConfig、数据库或日志。
- 不把环境变量机械改成模块级 TypeScript `let`；二者都是隐式全局状态。
- 同一进程可创建并销毁多套互不共享数据库或认证状态的 Runtime。
