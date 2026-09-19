'use strict';
// ─────────────────────────────────────────────────────────────
// 个股资讯匹配引擎
//   目标：让「这只股票」的资讯页只出现真正与之相关的新闻
//
//   置信度分层（取命中的最高信号）：
//     0.97  上游已标注该证券（东财 7x24 stockList 中带 secid）
//     0.95  个股官方资讯接口挂载 + 标题含证券简称
//     0.92  标题含证券全称
//     0.90  个股官方资讯接口挂载
//     0.85  标题含 6 位证券代码（通过数字边界校验）
//     0.72  标题含公司简称（通过歧义校验）
//     0.52  摘要提及证券全称
//     0.45  摘要提及证券代码
//
//   噪声过滤：统计盘点类文章（百元股数量 / 融资客榜单 / 龙虎榜…）若标题未点名
//   本证券，一律丢弃——这类文章只是把代码列在正文里，属于误命中。
// ─────────────────────────────────────────────────────────────

// 常见行业/组织后缀，用于由全称推导公司简称
const NAME_SUFFIX = [
  '股份有限公司', '有限责任公司', '有限公司', '股份',
  '科技', '集团', '控股', '实业', '电子', '银行', '证券', '保险', '信托', '基金',
  '医药', '生物', '制药', '能源', '材料', '智能', '网络', '信息', '技术', '传媒',
  '食品', '酒业', '国际', '精密', '绿能', '动力', '汽车', '化工', '建设', '地产',
  '重工', '机械', '电气', '环保', '文旅', '农业', '矿业', '钢铁', '水泥', '家居',
  '服饰', '商业', '物流', '健康', '通信', '软件', '数据', '光学', '半导体', '新能源',
];

// 公司类型词：简称后紧跟这类词时，通常是另一家公司（如「平安银行」≠「中国平安」）
const ORG_TYPE_WORDS = ['银行', '证券', '保险', '基金', '信托', '期货', '租赁', '资管', '金控', '控股', '集团', '股份', '科技', '电子', '医药', '生物', '能源', '环保', '传媒', '地产', '汽车'];

// 统计盘点类文章特征：正文罗列大量代码，但并非针对单只个股
const NOISE_PATTERN = [
  /百元股/, /个股数量/, /\d+\s*只(个股|股票|股)/, /涨停股/, /龙虎榜/, /两市/, /沪深.{0,4}\d+\s*家/,
  /破净股/, /新高股/, /融资客/, /主力资金.{0,6}净(流入|流出)/, /榜单/, /排行/, /名单/, /一览/,
  /这些股/, /\d+\s*股.{0,6}(获|受|被|上榜|登榜|涨停|跌停|创)/, /概念股/, /板块(异动|走强|拉升)/,
  /北向资金/, /ETF/, /市值.{0,4}(榜|排名)/, /成交额.{0,4}(榜|排名)/, /振幅/, /换手率.{0,4}榜/,
  /资金.{0,8}(流入|流出)/, /特大单/, /大单净/, /行业资金/, /主力动向/, /机构评级/, /获.{0,2}评级/,
];

// 资讯聚合类：早参 / 头版头条 / 精华摘要，正文会顺带点名大量个股，标题未点名时不算个股资讯
const DIGEST_PATTERN = [
  /早参/, /晚报/, /晨报/, /头版/, /精华/, /内容摘要/, /日报/, /快报/, /早餐/, /必读/,
  /速览/, /速递/, /盘前/, /盘中/, /收盘播报/, /复盘/, /要闻汇总/, /资讯汇总/, /隔夜/,
];

// 行政区 / 国别前缀：贵州茅台 → 茅台，中国平安 → 平安
const NAME_PREFIX = [
  '中国', '贵州', '四川', '云南', '广西', '广东', '浙江', '江苏', '山东', '福建', '安徽',
  '河南', '湖南', '湖北', '河北', '陕西', '山西', '江西', '黑龙江', '吉林', '辽宁', '甘肃',
  '新疆', '内蒙', '宁夏', '青海', '西藏', '海南',
  '深圳', '上海', '北京', '天津', '重庆', '青岛', '厦门', '宁波', '苏州', '无锡', '南京',
  '杭州', '广州', '成都', '武汉', '西安', '长沙', '郑州', '济南', '合肥', '福州', '南昌',
  '昆明', '南宁', '太原', '石家庄', '哈尔滨', '沈阳', '大连', '长春', '佛山', '东莞', '珠海',
  '宁德', '常州', '南通', '温州', '绍兴', '嘉兴', '台州', '泉州', '烟台', '潍坊', '洛阳',
];

// 去掉前缀后若剩余这些通用词，说明切错了（宁德时代 → 时代 显然是错的）
const GENERIC_TAIL = ['时代', '国际', '中国', '集团', '控股', '发展', '产业', '企业', '公司', '中心', '世界', '未来', '世纪', '通用', '联合', '标准', '第一', '新材', '新能源'];

