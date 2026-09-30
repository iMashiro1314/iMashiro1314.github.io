const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = 8888;
const WORKING_DIR = __dirname + '/';
const HISTORY_FILE = WORKING_DIR + 'history.json';
const CONFIG_FILE = WORKING_DIR + 'config.json';

// ========== 配置加载 ==========
// 可选：在 config.json 中配置 Cookie，可获得更精确的视频列表
// 格式：{ "cookie": "SESSDATA=xxx; bili_jct=xxx; DedeUserID=xxx" }
let config = {};
let configError = '';
try {
  if (fs.existsSync(CONFIG_FILE)) {
    const raw = fs.readFileSync(CONFIG_FILE, 'utf-8');
    config = JSON.parse(raw);
    console.log('[配置] 已找到 config.json');
  } else {
    configError = 'config.json 不存在';
    console.log('[配置] 未找到 config.json（当前目录：' + WORKING_DIR + '）');
  }
} catch (e) {
  configError = 'config.json 解析失败: ' + e.message;
  console.error('[配置] config.json 格式错误:', e.message);
  console.log('[配置] 请确保是标准JSON格式，例如：{"cookie": "SESSDATA=xxx; bili_jct=xxx"}');
}

const COOKIE = (config.cookie || '').trim();
// 判断Cookie是否看起来有效（包含SESSDATA或bili_jct，且不是占位符）
const COOKIE_VALID = COOKIE &&
  !COOKIE.includes('在这里粘贴') &&
  !COOKIE.includes('xxx') &&
  (COOKIE.includes('SESSDATA') || COOKIE.includes('bili_jct') || COOKIE.length > 50);
const HAS_COOKIE = !!COOKIE_VALID;

if (COOKIE && !COOKIE_VALID) {
  console.log('[配置] Cookie 看起来无效（可能是占位符未替换），将使用搜索兜底模式');
  console.log('[配置] Cookie前50字符:', COOKIE.slice(0, 50) + '...');
}

// ========== WBI 签名相关 ==========
const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35,
  27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41,
  13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30,
  4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52
];

let wbiKey = '';
let wbiKeyExpire = 0;

function getWbiKey() {
  return new Promise((resolve, reject) => {
    if (wbiKey && Date.now() < wbiKeyExpire) {
      return resolve(wbiKey);
    }
    httpsGet('https://api.bilibili.com/x/web-interface/nav').then(data => {
      const imgUrl = data.data.wbi_img.img_url;
      const subUrl = data.data.wbi_img.sub_url;
      const imgKey = path.basename(imgUrl, '.png');
      const subKey = path.basename(subUrl, '.png');
      const rawKey = imgKey + subKey;
      wbiKey = MIXIN_KEY_ENC_TAB.map(i => rawKey[i]).join('').slice(0, 32);
      wbiKeyExpire = Date.now() + 3600 * 1000;
      resolve(wbiKey);
    }).catch(reject);
  });
}

function signWbiParams(params) {
  return getWbiKey().then(key => {
    const wts = Math.floor(Date.now() / 1000);
    const allParams = { ...params, wts };
    const sortedKeys = Object.keys(allParams).sort();
    const query = sortedKeys
      .map(k => `${encodeURIComponent(k)}=${encodeURIComponent(allParams[k])}`)
      .join('&');
    const w_rid = crypto.createHash('md5').update(query + key).digest('hex');
    return { ...allParams, w_rid };
  });
}

// ========== HTTP 请求封装 ==========
function httpsGet(url, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'application/json, text/plain, */*',
      'Accept-Language': 'zh-CN,zh;q=0.9',
      ...extraHeaders,
    };
    // 只有当调用方没有显式传入Cookie时，才使用全局config.json的Cookie
    if (!headers['Cookie'] && COOKIE) {
      headers['Cookie'] = COOKIE;
    }
    https.get(url, { headers }, (res) => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          reject(new Error('JSON parse failed: ' + body.slice(0, 200)));
        }
      });
    }).on('error', reject);
  });
}

// ========== 历史数据存储 ==========
function loadHistory() {
  try {
    if (fs.existsSync(HISTORY_FILE)) {
      return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf-8'));
    }
  } catch (e) {
    console.error('加载历史数据失败:', e.message);
  }
  return {};
}

