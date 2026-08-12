#!/usr/bin/env node
/**
 * 持仓数据看板自动更新脚本
 * 每个交易日收盘后运行：
 * 1. 从腾讯行情接口获取所有持仓最新价格
 * 2. 获取历史K线，重算技术指标(MA/MACD/RSI/KDJ/BOLL/ATR/ROC/量比)
 * 3. 自动生成动能评分、买卖点位、状态分类
 * 4. 更新 index.html 并输出
 * 零依赖，使用 Node.js 内置模块
 */
const fs = require('fs');
const path = require('path');
const https = require('https');

const INDEX_PATH = path.join(__dirname, '..', 'index.html');

// ---------- HTTP 工具 ----------
function get(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: 'GET',
      headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://gu.qq.com/' }
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('error', reject);
    req.setTimeout(20000, () => req.destroy(new Error('timeout: ' + url)));
    req.end();
  });
}

// ---------- 代码转换 ----------
function toQtCode(code) {
  const n = code.split('.')[0];
  const m = code.split('.')[1];
  if (m === 'HK') return 'hk' + n.padStart(5, '0');
  if (m === 'SH') return 'sh' + n;
  return 'sz' + n;
}

// ---------- 技术指标 ----------
function maArr(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i++) {
    if (i < n - 1) out.push(null);
    else {
      let s = 0;
      for (let j = i - n + 1; j <= i; j++) s += arr[j];
      out.push(s / n);
    }
  }
  return out;
}

function emaArr(arr, n) {
  const k = 2 / (n + 1);
  let e = arr[0];
  const out = [e];
  for (let i = 1; i < arr.length; i++) {
    e = arr[i] * k + e * (1 - k);
    out.push(e);
  }
  return out;
}

function rsiArr(arr, n) {
  const out = [];
  let avgG = 0, avgL = 0;
  for (let i = 0; i < arr.length; i++) {
    if (i === 0) { out.push(null); continue; }
    const chg = arr[i] - arr[i - 1];
    const g = Math.max(chg, 0), l = Math.max(-chg, 0);
    if (i < n) { avgG += g / n; avgL += l / n; out.push(null); }
    else {
      avgG = (avgG * (n - 1) + g) / n;
      avgL = (avgL * (n - 1) + l) / n;
      out.push(100 - 100 / (1 + avgG / (avgL || 1e-9)));
    }
  }
  return out;
}

function kdjArr(klines, n = 9) {
  const out = [];
  let k = 50, d = 50;
  for (let i = 0; i < klines.length; i++) {
    const seg = klines.slice(Math.max(0, i - n + 1), i + 1);
    const low = Math.min(...seg.map(x => x.low));
    const high = Math.max(...seg.map(x => x.high));
    const rsv = high === low ? 50 : (klines[i].close - low) / (high - low) * 100;
    k = 2 / 3 * k + 1 / 3 * rsv;
    d = 2 / 3 * d + 1 / 3 * k;
    out.push({ k, d, j: 3 * k - 2 * d });
  }
  return out;
}

function bollArr(closes, ma20Arr) {
  return ma20Arr.map((m, i) => {
    if (m == null) return null;
    const slice = closes.slice(i - 19, i + 1);
    const sd = Math.sqrt(slice.reduce((s, v) => s + (v - m) * (v - m), 0) / 20);
    return { up: m + 2 * sd, mid: m, low: m - 2 * sd };
  });
}

function atrArr(klines, n = 14) {
  const out = [null, null];
  for (let i = 1; i < klines.length; i++) {
    const h = klines[i].high, l = klines[i].low, pc = klines[i - 1].close;
    const tr = Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
    if (i < n) out.push(null);
    else if (i === n) {
      let s = 0;
      for (let j = 1; j <= n; j++) {
        const hh = klines[j].high, ll = klines[j].low, pp = klines[j - 1].close;
        s += Math.max(hh - ll, Math.abs(hh - pp), Math.abs(ll - pp));
      }
      out.push(s / n);
    } else {
      out.push((out[i] * (n - 1) + tr) / n);
    }
  }
  return out;
}

const r2 = x => x == null || isNaN(x) ? null : Math.round(x * 100) / 100;

// ---------- 数据获取 ----------
async function fetchQuotes(qtCodes) {
  const url = 'https://qt.gtimg.cn/q=' + qtCodes.join(',');
  const buf = await get(url);
  const text = new TextDecoder('gbk').decode(buf);
  const out = {};
  for (const line of text.split(';')) {
    const m = line.match(/v_([a-z0-9]+)="([^"]*)"/);
    if (!m) continue;
    const f = m[2].split('~');
    out[m[1]] = {
      name: f[1],
      price: parseFloat(f[3]),
      prevClose: parseFloat(f[4]),
      open: parseFloat(f[5]),
      high: parseFloat(f[33]),
      low: parseFloat(f[34]),
      chgPct: parseFloat(f[32]),
      volume: parseFloat(f[6]),
      amount: parseFloat(f[37]),
      turnover: parseFloat(f[38]),
      pe: parseFloat(f[39])
    };
  }
  return out;
}