/** 由「贵州茅台」推导出简称「茅台」，由「招商银行」推导出「招商」 */
function deriveShortName(fullName) {
  const name = String(fullName || '').trim();
  if (!name) return '';
  // 规则一：剥离行业 / 组织后缀
  for (const suffix of NAME_SUFFIX) {
    if (name.length > suffix.length + 1 && name.endsWith(suffix)) {
      const head = name.slice(0, -suffix.length);
      if (head.length >= 2) return head;
    }
  }
  // 规则二：剥离行政区 / 国别前缀
  for (const prefix of NAME_PREFIX) {
    if (name.length > prefix.length + 1 && name.startsWith(prefix)) {
      const tail = name.slice(prefix.length);
      if (tail.length >= 2 && !GENERIC_TAIL.includes(tail)) return tail;
    }
  }
  return '';
}

/** 构建个股档案：匹配所需的全部标识 */
function buildProfile(symbol, name) {
  const digits = String(symbol || '').replace(/\D/g, '').slice(-6);
  const fullName = String(name || '').trim();
  const shortName = deriveShortName(fullName);
  const aliases = new Set([fullName, shortName].filter((x) => x && x.length >= 2));
  // 常见写法：「贵州茅台(600519)」中的括号形式已在标题中独立出现代码，无需额外别名
  return {
    symbol: String(symbol || '').toLowerCase(),
    digits,
    name: fullName,
    shortName,
    aliases: [...aliases],
  };
}

/** 数字边界校验：避免 600519 被 12345600519 这类长数字串误命中 */
function containsCode(text, digits) {
  if (!digits) return -1;
  const re = new RegExp(`(?<![0-9])${digits}(?![0-9])`);
  const m = String(text || '').match(re);
  return m ? m.index : -1;
}

function containsText(text, target) {
  if (!target) return -1;
  return String(text || '').indexOf(target);
}

/**
 * 简称歧义校验：简称命中后，检查紧随其后的字符是否构成另一家公司
 * 例：profile=中国平安，标题「平安银行涨 3%」→ 简称「平安」命中但后接「银行」→ 判为歧义
 */
function isAmbiguousShortName(title, profile, hitIndex) {
  if (!profile.shortName) return false;
  const after = String(title || '').slice(hitIndex + profile.shortName.length, hitIndex + profile.shortName.length + 3);
  const before = String(title || '').slice(Math.max(0, hitIndex - 3), hitIndex);
  const context = before + after;
  return ORG_TYPE_WORDS.some((w) => context.includes(w) && !profile.name.includes(w));
}

/**
 * 判断是否为统计盘点类噪声
 * 只认「标题点名」为豁免条件：盘点文章（百元股数量、资金流入榜等）常在正文顺带列出
 * 个股，若摘要提及即可豁免，这类噪声会全部漏进来，因此摘要提及不构成豁免。
 */
function isRoundupNoise(title, profile, snippet = '') {
  const t = String(title || '');
  const namedInTitle = containsText(t, profile.name) >= 0 || containsCode(t, profile.digits) >= 0;
  if (namedInTitle) return false; // 点名了就不算噪声，例如「贵州茅台领涨白酒股」
  const s = String(snippet || '');
  return NOISE_PATTERN.some((re) => re.test(t) || re.test(s));
}

/**
 * 摘要里的代码是否真的指向本股
 * 统计榜单（资金流入榜、两融余额等）常在正文罗列一串代码，
 * 若代码附近没有公司简称，说明只是被顺带列出，应判为不相关。
 */
function isCodeNearName(snippet, profile, idx) {
  const s = String(snippet || '');
  const window = s.slice(Math.max(0, idx - 30), idx + 40);
  if (containsText(window, profile.name) >= 0) return true;
  if (profile.shortName && containsText(window, profile.shortName) >= 0) return true;
  return false;
}

/**
 * 单条资讯与个股的相关度打分
 * @returns {{ score:number, reason:string, level:'high'|'medium'|'low'|'none' }}
 */
