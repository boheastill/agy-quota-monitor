# agy-quota-monitor（Antigravity 额度与会话负载看板）

**简体中文** | **[English](./README.md)**

专为 **Google Antigravity 2.0 桌面端** 打造的**零依赖、纯只读原生副栏面板插件（Sidecar UI Plugin）**。只需在对话右上角点击 `+` → **Quota**，即可与聊天窗口左右并排实时查看：

1. **全局剩余额度池（`5h` 短期池 / `7d` 周额度池 + `AI Credits` 余额）** —— 直观绿/黄/红进度条 + 精确到秒的重置倒计时（底层调用官方 `agy` CLI JSON 接口，**0 模型 Token 消耗**）。
2. **当前会话工作量透视** —— 实时统计当前会话（自动汇总其派生的所有 `invoke_subagent` 子智能体）消耗的 `新输入 Input`、`缓存读取 Cache`、`思考输出 Output` 与缓存命中率；展开可看每一轮问答的消耗柱状条，并自动标记 **“⚠ 缓存过期重算”**（例如间隔 1 小时重聊导致整段上下文重新全价计费）。
3. **最近会话消耗对比榜** —— 采用 **100% 确定性的标准计费当量** 对本地活跃会话排序对比，一眼识别哪个对话是真正的“吞金兽”，在客户端内点击即可一键跳转到对应会话。

---

## 核心设计哲学：确定性标尺 & 永久免维护

很多用量工具喜欢硬编码“各模型美元价格表”或联网抓取价格页，这在实际使用中有两个致命痛点：一旦离线、改版、或者遇到内部新模型代号（如 `gemini-4-carbon-high`）就会失效报错；且价格表变动会导致历史会话数字前后漂移。

本插件追求**做完即稳、零维护精力**：

- **完全基于公开合规路径**：只读调用官方 `agy -p "/usage" --output-format json` 与本地会话日志 `transcript.jsonl`，**不逆向客户端内部私有 RPC，也不挂 `hooks.json` 拦截对话主链路**——哪怕网络抖动或客户端升级，也绝不会卡住你的正常对话。
- **零第三方 `npm` 依赖**：直接运行在 Antigravity 内置的 Node 运行时与官方 `sidecar_sdk` 之上，无需 `npm install`。
- **确定性计费当量口径（Built-in `ⓘ` 透明说明）**：
  ```text
  有效当量 (Effective Tokens) = 新输入 × 1.0 + 缓存读取 × 0.1 + 思考输出 × 4.0
  ```
  *1 单位 = 1 个标准未缓存输入 Token。跨主流大模型体系，缓存读取成本约为新输入的 1/10，思考与输出约为新输入的 4 倍。使用固定权重既免去了用户自己心算“总 Token × 缓存未命中率”的负担，又保证在任何新模型下永远口径一致。面板右上角也支持一键切换查看“原始总 Token”。*

---

## 快速安装

### 第一步：安装官方 `agy` CLI（可选，用于读取顶部云端剩余 `%`）

> 下半区的**本地会话工作量与排行榜开箱即用**，无需任何额外工具。
> 若需同时显示顶部的 `5h / 周额度` 百分比进度条，只需装一次官方 CLI 并完成首次登录：

```powershell
# Windows (WinGet)
winget install --id Google.AntigravityCLI --accept-source-agreements --accept-package-agreements
agy
```

```bash
# macOS / Linux
curl -fsSL https://antigravity.google/cli/install.sh | sh
agy
```

### 第二步：部署插件

#### 方式 A：使用一键脚本安装到桌面端全局目录（推荐本地使用）
```powershell
# Windows PowerShell
.\scripts\install.ps1
```
```bash
# macOS / Linux
chmod +x scripts/install.sh && ./scripts/install.sh
```
*(脚本会将插件安装到 `~/.gemini/config/plugins/agy-quota-monitor/`，对本机所有项目与新建对话生效。)*

#### 方式 B：发布到 GitHub 后使用官方 CLI 一键安装
```bash
agy plugin install https://github.com/boheastill/agy-quota-monitor
```

### 第三步：在聊天窗口打开面板

1. 在左侧 **Skills & Customizations → Plugins** 中确认 **Quota Monitor** 处于开启状态。
2. 在任意对话窗口右上角点击 **`+`** 按钮，选择 **Quota** 即可常驻并排显示。

---

## 智能联动刷新机制（省资源且及时）

- **本地会话 Token 明细**：面板打开期间每 2.5 秒做一次轻量文件 `mtime` 检查（未变化时耗时 `<1 ms`，零磁盘压力）。
- **云端剩余百分比（`agy` CLI）**：
  1. 打开面板时查询一次；
  2. **任务完成联动**：检测到当前对话刚有新的模型回复落盘、停稳 3.5 秒后，**自动触发一次云端额度刷新**（刚聊完往右看就是最新百分比）；
  3. **静置低频兜底**：无对话时每 5 分钟刷新一次（关闭面板时后台零请求），并配有右上角手动立即刷新按钮 `↻`。

---

## 独立运行与自建 ACP Web UI 复用

如果你后续通过 `agy acp` 编写自己的 Web UI，可以直接用 Node.js（v20+）独立启动本仓库自带的轻量服务，复用完全相同的额度与会话统计接口：

```bash
node scripts/dev-server.mjs --port 4790
```

- 独立网页看板：`http://127.0.0.1:4790`
- JSON 数据接口：`GET http://127.0.0.1:4790/api/status?conversationId=<会话UUID>`

---

## 运行单元测试

使用 Node 原生 `node:test`，无需安装任何测试框架：

```bash
node --test test/collector.test.mjs
```

## 开源协议

[MIT](./LICENSE)