async function fetchKlines(qtCode) {
  const url = `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${qtCode},day,,,160,qfq`;
  const buf = await get(url);
  const j = JSON.parse(buf.toString('utf8'));
  const d = (j.data && (j.data[qtCode] || {})) || {};
  const rows = d.day || d.qfqday || [];
  return rows.map(r => {
    const p = Array.isArray(r) ? r : r.split(',');
    return { date: p[0], open: +p[1], close: +p[2], high: +p[3], low: +p[4], vol: +p[5] };
  });
}

// ---------- 分析引擎 ----------
function calcIndicators(klines) {
  const closes = klines.map(k => k.close);
  const vols = klines.map(k => k.vol);
  const i = closes.length - 1;
  const ma5 = maArr(closes, 5)[i];
  const ma10 = maArr(closes, 10)[i];
  const ma20 = maArr(closes, 20)[i];
  const ma60 = maArr(closes, 60)[i];
  const ema12 = emaArr(closes, 12), ema26 = emaArr(closes, 26);
  const difArr = ema12.map((v, idx) => v - ema26[idx]);
  const deaArr = emaArr(difArr, 9);
  const dif = difArr[i], dea = deaArr[i];
  const hist = 2 * (dif - dea), prevHist = 2 * (difArr[i - 1] - deaArr[i - 1]);
  const rsi6 = rsiArr(closes, 6)[i], rsi12 = rsiArr(closes, 12)[i], rsi24 = rsiArr(closes, 24)[i];
  const kd = kdjArr(klines)[i];
  const boll = bollArr(closes, maArr(closes, 20))[i];
  const atr = atrArr(klines)[i];
  const vol5 = vols.slice(-6, -1).reduce((s, v) => s + v, 0) / 5;
  const volRatio = vol5 > 0 ? vols[i] / vol5 : null;
  const roc5 = closes[i - 5] ? (closes[i] - closes[i - 5]) / closes[i - 5] * 100 : null;
  const roc10 = closes[i - 10] ? (closes[i] - closes[i - 10]) / closes[i - 10] * 100 : null;
  const roc20 = closes[i - 20] ? (closes[i] - closes[i - 20]) / closes[i - 20] * 100 : null;
  const near20High = Math.max(...closes.slice(-20));
  const near20Low = Math.min(...closes.slice(-20));
  const near60High = Math.max(...closes.slice(-60));
  const near60Low = Math.min(...closes.slice(-60));
  return {
    ma5, ma10, ma20, ma60, dif, dea, hist, prevHist,
    rsi6, rsi12, rsi24, k: kd.k, d: kd.d, j: kd.j,
    bollUp: boll ? boll.up : null, bollMid: boll ? boll.mid : null, bollLow: boll ? boll.low : null,
    atr, volRatio, roc5, roc10, roc20,
    near20High, near20Low, near60High, near60Low
  };
}

function calcMomentum(px, T) {
  let m = 0;
  // 均线结构 0-3
  if (T.ma5 != null && px > T.ma5) m += 0.6;
  if (T.ma5 != null && T.ma10 != null && T.ma5 > T.ma10) m += 0.6;
  if (T.ma10 != null && T.ma20 != null && T.ma10 > T.ma20) m += 0.6;
  if (T.ma20 != null && T.ma60 != null && T.ma20 > T.ma60) m += 0.6;
  if (T.ma20 != null && px > T.ma20) m += 0.6;
  // MACD 0-2
  if (T.dif > T.dea) m += 0.7;
  if (T.hist > 0) m += 0.7;
  if (T.hist > T.prevHist) m += 0.6;
  // RSI 0-2
  if (T.rsi6 != null) {
    if (T.rsi6 >= 55 && T.rsi6 <= 75) m += 1.2;
    else if (T.rsi6 >= 45 && T.rsi6 < 55) m += 0.6;
    else if (T.rsi6 > 75) m += 0.4;
    else if (T.rsi6 < 30) m += 0.3;
  }
  // KDJ 0-1.5
  if (T.j != null) {
    if (T.j < 100 && T.k > T.d) m += 0.7;
    if (T.j >= 50) m += 0.5;
    if (T.j >= 85) m -= 0.3;
  }
  // BOLL 0-1.5
  if (T.bollUp != null) {
    const pos = (px - T.bollLow) / (T.bollUp - T.bollLow);
    if (pos > 0.8) m += 0.8;
    else if (pos > 0.5) m += 0.5;
    else if (pos < 0.2) m += 0.3;
    if (px > T.bollMid) m += 0.5;
  }
  // 量能 0-1
  if (T.volRatio != null) {
    if (T.volRatio > 1.5) m += 0.7;
    else if (T.volRatio > 1.0) m += 0.4;
  }
  if (T.roc5 != null && T.roc5 > 0) m += 0.3;
  return Math.min(10, Math.round(m * 10) / 10);
}

