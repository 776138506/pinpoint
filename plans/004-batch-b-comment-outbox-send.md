# 批 B：评论窗 + 待发列表 + 发送管道（dsh-point 插件）

> 原 MEU-2 + MEU-3 合并。依赖 MEU-1 的标记/角标/store（已完成）。

## 完成定义
1. 点击元素完成标记后，跟随元素弹出评论窗：文本框 +「发送」「暂存」两个按钮
2. 「发送」：该条所指（结构化文本 + 区域截图）+ 评论组装成 user/message 立即发到当前会话（模型收到文本和图片）
3. 「暂存」：进待发列表（输入框上方，挂 `conversation.composer.dock` 槽位）；列表支持统一发送（全部拼成一条消息）、逐条发送、删除
4. 待发列表「回输入框编辑」：所指+评论插进 composer 草稿（文本进输入框、截图进附件栏），用户改完自己发
5. 点页面角标可查看/修改评论、删除标记；已发送的标记角标变为已发送态（视觉区分，不可再编辑）
6. 失败文案三要素全覆盖：发送失败（网络/会话失效）、截图缺失（外部图）、空评论发送确认

## 验证方式
- ego-browser 全流程截图读回：标记 → 评论窗 → 暂存 → 列表 → 统一发送 → agent 真实收到（会话里看到消息）；逐条发送；回输入框编辑
- 「模型真实收到」需要 point-test profile 配可用模型 key（沿用 spike 已打通的配置）

## 预估范围（开工前写）
本批做 5 项：
1. 评论窗组件（跟随元素锚定，复用角标定位逻辑）
2. 待发列表（composer.dock 槽位）+ store 扩展（评论/状态机：待评论/已暂存/已发送）
3. 直发管道（结构化文本序列化 + 图片附件 → session.prompt / agent.followup）
4. 草稿插入管道（ui-conversation 草稿契约：文本插入 + addImages）
5. 角标评论查看/改/删 + 已发送态

## 实际范围（收尾时回填）
2026-08-19 回填。实际做 5 项 = 预估 5 项，外加验证中修的 2 个实现 bug：

1. 评论窗：标记后跟随元素弹出，文本框 +「发送」「暂存」；已发送标记角标点开可看原评论（textarea disabled，视觉区分 `dsh-point-badge sent`）
2. 待发列表：`conversation.composer.dock` 槽位挂 PointDock，「待发所指 (n)」+ 统一发送 / 逐条发送 / 回输入框 / 删除
3. 直发管道：走宿主 scope 寻址的 `conversation` 服务——`createDraftImages`（截图附件）+ `sendSession(session, text, ids, 'queue')`；不 import ui-conversation 内部
4. 草稿插入管道：`conversation.input.for(actx)` 的 `setDraft` + `addImages`（回输入框编辑）
5. 端到端证据（spike/evidence/batch-b/）：标记→评论→发送→Kimi K3 真实收到图片并回复（06）；暂存×2→dock 计数（07）→统一发送拼一条 `[所指 #1]/[所指 #2]`（08）；已发送角标查看（09）

验证中修复的 bug：
- `util.ts` `dataUrlToFile` 不再硬校验 `image/png`（html2canvas 某些浏览器输出 webp/jpeg）
- `engine.ts` 新增 `cloneForScreenshot`：iframe/office 内元素先克隆到顶层文档并内联 computed style 再截图——原实现直接截 iframe 内元素得 `data:,` 空图

偏差/遗留：
- 完成定义 ⑥「失败文案三要素」只覆盖了发送路径；html2canvas 失败场景未构造出来实测
- 「让模型调 preview_asset 打开预览」未走通：point-test 的 creation-mode preset 没暴露 preview_asset 工具（发送管道本身已验证）
- 只有 Kimi K3 接受图片附件；DeepSeek V4 Pro / Qwen3.7 Max / GLM-5.1 被 harness 附件校验拒绝（`does not support image input`）——**用户验收前需把会话模型切到 Kimi K3**
- 标记持久化（切会话/刷新保留）未做，属后续批次
