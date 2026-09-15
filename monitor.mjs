#!/usr/bin/env node
/**
 * VPS 补货监控
 *
 * 抓取 Telegram 公开预览页 https://t.me/s/<channel>（服务端渲染，无需登录），
 * 解析每个 SKU 通知的字段，与上一轮快照做「语义比对」，发现变化就弹 Windows 通知。
 *
 * 关键设计（均由实测得出，勿随意改）：
 *  1) 频道用「编辑同一条消息」更新库存，不是每次发新消息 —— 必须按消息 id 做内容 diff，
 *     只盯新消息 id 会漏掉全部补货/售罄。
 *  2) 原始 HTML 每轮都在变（data-view / tme= 一次性 token），绝不能哈希整页，
 *     否则每 60 秒误报一次。只对归一化后的语义字段做指纹。
 *  3) 「监测时间」每轮都变，属于噪声，不进指纹。
 *  4) 售罄消息带「此消息3分钟后删除」，会被频道删掉；那次删除不重复弹通知
 *     （缺货那一刻已经报过），只静默记入台账。
 *  5) 单实例锁必须靠 pid 文件，不能靠命令行文本匹配 —— 父进程/包装进程的命令行里
 *     也可能含有 "monitor.mjs"，会误判成「已在运行」。
 *  6) 抓不到 ≠ 一切正常：必须周期性打心跳，否则无法区分「在跑但无变化」和「进程已死」。
 *  7) 上报地址依赖上游代理；代理不通时自动放宽间隔退避，恢复后继续，并做离线补报。
 *
 * 用法：
 *   node monitor.mjs                常驻循环（写 pid 锁）
 *   node monitor.mjs --status       查看是否在跑 + 快照概况
 *   node monitor.mjs --once         只跑一轮
 *   node monitor.mjs --once --dry   只跑一轮且不写状态、不弹通知（验证解析用）
 *   node monitor.mjs --verbose      打印全部条目
 *   node monitor.mjs --test-notify  测试通知通道
 *   node monitor.mjs --rebuild      重建基线（不通知）
 *   node monitor.mjs --force        忽略已存在的 pid 锁
 */
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { dirname, join, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const flag = (n) => process.argv.includes(`--${n}`);
const ONCE = flag('once');
const DRY = flag('dry');
const VERBOSE = flag('verbose');
const REBUILD = flag('rebuild');

const cfg = JSON.parse(readFileSync(join(ROOT, 'config.json'), 'utf8'));
const at = (rel) => (isAbsolute(rel) ? rel : join(ROOT, rel));
const SNAPSHOT = at(cfg.paths.snapshot);
const LEDGER = at(cfg.paths.ledger);
const LOGFILE = at(cfg.paths.log);
const PIDFILE = at(cfg.paths.pid || 'state/monitor.pid');

for (const d of [dirname(SNAPSHOT), dirname(LEDGER), dirname(LOGFILE), dirname(PIDFILE)]) {
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
}

const stamp = () => new Date().toLocaleString('zh-CN', { hour12: false });
const log = (msg, alsoConsole = true) => {
  const line = `[${stamp()}] ${msg}`;
  try { appendFileSync(LOGFILE, line + '\n'); } catch { /* 日志失败不致命 */ }
  if (alsoConsole) console.log(line);
};

// ---------------------------------------------------------------- 单实例锁

/** 读取 pid 文件并判断该进程是否真的还活着。 */
function daemonPid() {
  if (!existsSync(PIDFILE)) return null;
  const pid = Number.parseInt(readFileSync(PIDFILE, 'utf8').trim(), 10);
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try { process.kill(pid, 0); return pid; } catch { return null; }
}

function acquireLock() {
  const alive = daemonPid();
  if (alive && alive !== process.pid && !flag('force')) {
    console.error(`已有实例在运行 (pid ${alive})；如需强制启动请加 --force`);
    process.exit(1);
  }
  writeFileSync(PIDFILE, String(process.pid));
}

function releaseLock() {
  try {
    if (existsSync(PIDFILE) && readFileSync(PIDFILE, 'utf8').trim() === String(process.pid)) rmSync(PIDFILE);
  } catch { /* 忽略 */ }
}

// ---------------------------------------------------------------- 抓取

async function fetchPreview() {
  const { attempts, backoffMs } = cfg.retry;
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try {
      const res = await fetch(cfg.previewUrl, {
        headers: { 'User-Agent': cfg.userAgent, 'Accept-Language': 'zh-CN,zh;q=0.9', Accept: 'text/html,*/*' },
        signal: AbortSignal.timeout(cfg.requestTimeoutMs),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const html = await res.text();
      if (!html.includes('tgme_widget_message')) throw new Error('页面结构异常（无消息块）');
      return html;
    } catch (e) {
      lastErr = e;
      if (i < attempts) await new Promise((s) => setTimeout(s, backoffMs * i));
    }
  }
  throw lastErr;
}

// ---------------------------------------------------------------- 解析

const entityDecode = (s) => s
  .replace(/<br\s*\/?>/gi, '\n')
  .replace(/<[^>]+>/g, '')
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
  .replace(/&nbsp;/g, ' ')
  .replace(/&amp;/g, '&');

const cleanKey = (s) => s.replace(/[^\p{Script=Han}A-Za-z0-9]/gu, '');

const PERIOD_MONTHS = { 月: 1, 季: 3, 季度: 3, 半年: 6, 年: 12, 周: 7 / 30.44, 天: 1 / 30.44, 日: 1 / 30.44 };

function parsePrice(raw) {
  if (!raw) return {};
  const m = raw.match(/(\d+(?:\.\d+)?)\s*([A-Za-z]{3})?\s*\/\s*([月季半年天日周]+)/)
        || raw.match(/([A-Za-z]{3})?\s*(\d+(?:\.\d+)?)\s*\/\s*([月季半年天日周]+)/);
  if (!m) return { priceRaw: raw };
  const numFirst = /^\d/.test(m[1]);
  const value = parseFloat(numFirst ? m[1] : m[2]);
  const currency = ((numFirst ? m[2] : m[1]) || 'USD').toUpperCase();
  const periodRaw = m[3];
  const period = PERIOD_MONTHS[periodRaw] ?? PERIOD_MONTHS[periodRaw[0]] ?? 1;
  const monthly = value / period;
  const rate = cfg.fx[currency] ?? 1;
  return {
    priceRaw: raw,
    priceValue: value,
    priceCurrency: currency,
    pricePeriod: periodRaw,
    monthlyLocal: +monthly.toFixed(2),
    monthlyUSD: +(monthly * rate).toFixed(2),
  };
}

function parseNotice(text) {
  // 把 "* 字段" 项目符号拆成独立行，避免一行里多个字段互相污染
  const lines = text
    .replace(/\r/g, '')
    .replace(/[ \t]*\*[ \t]+/g, '\n* ')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);

  const kv = {};
  for (const line of lines) {
    const m = line.match(/^\*?\s*([^：:]{1,20})[：:]\s*(.*)$/);
    if (!m) continue;
    const k = cleanKey(m[1]);
    if (k && !(k in kv)) kv[k] = m[2].trim();
  }

  const marker = (text.match(/【([^】]{1,8})】/) || [])[1] || '';
  // 厂商必须锚定在【有货】/【缺货】标记之后：缺货通知写的是「VMISS缺货通知」，
  // 而页脚固定有「更多VPS补货通知请订阅」，不锚定就会把 VPS 当成厂商。
  const vendor = (text.match(/【[^】]{1,8}】\s*([A-Za-z][A-Za-z0-9]*)/) || [])[1]
              || (text.match(/([A-Za-z][A-Za-z0-9]*)\s*(?:补货|缺货)通知/) || [])[1] || '';
  const buyUrl = (text.match(/购买地址[：:]\s*(https?:\/\/\S+)/) || [])[1] || '';
  const price = parsePrice(kv['价格'] || '');

  return {
    marker,
    vendor,
    model: kv['型号'] || '',
    cpu: kv['CPU核'] || '',
    ram: kv['内存'] || '',
    disk: kv['存储'] || '',
    bandwidth: kv['带宽'] || '',
    traffic: kv['流量'] || '',
    region: kv['地区'] || '',
    ipType: kv['ip类型'] || '',
    line: kv['线路'] || '',
    coupon: kv['优惠码'] || '',
    statusText: kv['目前状态'] || '',
    monitorTime: kv['监测时间'] || '',
    alert: kv['提醒'] || '',
    buyUrl,
    ...price,
  };
}

function parsePosts(html) {
  const out = [];
  for (const block of html.split(/<div class="tgme_widget_message[ "]/).slice(1)) {
    const id = (block.match(/data-post="[^/]+\/(\d+)"/) || [])[1];
    if (!id) continue;
    const postedAt = (block.match(/<time[^>]*datetime="([^"]+)"/) || [])[1] || '';
    const tm = block.match(/<div class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/);
    if (!tm) continue; // 服务消息 / 无正文
    const text = entityDecode(tm[1]);
    if (!/型号|目前状态/.test(text)) continue; // 非库存通知（如置顶说明）
    out.push({ id, postedAt, edited: /tgme_widget_message_meta">edited/.test(block), ...parseNotice(text) });
  }
  return out;
}

// ---------------------------------------------------------------- 归类 / 过滤

const OUT_MARKERS = () => cfg.stock?.outOfStockMarkers || ['缺货', '无货', '售罄', '抢光'];
const isOutOfStock = (rec) => OUT_MARKERS().some((t) => `${rec.marker}${rec.statusText}`.includes(t));

function matchCategories(rec) {
  const lineU = (rec.line || '').toUpperCase();
  const hits = [];
  for (const c of cfg.categories || []) {
    if (!c.enabled) continue;
    const m = c.match || {};
    let ok = true;
    if (m.lineRequireAll) ok = ok && m.lineRequireAll.every((t) => lineU.includes(t.toUpperCase()));
    if (m.lineRequireAny) ok = ok && m.lineRequireAny.some((t) => lineU.includes(t.toUpperCase()));
    if (m.maxMonthlyPrice != null) ok = ok && rec.monthlyUSD != null && rec.monthlyUSD <= m.maxMonthlyPrice;
    if (ok) hits.push({ id: c.id, label: c.label });
  }
  return hits;
}

function regionAllowed(rec) {
  const mode = cfg.regions?.mode || 'off';
  if (mode === 'off') return true;
  const hay = `${rec.region} ${rec.model}`.toUpperCase();
  const hit = (cfg.regions.list || []).some((x) => hay.includes(String(x).toUpperCase()));
  return mode === 'allow' ? hit : !hit;
}

/** 语义指纹：只包含「变了就有意义」的字段，排除监测时间等噪声。 */
function fingerprint(rec) {
  const semantic = [rec.marker, rec.vendor, rec.model, rec.region, rec.ipType, rec.line,
                    rec.coupon, rec.priceRaw, rec.statusText, rec.buyUrl];
  return createHash('sha256').update(JSON.stringify(semantic)).digest('hex').slice(0, 16);
}

function project(posts) {
  const map = {};
  for (const r of posts) {
    map[r.id] = { ...r, categories: matchCategories(r), reportable: regionAllowed(r), fp: fingerprint(r) };
  }
  return map;
}

// ---------------------------------------------------------------- 通知

const envOr = (v, name) => (process.env[name] && String(process.env[name]).trim()) || v || '';

function notifyWindows(title, message) {
  const ps1 = join(ROOT, 'notify.ps1');
  if (!existsSync(ps1)) return { channel: 'windows', ok: false, detail: `通知脚本缺失: ${ps1}` };
  try {
    // 用 powershell.exe(5.1) 保证最大兼容，因此 notify.ps1 必须是纯 ASCII 源码
    const child = spawn('powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1,
       '-Title', title, '-Message', message,
       '-LogFile', at(cfg.paths.notifyLog || 'logs/notify.log')],
      { stdio: 'ignore', windowsHide: true });
    child.on('error', (e) => log(`通知进程启动失败: ${e.message}`));
    child.on('exit', (code) => { if (code !== 0) log(`通知脚本退出码 ${code}（详见 logs/notify.log）`); });
    return { channel: 'windows', ok: true, detail: 'spawned' };
  } catch (e) {
    return { channel: 'windows', ok: false, detail: e.message };
  }
}

async function postJson(url, payload, timeoutMs = 15000) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON 响应 */ }
  return { res, json, text };
}

