# dsh-live-status-hud v1.0.4

面向 [DeepSeek Harness (dsh `>=0.2.0-rc.1 <0.3.0-0`)](https://github.com/deepseek-ai/deepseek-harness) 的**实时任务状态 + 思考链 + 历史记录**漫画气泡插件，支持 Web 版与官方桌面端。

## 核心特性

- **开箱即用编译产物**：内置 `lib/index.js`（Host ESM，`export const inject = []` 即时激活，不写入未 `provide` 的 `ctx` 属性）与符合 `window.__ModuleLoader__.load` 规范的单文件 `lib/client.cjs`（Client lazy-CJS），通过 `ctx.slots.inject('shell.overlay', ...)` 等待插槽就绪后注册 `shell.overlay` 浮层。
- **零侵入只读监听**：不挂任何 `tools/pre-execute` waterfall 钩子，仅监听只读 `session/event`、`assistant/live-chunk`、`llm/stream` 与 `approval/request|asked|decided`，绝不影响工具链执行。
- **中文思考链与零消耗意图解说**：中文思考链原样实时展示；英文思考链默认在本地零 Token 消耗地按意图提炼为可爱中文解说（非逐字机翻，随时可点右下角“偷看英文原文”对照完整原文）；支持 `304 Not Modified` 零负载轮询与亮/暗主题自动适配。
- **自动收缩 + 持久历史**：空闲或完工 12 秒且鼠标未悬停时自动连同抽屉收成 `💭` 小圆标；单轮支持最多 50 条真实工具记录，每轮结果自动归档至「📜 历史」并持久化到 `localStorage`。
- **双模式挂件支持**：默认自动锚定网页内挂件（如 `DeepSeek-Balance-Whale-Widget`）并避让余额气泡；独立原生窗桌宠（如 `dsh-dafeiyu` 默认模式）或无挂件环境下会自动显示内置“小鲸灵”，抽屉右上角也可一键切换「🐋 跟随 / ✨ 独立」。

## 安装与测试

```powershell
# 1. 运行内置单元测试与 Cordis 严格代理 + 浏览器 VM 验证
node --test tests/tracker.test.mjs

# 2. 安装到 Web 版
dsh plugin --profile web add D:\dsh-plugins\dsh-live-status-hud
```

* **官方桌面端安装**：由于桌面端的 `desktop` profile 由 Electron 独占管理，请在官方桌面端左侧点击 **「插件 → 添加插件」** 安装（或使用桌面端安装包内置的 CLI 并在彻底退出桌面端后操作）。
* **调试验证**：启动后访问 `<当前 DSH 地址>/dsh-live-status-hud/debug`（Web 版默认端口为 `3080`，桌面端使用系统动态分配端口）即可查看脱敏状态摘要；也可以直接双击 `demo/preview.html` 离线预览气泡交互。
