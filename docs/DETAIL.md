# dsh-live-status-hud 详细说明（v1.0.1）

## DSH 0.2.2-rc.3+ 兼容修复清单

本版本对照 DeepSeek Harness `0.2.2-rc.3` 实机源码完成了全部 P0/P1 适配：

1. **提供完整编译产物**：Host 入口指向原生 ESM `./lib/index.js`，Client 入口指向单文件 lazy-CJS `./lib/client.cjs`（仅外部引用 `react`），无需本机安装额外编译工具即可直接加载。
2. **零风险只读事件监听**：完全移除 `tools/pre-execute` waterfall 监听，只订阅只读 `session/event`（`tool/call`、`tool/result`、`command/run`、`command/done`、`turn/start`、`turn/end`、`assistant/message`），绝不阻断或影响任何工具调用。
3. **对齐真实 `webServer.register` 签名**：使用 `ctx.webServer.register({ kind: 'exact', path, handler })` 注册 `/dsh-live-status-hud/snapshot` 与 `/dsh-live-status-hud/debug`，并移除已不存在的 `ctx.connection.rpc` 调用。
4. **对齐真实 `slots.register` 签名**：使用 `ctx.slots.register({ name: 'shell.overlay', id: 'live-status-hud' }, LiveStatusOverlay)` 注册浮层。
5. **对齐真实审批与思考流词汇**：监听 `approval/request`、`approval/asked`、`approval/decided` 与 `assistant/live-chunk`、`llm/stream`。

## 关于挂件适配与规范模式切换

- **大肥鱼 / 社区挂件跟随模式（默认 `whaleAdapter.enabled: true`）**：自动锚定 `DeepSeek-Balance-Whale-Widget`（`.dshwv-img`）、`dsh-dafeiyu`、`dsh-pet` 等挂件头像，无气泡紧贴、有气泡自动远离避让。
- **严格零跨插件 DOM 读取模式（`whaleAdapter.enabled: false`）**：在 `cordis.patch.yml` 中将 `whaleAdapter.enabled` 改为 `false`，插件将完全不读取任何其他插件的 DOM，仅使用内置 SVG “小鲸灵”渲染气泡。