function saveHistory(history) {
  try {
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2), 'utf-8');
  } catch (e) {
    console.error('保存历史数据失败:', e.message);
  }
}

function recordHistory(mid, userInfo, videos) {
  const history = loadHistory();
  if (!history[mid]) {
    history[mid] = { name: '', records: [] };
  }
  history[mid].name = userInfo.name || history[mid].name;
  history[mid].records.push({
    time: Date.now(),
    follower: userInfo.follower || 0,
    videoCount: videos.length,
    totalView: videos.reduce((s, v) => s + (v.stat?.view || 0), 0),
    totalLike: videos.reduce((s, v) => s + (v.stat?.like || 0), 0),
    totalCoin: videos.reduce((s, v) => s + (v.stat?.coin || 0), 0),
    totalFavorite: videos.reduce((s, v) => s + (v.stat?.favorite || 0), 0),
    totalShare: videos.reduce((s, v) => s + (v.stat?.share || 0), 0),
    totalReply: videos.reduce((s, v) => s + (v.stat?.reply || 0), 0),
  });
  if (history[mid].records.length > 500) {
    history[mid].records = history[mid].records.slice(-500);
  }
  saveHistory(history);
}

// ========== API 处理 ==========
async function handleUserInfo(mid, cookie = null) {
  const headers = { 'Referer': 'https://space.bilibili.com/' + mid };
  if (cookie) headers['Cookie'] = cookie;
  const data = await httpsGet(`https://api.bilibili.com/x/web-interface/card?mid=${mid}`, headers);
  if (data.code !== 0) {
    throw new Error(data.message || '获取用户信息失败');
  }
  const result = {
    mid: data.data.card.mid,
    name: data.data.card.name,
    avatar: data.data.card.face.replace(/^http:/, 'https:'),
    fans: data.data.follower,
    following: data.data.card.attention,
    sign: data.data.card.sign,
    level: data.data.card.level_info?.current_level,
    vip: data.data.card.vip?.status === 1,
    totalView: 0,
    totalLikes: 0,
  };
  // 额外获取总播放和总获赞
  try {
    const upstatHeaders = { 'Referer': `https://space.bilibili.com/${mid}` };
    if (cookie) upstatHeaders['Cookie'] = cookie;
    const upstat = await httpsGet(`https://api.bilibili.com/x/space/upstat?mid=${mid}`, upstatHeaders);
    if (upstat.code === 0 && upstat.data) {
      result.totalView = upstat.data.archive?.view || 0;
      result.totalLikes = upstat.data.likes || 0;
    }
  } catch (e) {
    console.log('  获取upstat失败（不影响主流程）:', e.message);
  }
  return result;
}

// 方式一：有 Cookie 时，使用 wbi 签名接口获取精确视频列表
async function handleVideoListWbi(mid, pageSize = 20, days = 0, cookie = null) {
  const cutoff = days > 0 ? Math.floor(Date.now() / 1000) - days * 86400 : 0;
  const allVideos = [];
  const seenBvids = new Set();
  const maxPages = 10; // 最多翻10页，防止无限请求

  for (let pn = 1; pn <= maxPages; pn++) {
    const signed = await signWbiParams({
      mid,
      ps: 30,
      pn,
      order: 'pubdate',
    });
    const query = Object.entries(signed)
      .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
      .join('&');
    const listHeaders = { 'Referer': `https://space.bilibili.com/${mid}/video` };
    if (cookie) listHeaders['Cookie'] = cookie;
    const data = await httpsGet(`https://api.bilibili.com/x/space/wbi/arc/search?${query}`, listHeaders);
    if (data.code !== 0) {
      if (pn === 1) throw new Error(data.message || '获取视频列表失败');
      break;
    }
    const list = data.data.list?.vlist || [];
    if (list.length === 0) break;

    let reachedOld = false;
    for (const v of list) {
      if (seenBvids.has(v.bvid)) continue;
      seenBvids.add(v.bvid);
      // 如果指定了时间范围且视频早于截止时间，停止获取
      if (cutoff > 0 && v.created < cutoff) {
        reachedOld = true;
        break;
      }
      allVideos.push({ bvid: v.bvid, aid: v.aid, created: v.created });
    }
    if (reachedOld || list.length < 30) break;
    await new Promise(r => setTimeout(r, 300));
  }
  console.log(`  Wbi获取到 ${allVideos.length} 个视频（${days > 0 ? '近' + days + '天' : '全部'}）`);
  return allVideos;
}

