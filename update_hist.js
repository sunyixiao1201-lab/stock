#!/usr/bin/env node
// update_hist.js - 更新持仓K线历史数据
// 用法: node update_hist.js
// 功能: 拉取所有持仓标的的80天日K线数据,更新index.html中的hist字段

const fs = require('fs');
const https = require('https');
const http = require('http');
const path = require('path');

const HTML_PATH = path.join(__dirname, 'index.html');

// === 数据源接口 ===
function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    mod.get(url, { headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://finance.sina.com.cn' } }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

// 新浪日K线接口 (A股/ETF)
async function fetchSinaKline(symbol, days=80) {
  // symbol格式: sh600519, sz000001, sh588080 等
  const url = `https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/CN_MarketData.getKLineData?symbol=${symbol}&scale=240&ma=no&datalen=${days}`;
  const raw = await fetchJSON(url);
  try {
    // Sina returns JS-style JSON (keys without quotes)
    const data = eval('(' + raw + ')');
    if (!Array.isArray(data)) return [];
    return data.map(d => {
      const dateStr = d.day.slice(5, 10).replace('-', '-'); // "MM-DD"
      return [dateStr, +parseFloat(d.close).toFixed(3)];
    });
  } catch(e) {
    console.error(`  ❌ 解析失败: ${symbol}`, e.message);
    return [];
  }
}

// 港股日K线 (腾讯接口)
async function fetchHKKline(code, days=80) {
  const symbol = 'hk' + code.padStart(5, '0');
  const url = `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${symbol},day,,,${days},qfq`;
  const raw = await fetchJSON(url);
  try {
    const json = JSON.parse(raw);
    const dayData = json.data[symbol].day || json.data[symbol].qfqday || [];
    if (!Array.isArray(dayData) || dayData.length === 0) return [];
    return dayData.map(d => {
      // d = [日期, 开盘, 收盘, 最高, 最低, 成交量]
      const dateStr = d[0].slice(5, 10); // "MM-DD"
      return [dateStr, +parseFloat(d[2]).toFixed(2)]; // d[2] = 收盘价
    });
  } catch(e) {
    console.error(`  ❌ 港股解析失败: ${code}`, e.message);
    return [];
  }
}

// 将股票代码转为新浪格式
function toSinaSymbol(code) {
  const [num, market] = code.split('.');
  if (market === 'HK') return null; // 港股单独处理
  if (market === 'SH') return 'sh' + num;
  if (market === 'SZ') return 'sz' + num;
  return null;
}

// === 主流程 ===
async function main() {
  console.log('📊 开始更新K线历史数据...');
  
  // 读取index.html
  let html = fs.readFileSync(HTML_PATH, 'utf-8');
  const match = html.match(/const DATA = ({.*?});<\/script>/);
  if (!match) { console.error('❌ 未找到DATA'); process.exit(1); }
  
  const data = JSON.parse(match[1]);
  const holdings = data.holdings;
  
  let updated = 0;
  for (const h of holdings) {
    const [num, market] = h.code.split('.');
    let hist = [];
    
    if (market === 'HK') {
      console.log(`  🔄 ${h.name} (${h.code}) - 港股...`);
      hist = await fetchHKKline(num);
    } else {
      const sinaCode = toSinaSymbol(h.code);
      if (!sinaCode) { console.log(`  ⏭️ 跳过: ${h.name}`); continue; }
      console.log(`  🔄 ${h.name} (${h.code}) -> ${sinaCode}`);
      hist = await fetchSinaKline(sinaCode);
    }
    
    if (hist.length > 0) {
      h.hist = hist;
      updated++;
      console.log(`  ✅ ${h.name}: ${hist.length}条`);
    } else {
      console.log(`  ⚠️ ${h.name}: 无数据,保留原有`);
    }
    
    // 控制请求频率
    await new Promise(r => setTimeout(r, 300));
  }
  
  // 更新日期
  const now = new Date();
  const dateStr = now.getFullYear() + '-' + String(now.getMonth()+1).padStart(2,'0') + '-' + String(now.getDate()).padStart(2,'0');
  data.meta.date = dateStr;
  
  // 写回HTML
  const newDataStr = 'const DATA = ' + JSON.stringify(data) + ';</script>';
  html = html.replace(/const DATA = {.*?};<\/script>/, newDataStr);
  fs.writeFileSync(HTML_PATH, html, 'utf-8');
  
  console.log(`\n✅ 完成! 更新了 ${updated}/${holdings.length} 只标的的K线数据`);
  console.log('💡 提示: 运行 git add index.html && git commit -m "更新K线数据" && git push origin master');
}

main().catch(e => { console.error('❌ 脚本出错:', e); process.exit(1); });