/** WxPusher 极简推送(SPT)：无需注册、无需实名，扫码即得 SPT_xxx；业务码 1000 = 成功。 */
async function notifyWxPusher(title, message) {
  const spt = envOr(cfg.notify.wxpusher?.spt, 'WXPUSHER_SPT');
  if (!spt) return { channel: 'wxpusher', ok: false, detail: 'SPT 未配置（config.notify.wxpusher.spt 或环境变量 WXPUSHER_SPT）' };
  const { res, json, text } = await postJson('https://wxpusher.zjiecode.com/api/send/message/simple-push', {
    content: message, summary: String(title).slice(0, 100), contentType: 1, spt,
  });
  const code = json?.code ?? json?.success;
  const ok = res.ok && (code === 1000 || code === true);
  const msg = (json?.msg || text || '').toString().slice(0, 120);
  return { channel: 'wxpusher', ok, detail: `HTTP ${res.status} code=${JSON.stringify(code)} ${msg}` };
}

/** PushPlus：需实名认证（未实名额度为 0 次/天，返回 905）；成功码 200。 */
async function notifyPushPlus(title, message) {
  const token = envOr(cfg.notify.pushplus?.token, 'PUSHPLUS_TOKEN');
  if (!token) return { channel: 'pushplus', ok: false, detail: 'token 未配置' };
  const { res, json, text } = await postJson('https://www.pushplus.plus/send/', { token, title, content: message });
  const ok = res.ok && json?.code === 200;
  const msg = (json?.msg || text || '').toString().slice(0, 120);
  return { channel: 'pushplus', ok, detail: `HTTP ${res.status} code=${json?.code} ${msg}` };
}

