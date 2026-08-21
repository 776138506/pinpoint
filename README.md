# Pinpoint

[![CI](https://github.com/776138506/pinpoint/actions/workflows/ci.yml/badge.svg)](https://github.com/776138506/pinpoint/actions/workflows/ci.yml)

指哪打哪——在任意网页上标记元素、写下评论，截图 + 结构化文本**直达 dsh 会话**。
不再用"第几行第几个按钮"描述问题，指给对方看。

## 这是什么

Pinpoint 是 dsh（deepseek-harness）的沟通增强插件，解决人机协作里"说不清指的是什么"的问题：

- **标记**：在任意网页点击元素，自动捕获截图、CSS 选择器、文本摘录、坐标等结构化所指
- **评论**：标记后弹出评论窗，写完即发（或暂存后统一发送）
- **直达**：所指以结构化卡片渲染在 dsh 会话里，agent 拿到的是精确上下文而非模糊描述

## 组成

| 部分 | 位置 | 说明 |
|------|------|------|
| 浏览器扩展 | `extension/` | Chrome/Edge（MV3）。标记、评论、暂存列表、侧边栏 |
| dsh 插件 | `src/` | 渲染所指卡片、注入所指格式约定 |

## 使用

1. dsh 侧：安装本插件（见 `cordis.patch.yml` 与 `package.json` 的 `dsh` 声明）
2. 浏览器侧：`chrome://extensions` → 开发者模式 → 加载已解压扩展 → 选择 `extension/` 目录
3. 点击工具栏图标打开侧边栏，选择目标会话 → 开始标记
4. 快捷键：默认 `Alt+Shift+M` 开始/退出标记；可在扩展设置页"按哪个键绑哪个键"

## 开发

```bash
pnpm install
npm test          # tsc --noEmit 类型检查 + vitest
npm run build     # 构建 dsh 插件与浏览器扩展（esbuild）
```

- 设置统一在扩展选项页（实例地址、快捷键、高级超时项），侧边栏只留入口
- 标记暂存支持跨标签页（`(tabId, index)` 复合键）、点击跳转定位、二次编辑

## License

MIT