// 方式二：无 Cookie 时，使用搜索接口获取视频列表（兜底方案）
async function handleVideoListSearch(mid, userName, pageSize = 20) {
  // 搜索多页获取更多候选
  const searchSize = 50;
  const allResults = [];
  const seenBvids = new Set();

  // 尝试搜索第1页和第2页
  for (let page = 1; page <= 2; page++) {
    try {
      const keyword = encodeURIComponent(userName);
      const data = await httpsGet(
        `https://api.bilibili.com/x/web-interface/search/type?search_type=video&keyword=${keyword}&page=${page}&order=pubdate&page_size=${searchSize}`,
        { 'Referer': 'https://search.bilibili.com/' }
      );
      if (data.code !== 0) {
        console.log(`  搜索第${page}页失败:`, data.message);
        break;
      }
      const results = data.data?.result || [];
      for (const v of results) {
        if (v.bvid && !seenBvids.has(v.bvid)) {
          seenBvids.add(v.bvid);
          allResults.push(v);
        }
      }
      // 如果结果不足50条，说明没有下一页了
      if (results.length < searchSize) break;
      await new Promise(r => setTimeout(r, 500));
    } catch (e) {
      console.log(`  搜索第${page}页异常:`, e.message);
      break;
    }
  }

  console.log(`  搜索到 ${allResults.length} 个候选视频`);

  // 先用搜索结果的 mid 初步过滤
  let filtered = allResults.filter(v => String(v.mid) === String(mid));
  console.log(`  mid初步过滤后 ${filtered.length} 个`);

  // 如果过滤后太少，可能是搜索接口mid不准，保留全部候选
  if (filtered.length < pageSize) {
    filtered = allResults;
    console.log(`  mid过滤结果太少，保留全部候选交由视频详情精确过滤`);
  }

  // 限制候选数量（最多取pageSize*2个，避免请求太多详情接口）
  const maxCandidates = Math.min(filtered.length, pageSize * 2);
  return filtered.slice(0, maxCandidates).map(v => ({ bvid: v.bvid, aid: v.aid }));
}

async function handleVideoDetail(bvid) {
  const data = await httpsGet(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`, {
    'Referer': `https://www.bilibili.com/video/${bvid}`,
  });
  if (data.code !== 0) {
    return null;
  }
  return {
    bvid: data.data.bvid,
    aid: data.data.aid,
    title: data.data.title,
    pic: data.data.pic?.replace(/^http:/, 'https:'),
    pubdate: data.data.pubdate,
    duration: data.data.duration,
    desc: data.data.desc,
    ownerMid: String(data.data.owner?.mid || ''),
    ownerName: data.data.owner?.name || '',
    stat: {
      view: data.data.stat.view,
      danmaku: data.data.stat.danmaku,
      reply: data.data.stat.reply,
      favorite: data.data.stat.favorite,
      coin: data.data.stat.coin,
      share: data.data.stat.share,
      like: data.data.stat.like,
    },
  };
}

async function handleVideoDetails(bvids, filterMid = null) {
  const allValid = [];
  const concurrency = 3;
  for (let i = 0; i < bvids.length; i += concurrency) {
    const batch = bvids.slice(i, i + concurrency);
    const batchResults = await Promise.all(
      batch.map(bvid => handleVideoDetail(bvid).catch(() => null))
    );
    allValid.push(...batchResults.filter(Boolean));
    if (i + concurrency < bvids.length) {
      await new Promise(r => setTimeout(r, 500));
    }
  }

  let results = allValid;
  if (filterMid) {
    const matched = allValid.filter(v => v.ownerMid === String(filterMid));
    const unmatched = allValid.filter(v => v.ownerMid !== String(filterMid));
    console.log(`  视频详情精确过滤: 匹配 ${matched.length} 个, 不匹配 ${unmatched.length} 个`);
    // 如果匹配的太少，把不匹配的也带上（匹配的排前面）
    if (matched.length < 5) {
      results = [...matched, ...unmatched];
      console.log(`  匹配结果不足5个，保留全部候选（匹配的优先）`);
    } else {
      results = matched;
    }
  }

  // 按发布时间倒序
  results.sort((a, b) => b.pubdate - a.pubdate);
  return results;
}

