# MEU-1：标记模式 + 捕获 + 页面原位反馈（真实 dsh 插件内）

## 完成定义
1. point-test profile 的会话里，点头部「标记」按钮进入标记模式（再点退出 / Esc 退出）
2. 悬停 preview 面板的 srcdoc 网页 iframe 内元素、office 渲染容器元素：红色高亮跟随
3. 点击元素后：捕获所指（选择器/可见文本/截断 outerHTML/来源标题）+ html2canvas 区域截图（useCORS:true），且**页面上留下编号角标 + 保持高亮**
4. 角标随滚动/缩放跟随；点角标可删除该标记（编号不重排，空洞保留）
5. 标记数据进 client store（切会话/重渲染不丢当前会话的标记）

## 验证方式
- ego-browser 走完整流程截图读回：进入标记模式 → 悬停 → 点击 → 角标出现 → 滚动后角标仍贴住元素 → 点角标删除
- 跨源 iframe（外部 URL 预览）点击 → 中文失败文案（发生了什么/为什么/怎么办）
- 非 CORS 外部图元素截图 → 出图 + 「外部图片可能缺失」提示

## 预估范围（开工前写）
本批做 4 项：
1. 标记模式状态机（关/悬停/已标记）+ client store
2. 事件监听层（主文档 + 同源 iframe，坐标直用不换算——D10 教训）+ 高亮渲染
3. 捕获（结构化信息 + html2canvas 截图）+ 失败文案
4. 编号角标 overlay（定位/滚动跟随/删除）

## 实际范围（收尾时回填）
1. 标记范围收窄到 preview 面板（D12）：主文档只监听 `div[data-office]`，iframe 只监听 `iframe[data-testid="web-preview-frame"]`；宿主 UI 点击给中文提示「只能标记预览面板里的内容」。
2. 标记模式状态机 + client store（不变）。
3. iframe / office 容器事件监听 + 高亮 + 捕获 + html2canvas 区域截图。
4. 编号角标 overlay（定位/滚动跟随/删除）。
5. 失败文案：跨源 iframe 覆盖提示与 toast、外部图片缺失提示、截图失败兜底文案。
6. 生成 `spike/REPORT-meu1.md` 与 ego-browser 证据截图。

偏差：原计划未显式列出「范围收窄」，属于 D12 落地；无新增文件/依赖。