/** ntfy.sh：零账号零凭据，topic 名即密码。 */
async function notifyNtfy(title, message) {
  const topic = envOr(cfg.notify.ntfy?.topic, 'NTFY_TOPIC');
  if (!topic) return { channel: 'ntfy', ok: false, detail: 'topic 未配置' };
  const { res, text } = await postJson('https://ntfy.sh/', { topic, title, message });
  return { channel: 'ntfy', ok: res.ok, detail: `HTTP ${res.status} ${text.slice(0, 80)}` };
}

/** 按配置把一条消息发到所有已启用通道；任一通道失败不影响其它通道。 */
async function notify(title, message) {
  if (DRY) { log(`[dry] 通知跳过: ${title} | ${message.replace(/\n/g, ' / ')}`); return; }
  const fromEnv = process.env.NOTIFY_CHANNELS
    ? process.env.NOTIFY_CHANNELS.split(',').map((s) => s.trim()).filter(Boolean)
    : null;
  const channels = fromEnv || cfg.notify.channels || ['windows'];
  const results = [];
  for (const c of channels) {
    if (c === 'windows' && process.platform !== 'win32') continue; // 云端 Linux 跑时自动跳过
    try {
      if (c === 'windows') results.push(notifyWindows(title, message));
      else if (c === 'wxpusher') results.push(await notifyWxPusher(title, message));
      else if (c === 'pushplus') results.push(await notifyPushPlus(title, message));
      else if (c === 'ntfy') results.push(await notifyNtfy(title, message));
      else results.push({ channel: c, ok: false, detail: '未知通道' });
    } catch (e) {
      results.push({ channel: c, ok: false, detail: `${e.name}: ${e.cause?.code || e.message}` });
    }
  }
  for (const r of results) {
    const line = `notify[${r.channel}] ${r.ok ? 'OK' : 'FAIL'} ${r.detail || ''}`.trim();
    if (!r.ok) log(line); else if (VERBOSE) log(line);
    try { appendFileSync(at(cfg.paths.notifyLog || 'logs/notify.log'), `[${stamp()}] ${line}\n`); } catch { /* 忽略 */ }
  }
}

