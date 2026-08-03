const express = require('express');
const path = require('path');
const logger = require('./logger');   // 如果你有独立的 logger 模块
const fs = require('fs');

// ========================
// 你的原始工具函数（保留不动）
// ========================
function ipToInt(ip) {
  const parts = ip.split('.').map(Number);
  const a = (parts[0] << 24) >>> 0;
  const b = parts[1] << 16;
  const c = parts[2] << 8;
  const d = parts[3];
  return a + b + c + d;
}

function intToIp(int) {
  return [
    (int >>> 24) & 0xff,
    (int >>> 16) & 0xff,
    (int >>> 8) & 0xff,
    int & 0xff,
  ].join('.');
}

function parseCIDR(cidr) {
  const [ipStr, prefixLengthStr] = cidr.split('/');
  const prefixLength = parseInt(prefixLengthStr, 10);
  const ipInt = ipToInt(ipStr);
  const mask = (0xffffffff << (32 - prefixLength)) >>> 0;
  const start = (ipInt & mask) >>> 0;
  const end = (start | (~mask >>> 0)) >>> 0;
  const count = end - start + 1;
  return { start, end, count, cidr };
}

const chinaIPRanges = (function loadChinaIPRanges() {
  try {
    const filePath = path.join(__dirname, '../data/china_ip_ranges.txt');
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content
      .split('\n')
      .filter((line) => line.trim() && !line.startsWith('#'));

    const arr = [];
    let total = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      const range = parseCIDR(line);
      arr.push(range);
      total += range.count;
    }
    arr.sort((a, b) => b.count - a.count);
    arr.totalCount = total;
    return arr;
  } catch (error) {
    // logger 可能还没初始化，简单输出
    console.error('Failed to load china_ip_ranges.txt:', error.message);
    return { totalCount: 0 };
  }
})();

function getRandomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function generateIPSegment() {
  return getRandomInt(1, 255);
}

function getCookieValue(cookieStr, name) {
  if (!cookieStr) return '';
  const cookies = '; ' + cookieStr;
  const parts = cookies.split('; ' + name + '=');
  if (parts.length === 2) return parts.pop().split(';').shift();
  return '';
}

// 导出工具函数的对象（如果你其他地方用到）
const util = {
  toBoolean(val) {
    if (typeof val === 'boolean') return val;
    if (val === '') return val;
    return val === 'true' || val == '1';
  },

  cookieToJson(cookie) {
    if (!cookie) return {};
    let cookieArr = cookie.split(';');
    let obj = {};
    for (let i = 0, len = cookieArr.length; i < len; i++) {
      let item = cookieArr[i];
      let arr = item.split('=');
      if (arr.length === 2) {
        obj[arr[0].trim()] = arr[1].trim();
      }
    }
    return obj;
  },

  cookieObjToString(cookie) {
    const cookieKeys = Object.keys(cookie);
    const result = [];
    for (let i = 0, len = cookieKeys.length; i < len; i++) {
      const key = cookieKeys[i];
      result[i] = `${encodeURIComponent(key)}=${encodeURIComponent(cookie[key])}`;
    }
    return result.join('; ');
  },

  getRandom(num) {
    var randomValue = Math.random();
    var floorValue = Math.floor(randomValue * 9 + 1);
    var powValue = Math.pow(10, num - 1);
    var randomNum = Math.floor((randomValue + floorValue) * powValue);
    return randomNum;
  },

  generateRandomChineseIP() {
    const total = chinaIPRanges.totalCount || 0;
    if (!total) {
      const fallback = `116.${getRandomInt(25, 94)}.${generateIPSegment()}.${generateIPSegment()}`;
      console.log('Generated Random Chinese IP (fallback):', fallback);
      return fallback;
    }
    let offset = Math.floor(Math.random() * total);
    let chosen = null;
    for (let i = 0; i < chinaIPRanges.length; i++) {
      const seg = chinaIPRanges[i];
      if (offset < seg.count) {
        chosen = seg;
        break;
      }
      offset -= seg.count;
    }
    if (!chosen) chosen = chinaIPRanges[chinaIPRanges.length - 1];
    const segSize = chosen.end - chosen.start + 1;
    const ipInt = chosen.start + Math.floor(Math.random() * segSize);
    const ip = intToIp(ipInt);
    console.log('Generated Random Chinese IP:', ip, 'from CIDR:', chosen.cidr);
    return ip;
  },

  generateChainId(cookie) {
    const version = 'v1';
    const randomNum = Math.floor(Math.random() * 1e6);
    const deviceId = getCookieValue(cookie, 'sDeviceId') || 'unknown-' + randomNum;
    const platform = 'web';
    const action = 'login';
    const timestamp = Date.now();
    return `${version}_${deviceId}_${platform}_${action}_${timestamp}`;
  },

  generateDeviceId() {
    const hexChars = '0123456789ABCDEF';
    const chars = [];
    for (let i = 0; i < 52; i++) {
      const randomIndex = Math.floor(Math.random() * hexChars.length);
      chars.push(hexChars[randomIndex]);
    }
    return chars.join('');
  },
};

// ========================
// Express 应用初始化
// ========================
const app = express();

// ========== SKey 验证中间件（所有路由之前）==========
app.use((req, res, next) => {
  const VALID_KEY = process.env.SKey;

  // 未配置环境变量时放行（方便本地测试）
  if (!VALID_KEY) return next();

  const userKey = req.query.SKey;
  if (userKey === VALID_KEY) return next();

  res.status(403).send('Access Denied: Invalid or missing SKey');
});
// ===================================================

// 静态文件目录（如果你的前端放在 public 下）
app.use(express.static(path.join(__dirname, 'public')));

// 解析请求体（按需）
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ========================
// 你的业务路由（根据你原来的路由自行调整）
// ========================
app.get('/', (req, res) => {
  // 假设主页是一个静态 HTML 文件
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 示例：使用工具函数的路由
app.get('/random-ip', (req, res) => {
  const ip = util.generateRandomChineseIP();
  res.json({ ip });
});

// 其他你原来的路由可以继续添加在这里...
// app.use('/api', require('./routes/api'));

// ========================
// 错误处理
// ========================
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).send('Internal Server Error');
});

// 导出给 Vercel
module.exports = app;