function calcStatus(momentum, px, T) {
  const aboveMa20 = T.ma20 == null || px >= T.ma20 * 0.985;
  const bullMacd = T.hist > 0;
  if (momentum >= 6.5 && aboveMa20 && bullMacd) return '强势持有';
  if (momentum >= 5 && T.ma20 != null && px >= T.ma20 * 0.95 && px <= T.ma20 * 1.05) return '加仓区';
  if (momentum >= 4) return '观望';
  return '反弹乏力-减仓';
}

function calcTrend(px, T) {
  if (T.ma5 != null && T.ma10 != null && T.ma20 != null &&
      px > T.ma5 && T.ma5 > T.ma10 && T.ma10 > T.ma20) return '多头排列';
  if (T.ma5 != null && T.ma10 != null && px > T.ma5 && T.ma5 > T.ma10) return '短线偏多';
  if (T.ma20 != null && T.ma60 != null && px > T.ma20 && T.ma20 > T.ma60) return '中期走强';
  if (T.ma20 != null && px > T.ma20) return '震荡修复';
  if (T.ma20 != null && T.ma60 != null && T.ma20 < T.ma60) return '空头趋势';
  return '弱势整理';
}

function calcLevels(px, momentum, T, sellNote) {
  const lv = { s1: null, s2: null, r1: null, r2: null, buyLow: null, buyHigh: null, addLow: null, addHigh: null, target: null, stop: null, sellNote: sellNote };
  if (momentum >= 5 && (T.ma20 == null || px > T.ma20)) {
    // 偏强：回踩可买
    lv.buyLow = r2(Math.min(T.ma20 != null ? T.ma20 : T.ma10, T.bollLow != null ? T.bollLow : T.ma10));
    lv.buyHigh = r2(T.ma10);
    lv.addLow = lv.buyLow;
    lv.addHigh = lv.buyHigh;
    lv.target = r2(T.bollUp != null ? T.bollUp : T.near20High);
    lv.stop = r2(Math.max((T.ma20 != null ? T.ma20 : T.ma10) * 0.97, T.near20Low * 0.98));
    lv.sellNote = `回踩 ${lv.buyLow}~${lv.buyHigh} 可加仓，反弹至 ${lv.target} 分批止盈`;
  } else {
    // 偏弱：反弹减仓
    lv.target = r2(T.near20High);
    lv.stop = r2(T.near5Low != null ? T.near5Low : T.near20Low * 0.98);
    lv.sellNote = `反弹至 ${lv.target} 减仓`;
  }
  lv.s1 = r2(Math.min(T.ma20 != null ? T.ma20 : T.ma10, T.bollLow != null ? T.bollLow : T.ma10));
  lv.s2 = r2(T.bollLow != null ? T.bollLow : T.near20Low);
  lv.r1 = r2(T.bollUp != null ? T.bollUp : T.near20High);
  lv.r2 = r2(T.ma60 != null ? Math.max(T.ma60, T.near20High) : T.near20High);
  return lv;
}