// ---------------------------------------------------------------- 状态

const loadSnapshot = () => (existsSync(SNAPSHOT) ? JSON.parse(readFileSync(SNAPSHOT, 'utf8')) : null);
const saveSnapshot = (map) => { if (!DRY) writeFileSync(SNAPSHOT, JSON.stringify(map, null, 2), 'utf8'); };
const ledger = (entry) => { if (!DRY) appendFileSync(LEDGER, JSON.stringify(entry) + '\n'); };

function diff(prev, next) {
  const events = [];
  for (const [id, rec] of Object.entries(next)) {
    if (!prev[id]) { events.push({ kind: 'added', id, rec }); continue; }
    if (prev[id].fp !== rec.fp) events.push({ kind: 'changed', id, rec, before: prev[id] });
  }
  for (const [id, rec] of Object.entries(prev)) {
    if (!next[id]) events.push({ kind: 'removed', id, rec });
  }
  return events;
}

const oneLine = (r) => {
  const bits = [r.vendor, r.model, r.line].filter(Boolean).join('·');
  const price = r.priceRaw ? ` · ${r.priceRaw}` : '';
  const m = r.monthlyUSD != null ? ` (月均${r.monthlyUSD}USD)` : '';
  const cat = r.categories?.length ? ` [${r.categories.map((c) => c.label).join('/')}]` : '';
  const note = r.alert ? ` · ${r.alert}` : '';
  return `${bits}${price}${m}${cat}${note}`;
};

