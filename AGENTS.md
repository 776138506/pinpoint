# dsh-point 开发说明

dsh-point 是 DeepSeek Harness（dsh）的第三方插件：让用户「指着东西说话」——在预览内容（网页/Office 文档）上标记所指对象，以「截图 + 结构化文本」作为引用芯片带进与 agent 的对话，降低沟通成本。

## 技术栈与结构

- TypeScript + React（纯 props 组件），dsh client 插件体系（Cordis + slot 系统）
- 被插件宿主：`../deepseek-harness/`（**只读参照，禁止修改**）；其 `packages/client/AGENTS.md` 的 slot/props/ctx 纪律对本插件 client 半段同样适用
- 构建：tsdown（client bundle 产物 `lib/client.js` 才是 dsh 加载的东西）
- 安装：`dsh plugin --profile <name> add <本包路径>`；运行：`dsh web`（默认 http://127.0.0.1:3080）

```
src/index.ts       # host 半段：system-prompt section（告诉模型 [所指 #n] 格式）
src/client/        # 浏览器半段：标记模式 + @ 引用芯片
extension/         # Chrome/Edge MV3 扩展（content script / Side Panel / background）
spike/             # MEU-0 验证性代码（可丢弃）
docs/              # DECISIONS / PROJECT-STATE / SCOPE
plans/             # 每批一份 plan
architecture.c4    # likec4 边界图
```

## 词表（第一天定，全局统一）

- **标记**（mark）：用户圈选/选中内容的动作
- **所指**（referent）：标记产出的对象（结构化信息 + 区域截图）
- **引用芯片**（chip）：输入框草稿里的所指占位符
- 用户可见 UI 全中文；代码注释英文（与宿主仓库一致）

## 项目特有规则

- **不改 dsh 本体**：标记层用文档级监听 + overlay 实现；若将来上游加了 `preview.overlay` 子槽再迁移（见 DECISIONS D5）
- 跨源 iframe（外部 URL 预览）物理不可达 = 阶段一已知限制，不硬解（D6）
- 模型可见内容只搭 `user/message`（text+image）的车，不新增会话事件族（D4）

## 全局规范引用

- 测试策略 / mock 边界：`~/.agents/docs/testing.md`
- 代码审查清单：`~/.agents/docs/code-review.md`
- 异常边界 / 超时：`~/.agents/docs/exception-handling.md`
- 前端设计规范：`~/.agents/docs/specs.md`（先验证再引用）
