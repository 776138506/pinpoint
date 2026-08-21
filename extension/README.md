# dsh-point 浏览器扩展（MV3）

Chrome / Edge 通用，让用户在任意网页上标记元素并发送到本地 `localhost:8897` 的 dsh 会话。

## 安装方式（开发者模式加载）

1. 确保 dsh `point-test` profile 已在 `http://localhost:8897` 运行。
2. 在本项目根目录执行 `pnpm run build`，生成 `extension/dist/` 下的三个 js 文件。
3. 打开 Chrome / Edge，地址栏输入 `chrome://extensions`（或 `edge://extensions`）。
4. 开启右上角「开发者模式」。
5. 点击「加载已解压的扩展程序」，选择本目录 `dsh-point/extension/`（包含 `manifest.json` 的文件夹）。
6. 扩展图标出现在工具栏；点击图标打开右侧 Side Panel。

## 使用流程

1. 在 Side Panel 选择目标会话（默认最近更新会话），或点击「新建测试会话」。
2. 点击「开始标记」，网页进入标记模式（光标变十字）。
3. 悬停高亮，点击元素捕获所指，弹出评论窗。
4. 「发送」立即发送；「暂存」进入 Side Panel 待发列表，可统一发送或逐条发送。
5. 已发送的所指在页面角标变绿；发送失败的显示错误原因。

## 权限说明

- `sidePanel`：原生侧边栏。
- `tabs` / `activeTab`：向当前标签页 content script 发送命令。
- `host_permissions: http://localhost:8897/*`：background 向本地 dsh 实例发 RPC。

## 已知上限

- 截图走 DOM-clone + html2canvas，含非 CORS 外部图片时可能缺失。
- 图片附件若被 harness 校验拒绝，会自动降级为纯文本所指并在 UI 明示。
- 不做扩展商店上架、Firefox、鉴权、PDF 内标记、`captureVisibleTab`。