function summarize(events) {
  const lines = [];
  for (const e of events) {
    if (e.kind === 'added') {
      lines.push(`【新上架】${oneLine(e.rec)}`);
    } else if (e.kind === 'changed') {
      const b = e.before;
      const tags = [];
      if (b.marker !== e.rec.marker) tags.push(`标记 ${b.marker || '-'}→${e.rec.marker || '-'}`);
      if (b.statusText !== e.rec.statusText) tags.push(`状态 ${b.statusText || '-'}→${e.rec.statusText || '-'}`);
      if (b.priceRaw !== e.rec.priceRaw) tags.push(`价格 ${b.priceRaw}→${e.rec.priceRaw}`);
      if (!tags.length) tags.push('字段更新');
      const alert = e.rec.alert ? ` ⚠️${e.rec.alert}` : '';
      lines.push(`【变化】${tags.join('; ')}${alert} | ${oneLine({ ...e.rec, alert: '' })}`);
    } else {
      lines.push(`【下架/删除】${oneLine(e.rec)}`);
    }
  }
  return lines;
}

// ---------------------------------------------------------------- 单轮

async function runOnce(state, catchupLabel = '') {
  const html = await fetchPreview();
  const posts = parsePosts(html);
  const next = project(posts);

  if (VERBOSE) {
    log(`—— 解析到 ${posts.length} 条库存通知 ——`);
    for (const r of Object.values(next)) {
      log(`  ${r.id} | ${r.reportable ? '在范围' : '范围外'} | ${r.marker} | ${r.statusText} | ${oneLine(r)}`);
    }
  }

  const prev = state.prev;
  if (!prev) {
    saveSnapshot(next);
    state.prev = next;
    const inRange = Object.values(next).filter((r) => r.reportable).length;
    log(`首次运行：已建立基线，共 ${Object.keys(next).length} 条（范围内 ${inRange} 条），不发送通知。`);
    ledger({ ts: new Date().toISOString(), kind: 'baseline', count: Object.keys(next).length, inRange });
    return { ok: true, events: 0 };
  }

  let events = diff(prev, next).filter((e) => e.rec.reportable || (e.before && e.before.reportable));

  // 售罄消息 3 分钟后被频道删除；缺货那一刻已单独报过，这次删除只静默记账
  const suppressed = [];
  if (cfg.suppressRemovalWhenSoldOut) {
    events = events.filter((e) => {
      if (e.kind === 'removed' && isOutOfStock(e.rec)) { suppressed.push(e); return false; }
      return true;
    });
    for (const e of suppressed) {
      ledger({ ts: new Date().toISOString(), kind: 'removed-soldout-silent', id: e.id, line: oneLine(e.rec) });
    }
  }

  if (VERBOSE) log(`本轮变化 ${events.length} 条（已按地区范围过滤${suppressed.length ? `；静默 ${suppressed.length} 条售罄删除` : ''}）`);

  if (events.length) {
    const lines = summarize(events);
    for (const l of lines) ledger({ ts: new Date().toISOString(), kind: 'event', id: null, line: l });
    const max = cfg.notify.maxPerRun || 8;
    const shown = lines.slice(0, max);
    const more = lines.length > max ? `\n…另有 ${lines.length - max} 条` : '';
    const title = `${cfg.notify.titlePrefix}${catchupLabel ? ` · ${catchupLabel}` : ''} · ${lines.length} 条变化`;
    await notify(title, shown.join('\n') + more);
    log(`已通知 ${lines.length} 条：\n    ` + lines.join('\n    '));
  }

  saveSnapshot(next);
  state.prev = next;
  return { ok: true, events: events.length };
}