function scoreNews(item, profile) {
  const title = String(item?.title || '');
  const snippet = String(item?.snippet || '');
  const symbols = Array.isArray(item?.symbols) ? item.symbols : [];
  const tagged = symbols.some((s) => String(s).toLowerCase() === profile.symbol);
  const official = item?.source === 'em-stock-news';

  // 噪声前置过滤：盘点类且未点名 → 直接判为不相关
  if (isRoundupNoise(title, profile, snippet)) {
    return { score: 0, reason: '统计盘点类内容，未指向本股', level: 'none' };
  }

  const titleNameIdx = containsText(title, profile.name);
  const titleCodeIdx = containsCode(title, profile.digits);
  const bodyNameIdx = Math.max(containsText(snippet, profile.name), -1);
  const bodyCodeIdx = containsCode(snippet, profile.digits);
  const namedInTitle = titleNameIdx >= 0 || titleCodeIdx >= 0;
  const namedInBody = bodyNameIdx >= 0 || bodyCodeIdx >= 0;

  // 信号 1：个股官方资讯接口挂载（按证券代码精准挂载，可信度最高）
  if (official && namedInTitle) return { score: 0.96, reason: '个股官方资讯 · 标题点名', level: 'high' };
  if (official && namedInBody) return { score: 0.9, reason: '个股官方资讯 · 内容提及', level: 'high' };
  if (official) return { score: 0.78, reason: '个股官方资讯 · 行业关联', level: 'medium' };
  // 信号 2：上游（东财 7x24）已标注关联证券
  if (tagged && namedInTitle) return { score: 0.95, reason: '上游标注关联 · 标题点名', level: 'high' };
  if (tagged && namedInBody) return { score: 0.88, reason: '上游标注关联 · 内容提及', level: 'high' };
  if (tagged) return { score: 0.76, reason: '上游标注关联 · 板块相关', level: 'medium' };
  // 信号 3：标题含全称 / 代码
  if (titleNameIdx >= 0) {
    const bonus = titleCodeIdx >= 0 ? 0.03 : 0;
    return { score: Math.min(0.94, 0.9 + bonus), reason: '标题含证券简称', level: 'high' };
  }
  // 信号 5：标题含 6 位代码（已通过数字边界校验）
  if (titleCodeIdx >= 0) return { score: 0.85, reason: '标题含证券代码', level: 'high' };
  // 信号 6：标题含公司简称
  if (profile.shortName) {
    const idx = containsText(title, profile.shortName);
    if (idx >= 0 && !isAmbiguousShortName(title, profile, idx)) {
      return { score: 0.72, reason: '标题含公司简称', level: 'medium' };
    }
  }
  // 信号 7：摘要提及全称（聚合类早参/头版标题未点名时不计入，避免顺带提及被当成个股资讯）
  if (bodyNameIdx >= 0) {
    if (titleNameIdx < 0 && titleCodeIdx < 0 && DIGEST_PATTERN.some((re) => re.test(title))) {
      return { score: 0, reason: '资讯聚合类内容，非本股专属', level: 'none' };
    }
    return { score: 0.55, reason: '摘要提及本股', level: 'low' };
  }
  // 信号 8：摘要提及代码，且代码附近出现公司简称（排除统计榜单纯罗列代码）
  if (bodyCodeIdx >= 0 && isCodeNearName(snippet, profile, bodyCodeIdx)) {
    return { score: 0.5, reason: '摘要提及证券代码', level: 'low' };
  }

  return { score: 0, reason: '未提及本股', level: 'none' };
}

/** 标题相似度：用于跨源去重（同一事件多家媒体报道） */
function titleKey(title) {
  return String(title || '')
    .replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, '')
    .slice(0, 40);
}

/**
 * 从一批资讯中筛选出与个股相关的内容
 * @param {Array} items 多源聚合后的资讯
 * @param {Object} profile buildProfile 产物
 * @param {{ minScore?:number, limit?:number }} opts
 */
function matchForSymbol(items, profile, opts = {}) {
  const minScore = opts.minScore ?? 0.5; // 低于此分视为与本股无关，宁缺毋滥
  const limit = opts.limit ?? 60;
  const seen = new Map();

  for (const raw of items || []) {
    const { score, reason, level } = scoreNews(raw, profile);
    if (score < minScore) continue;
    const key = titleKey(raw.title) || raw.url;
    const prev = seen.get(key);
    const row = { ...raw, matchScore: score, matchReason: reason, matchLevel: level };
    // 同一事件保留置信度更高的那条
    if (!prev || prev.matchScore < score) seen.set(key, row);
  }

  return [...seen.values()]
    .sort((a, b) => b.matchScore - a.matchScore || Date.parse(b.publishedAt) - Date.parse(a.publishedAt))
    .slice(0, limit);
}

/** 从市场要闻中按上游标注直接挑出个股关联（用于批量建立个股→资讯索引） */
function indexBySymbols(items) {
  const index = new Map();
  for (const item of items || []) {
    for (const sym of item.symbols || []) {
      const s = String(sym).toLowerCase();
      if (!index.has(s)) index.set(s, []);
      index.get(s).push(item);
    }
  }
  return index;
}

module.exports = {
  buildProfile,
  deriveShortName,
  scoreNews,
  matchForSymbol,
  isRoundupNoise,
  isAmbiguousShortName,
  containsCode,
  indexBySymbols,
  titleKey,
};