// 创作中心视频诊断数据（封标点击率、3秒跳出率、平均播放进度等）
// 创作中心数据缓存（5分钟），按cookie区分避免切换账号后数据错乱
const creatorCacheMap = new Map();

async function handleCreatorStats(size = 30, cookie = null) {
  const effectiveCookie = cookie || COOKIE;
  const debug = { available: false, code: null, message: null, listLen: 0, cached: false };
  if (!effectiveCookie) return { data: {}, debug };
  // 用cookie前80字符作为缓存key，区分不同账号
  const cacheKey = effectiveCookie.slice(0, 80);
  const cached = creatorCacheMap.get(cacheKey);
  if (cached && Date.now() < cached.expire) {
    console.log('  创作中心诊断数据: 命中缓存');
    debug.cached = true;
    debug.available = true;
    debug.listLen = Object.keys(cached.data).length;
    return { data: cached.data, debug };
  }
  try {
    const creatorHeaders = { 'Referer': 'https://member.bilibili.com/' };
    if (effectiveCookie) creatorHeaders['Cookie'] = effectiveCookie;
    const data = await httpsGet(
      `https://member.bilibili.com/x/web/data/archive_diagnose/compare?size=${size}`,
      creatorHeaders
    );
    debug.code = data.code;
    debug.message = data.message;
    if (data.code !== 0 || !data.data?.list) {
      console.log(`  创作中心诊断数据为空或不可用: code=${data.code}, message=${data.message}, hasData=${!!data.data}, hasList=${!!data.data?.list}, listLen=${data.data?.list?.length}`);
      return { data: {}, debug };
    }
    console.log(`  创作中心接口返回: code=${data.code}, list长度=${data.data.list.length}`);
    const map = {};
    for (const item of data.data.list) {
      const bvid = item.bvid || item.archive?.bvid;
      if (bvid) {
        const s = item.stat || {};
        const notReady = s.not_ready_field || [];
        map[bvid] = {
          tmRate: notReady.includes('tm_rate') ? null : (s.tm_star ?? null),
          crashRate: notReady.includes('crash_rate') ? null : (s.crash_rate ?? null),
          fullPlayRatio: notReady.includes('full_play_ratio') ? null : (s.full_play_ratio ?? null),
          avgPlayTime: notReady.includes('avg_play_time') ? null : (s.avg_play_time ?? null),
          activeFansRate: notReady.includes('active_fans_rate') ? null : (s.active_fans_rate ?? null),
          interactRate: notReady.includes('interact_rate') ? null : (s.interact_rate ?? null),
          playTransFanRate: notReady.includes('play_trans_fan_rate') ? null : (s.play_trans_fan_rate ?? null),
        };
      }
    }
    console.log(`  创作中心诊断数据: ${Object.keys(map).length} 条`);
    creatorCacheMap.set(cacheKey, { data: map, expire: Date.now() + 5 * 60 * 1000 });
    debug.available = true;
    debug.listLen = Object.keys(map).length;
    return { data: map, debug };
  } catch (e) {
    console.log('  获取创作中心诊断数据失败（不影响主流程）:', e.message);
    debug.message = e.message;
    return { data: {}, debug };
  }
}

// ========== 静态文件服务 ==========
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.ttf': 'font/ttf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

function serveStatic(req, res) {
  let urlPath = req.url.split('?')[0];
  if (urlPath === '/') urlPath = '/index.html';
  const filePath = path.join(WORKING_DIR, urlPath);
  if (!filePath.startsWith(WORKING_DIR)) {
    res.statusCode = 403;
    res.end('Forbidden');
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.statusCode = 404;
      res.end('Not Found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.statusCode = 200;
    res.setHeader('Content-Type', MIME_TYPES[ext] || 'application/octet-stream');
    res.end(data);
  });
}

