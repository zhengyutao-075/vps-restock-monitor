# VPS 补货监控

监控 Telegram 频道 [@vps_moniter](https://t.me/s/vps_moniter) 的 **VPS 补货/售罄**，一有变化就弹 Windows 桌面通知。

只读公开预览页，**不需要登录 Telegram、不需要代理、不需要任何账号凭据**。

---

## 快速开始

```powershell
# 跑一轮看看（不写状态、不弹通知）
node monitor.mjs --once --dry --verbose

# 测试通知通道
node monitor.mjs --test-notify

# 常驻监控（前台，Ctrl+C 停止）
node monitor.mjs

# 常驻监控（后台隐藏窗口，推荐）
powershell -NoProfile -ExecutionPolicy Bypass -File start.ps1

# 查看是否在跑
node monitor.mjs --status

# 停止
powershell -NoProfile -ExecutionPolicy Bypass -File stop.ps1
```

## 它会通知你什么

每 60 秒抓一次，比对后产出三类事件：

| 事件 | 含义 |
|---|---|
| **【新上架】** | 出现新的消息 id = 新 SKU / 新补货 |
| **【变化】** | 同一条消息被编辑 = `有货→缺货`、`缺货→有货`、价格变动 |
| **【下架/删除】** | 消息从页面消失 = 下架 |

只有**落在你关注范围内**的条目才会通知（见下方地区过滤）。

## 当前生效的筛选策略

- **地区：硬性只要洛杉矶**（`洛杉矶` 或型号含 `US.LA`）→ 东京、圣何塞一律不报。
- **价格：折算成月均后按 USD 比较**，汇率 `1 CAD = 0.72 USD`。
- **三个关注类别（同等通知力度）**：

| 类别 | 判定规则 |
|---|---|
| 三网优化(移动/电信/联通) | 线路同时含 `CN2GIA` + `9929` + `CMIN2` |
| 电信/联通优质线路 | 线路含 `CN2GIA` / `CN2` / `9929` / `4837` 任一 |
| 超低价(月均 <= 10) | 折算月均 ≤ 10 USD |

> 注意：在「只要洛杉矶」的硬性条件下，**目前只有 VMRack 一家是真正的三网优化**；
> VMISS 洛杉矶各型号都是单线（`9929` / `CMIN2` / `CN2GIA`），所以通常只会命中「电信/联通」或「超低价」。
> 你要的「移动」优质线路（`CMIN2`）目前没有单独类别，如需可加。

---

## config.json 配置说明

改完直接生效（下一轮轮询读取），**不需要重启**？—— 不，配置是启动时读取的，改完请重启监控。

| 字段 | 说明 |
|---|---|
| `intervalSeconds` | 轮询间隔，默认 60 |
| `regions.mode` | `allow`（白名单）/ `deny`（黑名单）/ `off`（不限地区） |
| `regions.list` | 关键词，匹配「地区」字段或「型号」，大小写不敏感 |
| `fx` | 币种→USD 汇率，用于统一比价 |
| `categories[].match.lineRequireAll` | 线路必须**全部**包含这些关键字 |
| `categories[].match.lineRequireAny` | 线路包含**任一**即可 |
| `categories[].match.maxMonthlyPrice` | 折算月均上限（USD） |
| `categories[].enabled` | 关掉某个类别 |
| `suppressRemovalWhenSoldOut` | 售罄消息被删时**不再**重复弹通知（默认开） |
| `stock.outOfStockMarkers` | 判定「缺货」的关键字，默认 `缺货/无货/售罄/抢光` |
| `notify.maxPerRun` | 单次通知最多列几条，超出折叠 |
| `notify.titlePrefix` | 通知标题前缀 |

## 文件说明

| 文件 | 作用 |
|---|---|
| `monitor.mjs` | 主程序：抓取 → 解析 → 比对 → 通知 → 记账 |
| `notify.ps1` | Windows 桌面通知（WinRT Toast，失败自动回退托盘气泡） |
| `config.json` | 全部策略配置 |
| `start.ps1` | 后台隐藏启动 |
| `state/snapshot.json` | 上一轮快照（比对基准） |
| `state/ledger.jsonl` | **只增台账**：所有历史事件，频道删了它还在 |
| `logs/monitor.log` | 运行日志 |
| `logs/notify.log` | 每次通知的结果（`toast-shown` / `balloon-shown` / 失败原因） |

---

## 为什么这样设计（实测结论，改动前务必先读）

1. **频道用「编辑同一条消息」更新库存，不是发新消息。**
   12 条通知全部带 `edited` 标记；正文里的「监测时间」比消息发布时间晚一个月。
   → 所以**只盯新消息 id 会漏掉全部补货/售罄**，必须做内容 diff。

2. **绝对不能哈希整个 HTML。**
   实测连续 12 次轮询，原始 HTML 哈希**每次都变**，但语义字段完全稳定。
   真正变化的是两个一次性 token：`data-view` 尾部的会话哈希、下载链接里的 `tme=`。
   → 所以只对**归一化后的语义字段**取指纹，否则会每 60 秒误报一次。

3. **「监测时间」每轮都变**，属于噪声，已排除在指纹之外。

4. **售罄消息 3 分钟后会被频道删除**（正文原文：`此消息3分钟后删除`）。
   → 所以 `state/ledger.jsonl` 这份本地台账是**唯一的历史记录**，很有价值。
   → 删除那一次不重复弹通知（缺货那一刻已经报过）。

5. **页面无 CDN 缓存**（`cache-control: no-store`），每次都是实时数据。

6. **`notify.ps1` 必须是纯 ASCII 源码。**
   Windows PowerShell 5.1 读取无 BOM 的 `.ps1` 时按 ANSI 码页解码，
   源码里的中文会**破坏语法**导致通知静默失败。通知正文里的中文没问题
   （作为命令行参数以 UTF-16 传入，不走源码字节）。

## 排查

| 现象 | 处理 |
|---|---|
| 完全收不到通知 | 先跑 `node monitor.mjs --test-notify`，再看 `logs/notify.log`。若显示 `toast-shown` 但你没看到，检查 Windows「设置 → 系统 → 通知」是否关闭、是否开了「专注助手」 |
| 想确认解析是否正确 | `node monitor.mjs --once --dry --verbose` |
| 连续抓取失败 | 看 `logs/monitor.log`；Telegram 预览页在国内偶尔会抖，程序自带 3 次重试+退避，连续 5 次失败会弹告警 |
| 基线不对 / 想重来 | `node monitor.mjs --rebuild`（会备份旧快照）后重启 |
| 停止后台监控 | `powershell -NoProfile -ExecutionPolicy Bypass -File stop.ps1` |
| 怀疑进程死了 | `node monitor.mjs --status`；或看 `state/snapshot.json` 的修改时间是否在 60 秒内（每轮都会重写） |
| 代理没开 / 网断了 | 日志会出现「抓取失败(n)（常见原因：上游代理未开启）」并自动放大间隔退避；恢复后自动继续并补报 |
| 分不清「在跑没变化」还是「死了」 | 每 10 轮会写一行心跳到 `logs/monitor.log` |

## 已知未知（跑几天后才能确定，程序不硬编码）

- 目前只见过 `有货` 和 `缺货` 两种标记，其它表述（如 `售罄`）出现时会自动按 `stock.outOfStockMarkers` 处理。
- 「补货」究竟表现为**新消息 id**还是**旧消息由缺货编辑回有货**，两种都已覆盖，但比例需观察。

## 运行前提（重要）

监控是**本机 Windows 进程**，通知走 **Windows 桌面通知**，因此：

- **电脑关机 = 没有进程 = 不会监控，也不会播报。**
- **上游代理没开 = 抓不到 t.me。** 程序会自动退避、不刷屏，恢复后继续。

频道实测**售罄消息 3 分钟后即被删除**，页面只保留当前看板。所以关机期间的
「上架 → 卖光 → 删除」记录**永久丢失、事后无法补回**。

重启后能补报的，只是「发生了变化、但此刻仍在页面上」的条目 ——
这些通知标题里会带「离线期间」字样。

> 要真正 7×24 不漏，必须把监控放到常开设备上。`monitor.mjs` 本身零依赖，
> 只需把通知通道换成不依赖 PC 的（如 Telegram Bot），代码改动很小，
> 主要工作量在部署。注意：**被墙的那台 VPS 当代理没用，但当监控机完全可用** ——
> 监控只需出网（从美国访问 t.me 毫无问题），不需要被中国访问。

## 边界

本工具**只做只读监控与本地通知**：不抢购、不自动下单、不绕过任何验证、不登录你的 Telegram 账号。
