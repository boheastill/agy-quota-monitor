# agy-quota-monitor（Antigravity 省额度助手）

**简体中文** | **[English](./README.md)**

> **小提示：** 如果你只想看还剩百分之多少额度，Antigravity 底部选模型的下拉框里本来就能看。做这个小工具只有一个实在目的：**在不升级套餐的前提下，帮你把现有的额度省下来耐造地用**——让你一眼看清「现在每发一句话背了多少字、缓存还剩几分钟过期、剩下的额度大概还能聊几轮」。

---

## 先花 30 秒看懂：额度到底是怎么不知不觉烧光的？

就算不装插件，记住下面这张图里的两条规律，你的额度立马能顶平时两三倍用：

![一张图看懂缓存打折与跨会话包袱](./assets/how-cache-works-zh.svg)

1. **你敲了 10 个字，背后其实发出去几百万字**
   在一条聊了很久的对话里敲一句「帮我改下按钮颜色」，系统其实会把**从头到尾整本聊天记录（动辄 30 万～50 万 token）**重新打包发给 AI。更隐蔽的是：你发 1 句话，AI 查文件、改代码、跑命令平均要连续跑 **6～10 步**，每一步都要背着这几十万字跑一趟。
2. **60 分钟是道悬崖，中途换模型也会清零缓存（差 10 倍）**
   - **60 分钟内、同模型接着发**：服务器还记着前面的旧记录，旧内容大约**打 1 折（`0.1×`）**；
   - **停顿超过 60 分钟**，或者**在长对话中途切换模型**（比如 `Neon` 切 `Carbon`）：缓存当场清零，整本旧记录按 **10 倍原价（`1.0×`）**重新算一遍。
3. **跨会话交接最容易踩的大坑：「让新对话去读旧对话」**
   很多人听说开新对话省额度，于是新建一个对话说：*「你去读一下我刚才那个旧对话记录。」*
   这一下踩了双重坑：新对话没有任何缓存，第一步先**全价硬吞几十万字**；读完那一刻，新对话自己的包袱也瞬间涨到了几十万字，等于白开新帖。
   **真正省额度的做法：** 趁旧对话还在 60 分钟缓存期内（打 1 折），让旧对话输出一份 **1500 字的交接摘要**，只把这 1500 字贴进新对话（包袱从 30 万直接卸回 2 千）。

---

## 装上后，右侧面板直接给你看什么？

![Antigravity 省额度助手桌面端预览](./assets/preview-desktop.png)

<details>
<summary>展开查看「快过期提醒」与「已过期全价预警 + 历史对账」（亮/暗双色主题）</summary>

![亮暗双色主题对比](./assets/preview-themes.png)

</details>

没有任何长篇大论的报告，只盯着你正在聊的对话说三句人话：

- **当前包袱多重**：比如 `当前包袱 316k（偏重 · 新对话的 16×）`，顺带标出这条对话每发一句 AI 平均连跑几步，让你对每次回车的“重量”立刻有体感。
- **60 分钟缓存倒计时 + 其他对话快过期提醒**：实时精确到秒（`🟢 还剩 46m 过期` → `⚠️ 快过期！还剩 8m 40s` → `💀 已停太久缓存已过期`）；如果后台另一个大对话快满 60 分钟了，也会跳出一行提醒你趁热收尾。
- **剩下的 5h 额度大概还能聊几轮**：自动根据你本机真实的 `5h` 百分比变化校准，用单色长短条直观对比三种聊法：
  - **趁热接着聊** vs **晾凉/切模型聊** vs **总结 2k 字去新对话**，底下直接配好 **`📋 复制「趁热压缩 1500 字交接单」指令`** 按钮，点一下贴进旧对话就能无痛换新帖。
- **底部一行折叠对账**：之前哪几轮因为超 1 小时或换模型多花了额度，默认收起在最底下占一行，想核对证据时点开就能看到具体第几轮、隔了几分钟。

---

## 一句话让你的 AI 自动帮你装好（最省心）

直接把下面这句话复制发给你的 **Antigravity**（或其它本地编程助手），它会自动检查并帮你配好插件（面板右上角可随时切换 **`中` / `EN`**）：

```text
请读取 https://raw.githubusercontent.com/boheastill/agy-quota-monitor/main/setup/SKILL.md 并按步骤帮我在本机自动安装好这个额度面板插件
```

装好后，在任意对话右上角点 **`+` → Quota** 即可打开。

---

## 手动安装方式

### 1. 安装官方 `agy` CLI（可选，用于同步顶部 `5h / 7d` 剩余百分比）

> 不装 CLI 也能离线看包袱重量、60 分钟缓存倒计时和省额度倍数；装上 CLI 后即可自动同步云端百分比并实测校准剩余轮数。

```powershell
# Windows (PowerShell)
winget install --id Google.AntigravityCLI --accept-source-agreements --accept-package-agreements
```
```bash
# macOS / Linux
curl -fsSL https://antigravity.google/cli/install.sh | sh
```

### 2. 安装插件

```powershell
# Windows PowerShell
git clone https://github.com/boheastill/agy-quota-monitor.git
cd agy-quota-monitor
.\scripts\install.ps1
```

```bash
# macOS / Linux
git clone https://github.com/boheastill/agy-quota-monitor.git
cd agy-quota-monitor
chmod +x scripts/install.sh && ./scripts/install.sh
```

---

## 纯官方只读通道，升级不坏、绝不卡聊天

- **不碰任何私有接口**：云端百分比直接调官方 `agy -p "/usage" --output-format json`（不消耗大模型 Token），会话数据只读本地 `transcript.jsonl` 日志。
- **零第三方 `npm` 依赖**：纯 Node.js 标准库 + Antigravity 原生 `sidecar_sdk`，不挂聊天拦截钩子；关掉右侧面板时后台零轮询。
- **支持独立网页与 JSON 接口**：运行 `node scripts/dev-server.mjs --port 4790` 即可在浏览器单独查看，或供自建 `agy acp` 工具调用 `/api/status`。

## 开源协议

[MIT](./LICENSE)

---

由 **[Bohea Still](https://boheastill.com/zh/?r=gh-agy-quota)** 独立开发维护 —— 专注工业自动化通信、边缘网关与务实的 AI 工程工具。