// ========== 主服务器 ==========
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = url.pathname;

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Cookie');

  if (req.method === 'OPTIONS') {
    res.statusCode = 200;
    res.end();
    return;
  }

  try {
    // 图片代理：解决B站头像/封面防盗链
    if (pathname === '/proxy/image') {
      const imgUrl = url.searchParams.get('url');
      if (!imgUrl || !/^https?:\/\//.test(imgUrl)) {
        res.statusCode = 400;
        res.end('Bad Request');
        return;
      }
      https.get(imgUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Referer': 'https://www.bilibili.com/',
        }
      }, (imgRes) => {
        res.statusCode = imgRes.statusCode;
        res.setHeader('Content-Type', imgRes.headers['content-type'] || 'image/jpeg');
        imgRes.pipe(res);
      }).on('error', () => {
        res.statusCode = 502;
        res.end('Image fetch failed');
      });
      return;
    }

    // API: 获取UP主完整信息
    if (pathname === '/api/up') {
      const mid = url.searchParams.get('mid');
      const days = parseInt(url.searchParams.get('days')) || 0; // 0=全部
      const maxVideos = parseInt(url.searchParams.get('limit')) || 100;
      if (!mid || !/^\d+$/.test(mid)) {
        res.statusCode = 400;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: '缺少有效的 mid 参数' }));
        return;
      }
      // 优先使用前端传入的Cookie（X-Cookie头），其次用config.json的Cookie
      let reqCookie = (req.headers['x-cookie'] || '').trim();
      // 前端会对Cookie做URL编码，这里需要解码
      if (reqCookie) {
        try { reqCookie = decodeURIComponent(reqCookie); } catch (e) {}
      }
      const effectiveCookie = reqCookie || COOKIE;
      const useCookieMode = !!effectiveCookie;
      const cookieSource = reqCookie ? '前端传入' : (HAS_COOKIE ? 'config.json' : '无');
      if (reqCookie) {
        console.log(`  [调试] 收到前端Cookie: 长度=${reqCookie.length}, 前40字符=${reqCookie.slice(0, 40)}...`);
      }
      console.log(`[${new Date().toLocaleString()}] 获取UP主信息: ${mid} (模式: ${useCookieMode ? 'Cookie精确' : '搜索兜底'}, Cookie来源: ${cookieSource}, 时间范围: ${days > 0 ? '近' + days + '天' : '全部'})`);

      const userInfo = await handleUserInfo(mid, effectiveCookie || null);

      // 获取视频列表
      let videoList = [];
      if (useCookieMode) {
        try {
          videoList = await handleVideoListWbi(mid, maxVideos, days, effectiveCookie || null);
        } catch (e) {
          console.log('Wbi接口失败，降级到搜索模式:', e.message);
          videoList = await handleVideoListSearch(mid, userInfo.name, maxVideos);
        }
      } else {
        videoList = await handleVideoListSearch(mid, userInfo.name, maxVideos);
      }

      const bvids = videoList.map(v => v.bvid);
      console.log(`  获取到 ${bvids.length} 个候选视频，正在获取详情...`);
      let videoDetails = await handleVideoDetails(bvids, mid);

      // 按时间范围过滤（搜索模式下需要在详情获取后过滤）
      if (days > 0) {
        const cutoff = Math.floor(Date.now() / 1000) - days * 86400;
        videoDetails = videoDetails.filter(v => v.pubdate >= cutoff);
      }

      // 限制返回数量
      videoDetails = videoDetails.slice(0, maxVideos);
      console.log(`  最终返回 ${videoDetails.length} 个视频`);
      videoDetails = videoDetails.slice(0, maxVideos);
      console.log(`  过滤后剩余 ${videoDetails.length} 个视频`);

      // 获取创作中心诊断数据并合并（封标点击率、3秒跳出率、平均播放进度等）
      const creatorResult = await handleCreatorStats(Math.max(videoDetails.length, 30), effectiveCookie || null);
      const creatorStats = creatorResult.data;
      const creatorDebug = creatorResult.debug;
      if (Object.keys(creatorStats).length > 0) {
        videoDetails = videoDetails.map(v => ({
          ...v,
          creator: creatorStats[v.bvid] || null,
        }));
      }

      recordHistory(mid, userInfo, videoDetails);

      // 从cookie中提取当前登录账号UID，用于前端提示账号是否匹配
      let cookieUid = null;
      if (effectiveCookie) {
        const uidMatch = effectiveCookie.match(/DedeUserID=(\d+)/);
        if (uidMatch) cookieUid = uidMatch[1];
      }
      // 统计创作中心数据匹配情况
      const creatorMatched = videoDetails.filter(v => v.creator && (v.creator.tmRate != null || v.creator.crashRate != null || v.creator.fullPlayRatio != null)).length;

      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({
        userInfo,
        videos: videoDetails,
        mode: useCookieMode ? 'cookie' : 'search',
        cookieUid,
        cookieSource,
        creatorMatched,
        creatorTotal: videoDetails.length,
        creatorDebug,
      }));
      return;
    }

    // API: 从 zeroroku.com 获取粉丝历史趋势数据
    if (pathname === '/api/zeroroku') {
      const mid = url.searchParams.get('mid');
      if (!mid || !/^\d+$/.test(mid)) {
        res.statusCode = 400;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: '缺少有效的 mid 参数' }));
        return;
      }
      console.log(`[${new Date().toLocaleString()}] 获取zeroroku粉丝趋势: ${mid}`);
      try {
        const data = await httpsGet(`https://zeroroku.com/api/bilibili/author/${mid}/history`, {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Referer': `https://zeroroku.com/bilibili/author/${mid}`,
        });
        const items = data.items || [];
        // 按时间正序排列，只保留需要的字段
        const history = items
          .map(item => ({
            time: item.createdAt,
            fans: item.fans,
            rate1: item.rate1,
            rate7: item.rate7,
          }))
          .sort((a, b) => new Date(a.time) - new Date(b.time));
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify({ total: history.length, history }));
      } catch (e) {
        console.error('zeroroku请求失败:', e.message);
        res.statusCode = 502;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: '获取zeroroku数据失败: ' + e.message }));
      }
      return;
    }

    // API: 获取历史数据
    if (pathname === '/api/history') {
      const mid = url.searchParams.get('mid');
      const history = loadHistory();
      if (mid) {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify(history[mid] || { name: '', records: [] }));
      } else {
        const list = Object.entries(history).map(([mid, data]) => ({
          mid,
          name: data.name,
          lastUpdate: data.records.length ? data.records[data.records.length - 1].time : 0,
          recordCount: data.records.length,
        }));
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify(list));
      }
      return;
    }

    // API: 删除历史数据
    if (pathname === '/api/history/delete') {
      const mid = url.searchParams.get('mid');
      if (mid) {
        const history = loadHistory();
        delete history[mid];
        saveHistory(history);
      }
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ success: true }));
      return;
    }

    serveStatic(req, res);

  } catch (error) {
    console.error('API错误:', error.message);
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ error: error.message }));
  }
});

