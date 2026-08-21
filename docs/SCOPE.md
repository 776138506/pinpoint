# 业务全景

## 场景 1：用户在 dsh Web UI 看 agent 产物预览（网页/docx/xlsx），想指着某处让 agent 改或解释
| 功能 | 状态 | 批次/plan | 备注 |
|---|---|---|---|
| 标记模式（悬停高亮 + 点击捕获） | ✅ | plans/002 | MEU-1 完成，范围已按 D12 收窄到 preview 面板 |
| 页面原位反馈（编号角标 + 保持高亮，滚动跟随） | ✅ | plans/002 | D11，MEU-1 完成 |
| 所指 = 结构化信息 + 区域截图 | ✅ 技术验证 | plans/001 | spike 通过，形态见 D2/D10 |
| 评论窗（跟随元素，「发送」/「暂存」双按钮） | ✅ | plans/004 | 批 B 完成，证据 spike/evidence/batch-b/ |
| 待发列表（统一发 / 逐条发 / 回输入框编辑） | ✅ | plans/004 | 批 B 完成，挂 composer.dock |
| 发送管道：所指+评论 → user/message（文本+图片）/ 进草稿 | ✅ | plans/004 | 批 B 完成，走宿主 conversation 服务（sendSession + createDraftImages + input.setDraft/addImages） |
| 预览默认落地页（Codex 式：打开网页 / 打开 Office 文档） | ✅ | plans/003 | 批 A 完成，dsh 上游 ui-preview，D13 |
| 预览工具栏 `preview.toolbar` 子槽 + 笔刷搬家 | ✅ | plans/003 | 批 A 建槽、主 agent 搬家完成（joint-03 截图） |
| @ 引用芯片 | ✂ | — | 2026-08-18 评论流取代，见 DECISIONS D11 |
| prompt section 告诉模型所指格式 | ✅ | plans/010 D2a | node 半段注册 `dsh-point:referent-format` system-prompt section |
| 外部 URL 预览元素级标记 | ✅ | plans/006, plans/008 | 经 /preview-proxy 代理同源可标；缩放适配坐标已联调（C2d） |

## 场景 2：用户在浏览器任意网页圈元素问 agent（阶段二）
| 功能 | 状态 | 批次/plan | 备注 |
|---|---|---|---|
| 浏览器扩展 content script 圈选 | ✅ | plans/009 | 悬停高亮/点击捕获/编号角标/评论窗（发送/暂存）+ DOM-clone 截图；证据 `spike/evidence/batch-d1/ego-mark-captured.png` |
| Side Panel 待发列表/目标会话选择/连接状态 | ✅ | plans/009 | `chrome.sidePanel` + background 端口同步；待发列表支持统一发/逐条发/删除 |
| background 发送通道（`POST /api/session.prompt`） | ✅ | plans/009 | host_permissions `http://localhost:8897/*`；图片附件被 harness 拒则降级纯文本并 UI 明示 |
| 扩展商店上架 / Firefox / 鉴权 / PDF 内标记 | ✂ | — | 本批边界，见 D16 |

## 场景 3：用户在 Office 桌面文档选内容问 agent（阶段三）
| 功能 | 状态 | 批次/plan | 备注 |
|---|---|---|---|
| macOS 抓 Office 选区（AppleScript/AX） | ⬜ | — | 优先于 Office.js 加载项（链路短） |
