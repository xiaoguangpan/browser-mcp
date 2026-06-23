# Browser MCP Server

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

通过 Chrome/Edge 扩展直接操作真实浏览器的 MCP 服务器。相对于 Playwright 等无头方案的轻量替代方案，直接操作真实浏览器，天然支持登录态页面。

适用于任何支持 MCP 协议（Model Context Protocol）的客户端，如各类 AI 编程助手。

## 架构

```
MCP 客户端 (任何支持 MCP 的 AI 编程工具)
  │  stdio JSON-RPC
  ▼
mcp-server.ts
  │  WebSocket ws://127.0.0.1:18765
  ▼
Chrome 扩展 (service worker)
  │  chrome.debugger / tabs / cookies API
  ▼
真实浏览器页面
```

非无头、不走 WebDriver、不依赖 Selenium。页面就是你日常用的浏览器，cookie/登录态天然保留。

## 前提条件

- Node.js >= 18
- Chrome 或 Edge 浏览器

## 安装

### 1. 加载 Chrome/Edge 扩展

1. 打开 Edge → `edge://extensions/`（Chrome 用 `chrome://extensions/`）
2. 打开"开发人员模式"
3. "加载解压缩的扩展" → 选择 `extensions/tmwd-cdp-bridge` 目录

确认工具栏出现扩展图标。

### 2. 安装依赖

```bash
cd /path/to/browser-mcp
npm install
```

### 3. 启动 MCP 服务器

```bash
npx tsx mcp-server.ts
```

看到两行输出即成功：

```
[ws] Listening on :18765
[ws] Extension connected
```

扩展的 service worker 可能延迟几秒连接，等出现 `Extension connected` 即可。

### 4. 配置 MCP 客户端

在任意支持 MCP 的 AI 编程工具中注册此服务，`command` 指向 `mcp-server.ts`：

```json
{
  "mcpServers": {
    "browser": {
      "command": "npx",
      "args": ["tsx", "/path/to/browser-mcp/mcp-server.ts"],
      "enabled": true
    }
  }
}
```

> 请将 `/path/to/browser-mcp` 替换为你的实际项目路径。

重启 AI 编程工具，即可在对话中调用所有 browser 工具。

## 所有工具

| 工具 | 参数 | 说明 |
|------|------|------|
| `connect` | 无 | 检查扩展是否已连接 |
| `tabs` | 无 | 列出所有打开的标签页（id, url, title） |
| `open_tab` | `url`, `active?` | 新标签页打开 URL |
| `switch_tab` | `tabId` | 切换到指定标签页 |
| `close_tab` | `tabId` | 关闭指定标签页 |
| `navigate` | `url`, `tabId?` | 当前/指定标签页导航到 URL |
| `snapshot` | `tabId?` | 获取页面可见文本内容 |
| `click` | `selector`, `tabId?` | 点击匹配 CSS 的元素 |
| `screenshot` | `tabId?` | 截屏，返回 base64 PNG |
| `evaluate` | `code`, `tabId?` | 在页面 MAIN 世界执行 JS，返回结果 |
| `type` | `text`, `tabId?` | 在焦点元素输入文本（CDP Input.insertText） |
| `fill` | `selector`, `value`, `tabId?` | 通过 CSS 选择器填充表单字段，触发 input/change 事件 |
| `press_key` | `key`, `tabId?` | 发送键盘按键（Enter / Escape / Tab / ArrowDown 等） |
| `wait_for` | `selector`, `timeout?`, `tabId?` | 轮询等待 CSS 选择器出现（100ms 间隔，默认 10s 超时） |

### 典型工作流

```
1. connect         → 确认浏览器在线
2. tabs            → 看当前有什么标签页
3. navigate(url)   → 打开目标页面
4. snapshot        → 读页面内容
5. click(selector) → 点链接/按钮
6. snapshot        → 读新内容
7. evaluate(code)  → 执行自定义 JS
```

## 最佳实践

### 1. 导航后等页面加载完再 snapshot

`navigate` 返回后页面可能还在加载。建议工具调用链中给 AI 足够的上下文判断。

### 2. tabId 传递

所有操作默认在当前活动标签页执行。如果打开了多个标签页，AI 会自动用 `tabs` 查看可用标签页，然后传入 `tabId` 精确定位。

### 3. click 选择器

优先用语义化的 CSS 选择器：

```
good:  a[href*="/article/"]    #search-button
bad:   body > div > p > a     .c-OMlI
```

### 4. evaluate 适合什么

- 提取结构化数据（JSON 格式的表格、列表）
- 触发页面 JS 函数
- 读取页面内部状态（`window.__INITIAL_STATE__` 等）
- 滚动、悬停等无法用 click 完成的操作

例子：

```
evaluate(code: "JSON.stringify([...document.querySelectorAll('a')].map(a => ({text:a.textContent, href:a.href})))")
```

## 注意事项

- **扩展 service worker 可能休眠**：Chrome MV3 的 service worker 约 30s 无活动后休眠。首次调用加 1-2s 唤醒延迟。服务器每 ~24s 发送 keepalive 维持连接
- **CDP 免 CSP**：`evaluate` 走 CDP `Runtime.evaluate`，不受页面 CSP 限制，不需要 `eval`/`Function`。比 `scripting.executeScript` 快 100-1000x
- **URL 重定向**：某些网站（百度、微博）有跳转中间页，navigate 返回的可能不是最终 URL
- **单扩展实例**：目前只支持一个浏览器实例连接

## 安全说明

- WebSocket 服务器仅绑定 `127.0.0.1:18765`，不暴露于外部网络
- `evaluate` 工具可在页面 MAIN 世界执行任意 JavaScript，具有与页面本身相同的权限
- 任何能访问本机的本地进程均可连接 WebSocket 并控制浏览器，请确保运行环境可信

## 性能参考

| 操作 | 典型耗时 |
|------|---------|
| snapshot | 7-40 ms |
| click | 20-40 ms |
| evaluate | 5-10 ms |
| screenshot | 60-105 ms |
| navigate | 300-3600 ms（网络开销）|
| open_tab | 3-5 ms |

非导航操作均 <100ms。AI 推理延迟（0.5-3s）才是"感觉慢"的主因。

## 贡献

欢迎提交 Issue 和 Pull Request。请确保代码风格一致并通过 `npm run build` 类型检查。

## 许可证

MIT — 详见 [LICENSE](./LICENSE) 文件。