// ---------------------------------------------------------------- 入口

async function main() {
  if (flag('status')) {
    const pid = daemonPid();
    console.log(pid ? `状态：运行中 (pid ${pid})` : '状态：未运行');
    const snap = loadSnapshot();
    if (snap) {
      const v = Object.values(snap);
      console.log(`快照：${v.length} 条（范围内 ${v.filter((r) => r.reportable).length} 条）`);
      const latest = v.slice().sort((a, b) => Number(b.id) - Number(a.id))[0];
      if (latest) console.log(`最新一条：${latest.id} ${latest.marker} ${latest.vendor} ${latest.model}`);
    } else {
      console.log('快照：无（尚未建立基线）');
    }
    console.log(`日志：${LOGFILE}`);
    return;
  }

  if (flag('test-notify')) {
    await notify(`${cfg.notify.titlePrefix} · 测试`, '通知通道正常 ✅\n这条是测试消息。');
    log('已发送测试通知。');
    return;
  }

  if (REBUILD && existsSync(SNAPSHOT)) {
    const bak = SNAPSHOT + '.bak';
    writeFileSync(bak, readFileSync(SNAPSHOT));
    log(`已备份旧快照 -> ${bak}`);
  }

  const state = { prev: REBUILD ? null : loadSnapshot(), firstCycle: true };
  let failures = 0;
  let cycles = 0;

  log(`监控启动 | pid=${process.pid} | 频道=${cfg.channel} | 间隔=${cfg.intervalSeconds}s | 地区=${cfg.regions.mode}:${(cfg.regions.list || []).join('/')} | 干跑=${DRY}`);

  const cycle = async () => {
    try {
      const r = await runOnce(state, state.firstCycle && state.prev ? '离线期间' : '');
      failures = 0;
      return r;
    } catch (e) {
      failures++;
      const hint = failures >= 2 ? '（常见原因：上游代理未开启 / 网络切换）' : '';
      log(`抓取失败(${failures})${hint}: ${e.name}: ${e.message}`);
      if (failures === (cfg.consecutiveFailureAlert || 5)) {
        await notify(`${cfg.notify.titlePrefix} · 抓取异常`, `已连续 ${failures} 次抓取失败，可能是上游代理没开。\n最近错误: ${e.message}`);
      }
      return { ok: false, events: 0 };
    } finally {
      state.firstCycle = false;
    }
  };

  if (ONCE) { await cycle(); return; }

  if (!DRY) {
    acquireLock();
    const bail = () => { releaseLock(); process.exit(0); };
    process.on('SIGINT', bail);
    process.on('SIGTERM', bail);
    process.on('exit', releaseLock);
  }

  for (;;) {
    const t0 = Date.now();
    await cycle();
    cycles++;

    // 心跳：静默 ≠ 正常。必须周期性留痕，否则无法区分「在跑但无变化」和「进程已死」。
    const hb = cfg.heartbeatCycles || 10;
    if (cycles % hb === 0) {
      const n = state.prev ? Object.keys(state.prev).length : 0;
      const inR = state.prev ? Object.values(state.prev).filter((r) => r.reportable).length : 0;
      log(`心跳：已运行 ${cycles} 轮，共 ${n} 条（范围内 ${inR} 条），连续失败 ${failures} 次`);
    }

    // 上游代理不通时自动放宽间隔，避免无意义地反复失败
    const backoff = failures > 0 ? Math.min(1 + failures, 6) : 1;
    const wait = Math.max(1000, cfg.intervalSeconds * 1000 * backoff - (Date.now() - t0));
    await new Promise((s) => setTimeout(s, wait));
  }
}

main().catch((e) => { log(`致命错误: ${e.stack || e.message}`); process.exit(1); });