function getIPAddress() {
  const interfaces = require('os').networkInterfaces();
  for (const devName in interfaces) {
    const iface = interfaces[devName];
    for (let i = 0; i < iface.length; i++) {
      const alias = iface[i];
      if (alias.family === 'IPv4' && alias.address !== '127.0.0.1' && !alias.internal) {
        return alias.address;
      }
    }
  }
  return '127.0.0.1';
}

server.listen(PORT, '0.0.0.0', () => {
  console.log('========================================');
  console.log('  B站UP主数据查看器 已启动');
  console.log('========================================');
  console.log(`  本地访问: http://localhost:${PORT}/`);
  console.log(`  局域网访问: http://${getIPAddress()}:${PORT}/`);
  console.log(`  工作目录: ${WORKING_DIR}`);
  console.log('========================================');
  if (HAS_COOKIE) {
    console.log('  当前模式: Cookie 精确模式 ✅');
    console.log(`  Cookie长度: ${COOKIE.length} 字符`);
  } else {
    console.log('  当前模式: 搜索兜底模式 ⚠️');
    if (configError) console.log(`  配置问题: ${configError}`);
    if (COOKIE && !COOKIE_VALID) console.log('  配置问题: Cookie可能是占位符未替换');
    console.log('  提示: 配置 Cookie 可获得更精确的视频列表');
    console.log('        在项目目录创建 config.json，内容:');
    console.log('        {"cookie": "SESSDATA=xxx; bili_jct=xxx"}');
    console.log('        注意: xxx要替换成真实值，不要留占位符');
  }
  console.log('========================================');
});
