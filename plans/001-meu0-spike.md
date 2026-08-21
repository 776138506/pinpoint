# MEU-0 Spike：验证三个未确认点

## 完成定义
1. 纯前端 harness 实测：sandbox（`allow-same-origin allow-forms allow-popups`）+ srcdoc 的 iframe，父页面 JS 能读 `contentDocument`、`elementFromPoint` 命中内部元素、能对元素区域截图
2. 同 harness 实测：office 式容器（主文档 DOM div）文本选区捕获 + 区域截图可行
3. 最小 dsh client 插件（会话头部加一个「标记」按钮）以**第三方包**身份装进真实 dsh profile，`dsh web` 里按钮真实可见

## 验证方式
- harness：本地静态服务 + ego-browser 截图读回（视觉证据）
- dsh 插件：`dsh plugin --profile <test> add` 后启动 `dsh web`，ego-browser 截图证明按钮在
- 每项结论写进 spike 报告 `spike/REPORT.md`（过/不过 + 证据路径）

## 预估范围（开工前写）
本批做 2 项：
1. spike/harness 静态验证页（含 html2canvas 实测）
2. dsh-point 最小插件骨架 + 安装验证

## 实际范围（收尾时回填）
做了 2 项；+新增 0 / -砍 0 / ~改设计 0（设计假设全部成立，D9 闭环为 D10）
- harness 三验证全过（iframe DOM 可达 / html2canvas 区域截图 / office 选区+截图）
- 最小插件装进 point-test profile，「标记」按钮真实可见（ego-browser 截图 + OCR 读回）
