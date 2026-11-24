# agy-quota-monitor（Antigravity 额度与会话消耗看板）

**简体中文** | **[English](./README.md)**

不用再每次点进 **“设置 → 模型”** 翻来翻去看余额了。
这是一个给 **Google Antigravity 2.0 桌面端** 做的右侧小看板插件，装好后挂在聊天窗口右边，边聊边看：

![Antigravity Quota Monitor 桌面端实景预览](./assets/preview-desktop.png)

<details>
<summary>展开查看亮 / 暗双色主题与超速预警 / 轮次明细</summary>

![亮暗双色与展开详情对比](./assets/preview-themes.png)

</details>

1. **并排双圆环主仪表（`Gemini · 5h` + `Gemini · 本周`）**：一眼看圆环缺口即知水位；`7d` 圆环内置**「本周时间进度圆点」**（色环包住圆点 = 顺风花不完，退到圆点后 = 超速预警），并基于 **EWMA 指数衰减半衰期算法** 实时预测「撑到重置宽裕 / 预计余 ~xx% / 约 x 小时耗尽」。
2. **次要模型池默认折叠**：`Claude / GPT` 默认收成一行极简摘要条（点击可展开详情），`AI Credits` 为 0 时自动隐藏，一屏尽览无需上下滚动。
3. **到底是哪个对话在猛吃额度**：单行微柱状榜自动拉取左侧栏简短会话标题（含子智能体汇总），悬停看缓存与原始 Token 明细，点击当前会话展开每轮消耗。

---

## 一句话让你的 AI 自动帮你装好（最省心）

你甚至不用自己敲命令——直接把下面这句话复制发给你的 **Antigravity**（或其它本地 AI 助手），它会自动帮你装好 `agy` 命令行并配好插件：

```text
请读取 https://raw.githubusercontent.com/boheastill/agy-quota-monitor/main/setup/SKILL.md 并按步骤帮我在本机自动安装好这个额度面板插件
```

装好之后，在任意对话右上角点 **`+` → Quota** 就能打开右侧看板。

---

## 为什么做这个插件？（核心优势）

1. **纯走官方公开通道，客户端怎么升级都不容易坏**
   - 顶部的剩余百分比直接调用官方命令行 `agy -p "/usage" --output-format json`（不消耗大模型 Token）；
   - 下方的会话统计只读本地公开的对话日志 `transcript.jsonl`；
   - **不破解客户端私有接口、不装任何 `npm` 第三方依赖包、也不挂钩子拦截你的聊天**。就算断网，也绝不会卡住你正常发消息。
2. **把“哪个对话真正烧钱/吃额度”算清楚了（说大白话）**
   - 本地日志里只记了每一步用了多少 Token，但不同 Token 的真实扣费差距巨大：
     - **命中缓存的旧上下文（Cache）**：非常便宜，大概相当于 **打 1 折（`× 0.1`）**；
     - **没命中缓存的新输入（Input）**：正常计费（**`× 1`**）；
     - **模型的深度思考与回复（Output）**：最贵，大概是新输入的 **4 倍（`× 4`）**。
   - 如果把这三项无脑加在一起，一个“命中了几十万缓存、其实没花多少额度”的对话反而会排第一，误导判断。
   - 所以我们做了一个固定换算：**`折算消耗 = 新输入×1 + 缓存×0.1 + 思考输出×4`**。你可以直接把这个数值当成 **“这个对话大概真实吃掉的工作量/钱”** 来横向对比——谁的条越长，谁就是真正在吃你额度的对话。
   - 同时面板旁边也保留了 **原始总 Token 数** 和 **缓存命中率**，还支持一键切换，并且如果某句话因为隔了太久重聊导致缓存失效重算，会自动标出 **`⚠ 缓存过期重算`** 提醒你。

---

## 手动安装方式（如果你喜欢自己敲命令）

### 1. 装一次官方 `agy` CLI（用于读取顶部云端剩余百分比）

> 如果不装 CLI，下半区的“各会话消耗对比”也能直接用；装上后顶部就能看到 5h / 周额度百分比条。

```powershell
# Windows (PowerShell)
winget install --id Google.AntigravityCLI --accept-source-agreements --accept-package-agreements
```
```bash
# macOS / Linux
curl -fsSL https://antigravity.google/cli/install.sh | sh
```
*(如果你电脑上的 Antigravity 2.0 桌面端已经登录了账号，`agy` 会自动复用登录态；若提示未登录，在终端敲一次 `agy` 登录即可。)*

### 2. 安装本插件

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
*(也可以使用官方 CLI 本地安装：`agy plugin install ./agy-quota-monitor`。)*

---

## 刷新策略（省电不乱刷接口）

- **本地会话消耗**：面板打开时每 2.5 秒看一眼本地日志文件修改时间，没变化就不重读，几乎零开销。
- **云端剩余百分比**：打开面板时查一次；之后每当你聊完一轮新消息、停稳约 3.5 秒后**自动刷新一次**（平时挂着不动每 5 分钟兜底刷一次，关掉面板则完全不请求；右上角也有手动刷新按钮 `↻`）。

---

## 独立网页预览 / 给自建 ACP Web UI 复用

如果你以后用 `agy acp` 写自己的前端界面，也可以直接用 Node.js（v20+）单独跑起数据服务：

```bash
node scripts/dev-server.mjs --port 4790
```
- 浏览器看板：`http://127.0.0.1:4790`
- JSON 接口：`GET http://127.0.0.1:4790/api/status?conversationId=<会话UUID>`

## 开源协议

[MIT](./LICENSE)