// ---------- 主流程 ----------
async function main() {
  console.log('== 持仓看板自动更新 ==', new Date().toISOString());
  if (!fs.existsSync(INDEX_PATH)) {
    console.error('未找到 index.html:', INDEX_PATH);
    process.exit(1);
  }
  let html = fs.readFileSync(INDEX_PATH, 'utf8');
  const m = html.match(/<script id="app-data">const DATA = ([\s\S]*?);<\/script>/);
  if (!m) { console.error('未找到 DATA 数据段'); process.exit(1); }
  const DATA = JSON.parse(m[1]);

  const qtCodes = DATA.holdings.map(h => toQtCode(h.code));
  console.log('持仓数:', DATA.holdings.length);

  // 并发获取行情
  const quotes = await fetchQuotes(qtCodes);
  console.log('行情获取完成:', Object.keys(quotes).length, '条');

  // 并发获取K线
  const klineMap = {};
  await Promise.all(qtCodes.map(async code => {
    try {
      klineMap[code] = await fetchKlines(code);
    } catch (e) {
      console.log('K线获取失败:', code, e.message);
      klineMap[code] = null;
    }
  }));

  // 更新每只持仓
  let updated = 0;
  const statusCounts = {};
  DATA.holdings.forEach(h => {
    const qt = toQtCode(h.code);
    const q = quotes[qt];
    const klines = klineMap[qt];
    if (!q || !klines || klines.length < 25) {
      console.log('跳过(数据不足):', h.code, q ? 'ok' : 'noquote', klines ? klines.length : 'nokline');
      statusCounts[h.status] = (statusCounts[h.status] || 0) + 1;
      return;
    }
    // 最新K线日期
    const lastK = klines[klines.length - 1];
    h.px = r2(q.price);
    h.lastPx = r2(q.price);
    h.lastDate = lastK.date;
    h.mv = Math.round(h.shares * h.px);
    h.pl = Math.round(h.shares * (h.px - h.cost));
    h.plPct = Math.round((h.px - h.cost) / h.cost * 1000) / 10;

    // 重算技术指标
    const T = calcIndicators(klines);
    T.near5Low = Math.min(...klines.slice(-5).map(k => k.low));
    h.momentum = calcMomentum(h.px, T);
    h.status = calcStatus(h.momentum, h.px, T);
    h.trend = calcTrend(h.px, T);
    h.lv = calcLevels(h.px, h.momentum, T, h.lv ? h.lv.sellNote : '');

    // 指标字段
    h.ind = {
      ma5: r2(T.ma5), ma10: r2(T.ma10), ma20: r2(T.ma20), ma60: r2(T.ma60),
      dif: +T.dif.toFixed(4), dea: +T.dea.toFixed(4), hist: +T.hist.toFixed(4),
      rsi6: r2(T.rsi6), rsi12: r2(T.rsi12), rsi24: r2(T.rsi24),
      k: r2(T.k), d: r2(T.d), j: r2(T.j),
      bollUp: r2(T.bollUp), bollMid: r2(T.bollMid), bollLow: r2(T.bollLow),
      atr: r2(T.atr), roc5: r2(T.roc5), roc10: r2(T.roc10), roc20: r2(T.roc20),
      volRatio: r2(T.volRatio)
    };

    // 重建历史K线(最近80个交易日, MM-DD格式)
    h.hist = klines.slice(-80).map(k => {
      const p = k.date.split('-');
      return [p[1] + '-' + p[2], k.close];
    });

    statusCounts[h.status] = (statusCounts[h.status] || 0) + 1;
    updated++;
    console.log(`  ✓ ${h.name}: ${h.px} (${h.plPct >= 0 ? '+' : ''}${h.plPct}%) 动能${h.momentum} ${h.status}`);
  });

  // 更新 meta
  const tradeDate = DATA.holdings.map(h => h.lastDate).filter(Boolean).sort().pop() || new Date().toISOString().slice(0, 10);
  DATA.meta.date = tradeDate;
  DATA.meta.totalMv = DATA.holdings.reduce((s, h) => s + h.mv, 0);
  DATA.meta.totalPl = DATA.holdings.reduce((s, h) => s + h.pl, 0);
  DATA.meta.statusCounts = statusCounts;
  DATA.meta.updateTime = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', second:'2-digit' });

  // 写回 HTML
  html = html.replace(/<script id="app-data">const DATA = ([\s\S]*?);<\/script>/,
    `<script id="app-data">const DATA = ${JSON.stringify(DATA)};</script>`);

  // 更新标题/日期
  const [y, mo, dd] = tradeDate.split('-');
  const week = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][new Date(tradeDate + 'T00:00:00').getDay()];
  const oldDate = html.match(/<title>持仓数据看板 · (\d{4}-\d{2}-\d{2})<\/title>/);
  if (oldDate) {
    const od = oldDate[1];
    html = html.split(od).join(tradeDate);
  }
  html = html.replace(/<div class="date">📅 [^<]*<\/div>/, `<div class="date">📅 ${tradeDate}（${week}）收盘</div>`);
  html = html.replace(/<div class="sub">[\s\S]*?<\/div>/, `<div class="sub">基于 ${tradeDate} 收盘持仓 · 每个交易日自动更新 · 数据来源腾讯行情</div>`);

  fs.writeFileSync(INDEX_PATH, html, 'utf8');
  console.log('\n完成! 更新', updated, '只, 交易日期:', tradeDate);
  console.log('组合市值:', (DATA.meta.totalMv / 10000).toFixed(1), '万, 浮盈:', DATA.meta.totalPl);
}

main().catch(e => { console.error('更新失败:', e.message); process.exit(1); });
