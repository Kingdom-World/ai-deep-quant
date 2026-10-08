// ─────────────────────────────────────────────────────────────
// 知识库出处解析与校验（Phase 2.5 主线 · #71）
//
//   🔴 为什么要做这件事（独立审查抽验发现 **31% 出处错误率**）：
//   本平台的核心承诺是「每条结论都能追到出处」。但出处只是一个**自由文本字符串**，
//   它无法被机器核查 —— 于是「看起来有出处」和「出处是对的」被混为一谈。
//   上一轮已实测到：Salomon(1987) 那条**检索为零且时间上不可能**（7 月期刊不可能
//   报道 10 月的崩盘）。这类错误人眼很难发现，因为**格式是对的**（作者+年份+期刊+卷期）。
//
//   ── 三条设计裁定（都是"看起来多此一举"但必要的）──
//
//   ① 🔴 **结构化从自由文本派生，不另存一份**（`parseSource` 纯函数）
//      另一种做法是把结构化字段写进 JSON、与 source 并存。**不要那样做**：
//      两份表示必然会分叉（改了出处忘了改 DOI，或反之），
//      而"哪个是真的"将无法判定 —— 这违背本项目的口径单一源纪律。
//      派生保证：同一份文本永远解析出同一个结果，不一致无处藏。
//
//   ② 🔴 **本模块零 IO、零网络**（纯函数，可测）
//      联网校验放在 `tools/verify-sources.cjs`（离线工具，不进服务端）。
//      理由有两条，都不是洁癖：
//        · 服务端在 Vercel Serverless 上，出网不稳定（东财已被 502 拒），
//          把"查文献"放在请求路径上会把外部抖动变成用户可见的故障；
//        · 更要紧的是**发布门必须离线可判**：一条出处能不能发布，
//          不该取决于"此刻 Crossref 是否可达"。
//
//   ③ 校验结果是**快照**（`data/` 或本地报告），不是内容的真相来源。
//      Crossref 明天可能改数据；我们的条目不该因为它变了就"自动变对/变错"。
//      快照记录"何时、用哪个 DOI、得到什么"，可复核、可重跑。
// ─────────────────────────────────────────────────────────────

/**
 * 出处引用的类型。
 * 🔴 为什么要分类：不同类型的**可核查方式完全不同** ——
 * 期刊论文有 DOI 可比对卷期页（最强）；书籍只有 ISBN/出版社（弱，Crossref 常不收录）；
 * 教材章节根本没有独立标识（只能核到书名+版本）；
 * 政府公告只有机构+日期（只能核存在性）。
 * 不分类就会用同一把尺子量所有东西，然后对"教材章节"误报一堆假红。
 */
const REF_KINDS = {
  journal: '期刊论文',
  book: '专著',
  chapter: '教材章节',
  report: '报告/工作论文',
  web: '网页/公告',
};

/**
 * 单条出处的结构化形态。字段全部**可选** —— 自由文本能提供多少就给多少，
 * 缺的就是缺，不臆造（臆造会让人误以为核查过了）。
 * @typedef {Object} SourceRef
 * @property {string} raw      该条出处的原始文本（永不为空，解析失败时原样保留）
 * @property {string} kind      REF_KINDS 的键
 * @property {boolean} parsed   是否成功结构化（false ⇒ 只能核存在性）
 * @property {string[]} authors 姓（含 "&"/"," 分隔的作者串）
 * @property {number|null} year
 * @property {string} title     条目标题（不含期刊名）
 * @property {string} container 期刊名 / 书名 / 报告系列
 * @property {string} volume
 * @property {string} issue
 * @property {string} pages
 * @property {string} publisher
 * @property {string} doi
 * @property {string} isbn
 * @property {string} url
 * @property {string} note      原文里的补充说明（如"相关机制分析见 …"）
 */

/** 归一化：去多余空白、全角转半角、统一标点宽度（中文源里有全角括号） */
function norm(s) {
  return String(s || '')
    .replace(/　/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 拆多条出处：分号/中文分号切分（条目里常见「…；另见 …」） */
function splitRefs(text) {
  // 🔴 不能无条件在分号处切（2026-10-08 审查发现并复现）：
  //   中文括号内的分号是**同一句的补充说明**，不是引用分隔符。
  //   实证：`Campbell (2011). T.（查无此文；同刊亦无）` 被切成
  //   `…（查无此文` + `同刊亦无）` 两段 ⇒ **括号标注被割裂成假引用**
  //   （真实条目 case-2022-rate-hike 因此多出一段无 title 的 report）。
  //   这类错误会污染下游（核验工具把半截括号当引用去查）。
  //   ⇒ 只在**括号深度为 0** 时切分。
  const s = norm(text);
  const parts = [];
  let buf = '';
  let depth = 0;
  for (const ch of s) {
    if (ch === '（' || ch === '(' || ch === '【' || ch === '《') depth++;
    else if (ch === '）' || ch === ')' || ch === '】' || ch === '》') depth = Math.max(0, depth - 1);
    if ((ch === ';' || ch === '；') && depth === 0) {
      parts.push(buf);
      buf = '';
      continue;
    }
    buf += ch;
  }
  parts.push(buf);
  return parts.map(norm).filter(Boolean);
}

/**
 * 从作者串提取姓氏。
 * "Jegadeesh, N. & Titman, S." → ['Jegadeesh','Titman']
 * "Fama, E. F. & French, K. R." → ['Fama','French']
 *
 * 🔴 两处容易写错的地方（实测踩过）：
 *   ① **首字母缩写不是姓**。按逗号裸切会得到 ['Fama','E. F.','French','K. R.'] ——
 *      那些是名字的首字母。判据：整段是「大写字母 + 点 + 可选空格」⇒ 缩写，跳过。
 *   ② **复姓/前缀要留住**："López de Prado"、"Van Buren" 是一个姓，不能只取首词。
 */
function parseAuthors(s) {
  const t = norm(s);
  if (!t) return [];
  // 去掉结尾的年份括号 " (2018)" 与后续正文（作者段之后是标题）
  const cleaned = t
    // 🔴 先剥掉**中文标签前缀**（2026-10-08 审查发现：真实库 49 处受影响）：
    //   出处里常写「论文：Fama, E. F. (1970)…」「原始论文：Newey…」——
    //   标签会被当成作者名的一部分（实测得到 authors=[\"论文：Fama\"]）。
    //   ⇒ 作者段**必须**以拉丁大写字母开头，故先把标签剥掉再解析。
    .replace(/^[\u4e00-\u9fff\s]*(论文|教材|原始论文|研究|方法|口径|官方|参考|文献|来源|依据)?\s*[：:]\s*/, '')
    .replace(/\s*\(\d{4}[a-z]?\)\s*$/, '')
    .trim();
  if (!cleaned) return [];
  return cleaned
    .split(/\s*&\s*|\s+and\s+|,\s*/)
    .map((x) => norm(x).replace(/,$/, ''))
    .filter(Boolean)
    // 跳过纯首字母缩写："E. F." / "Y." / "K.R."
    .filter((part) => !/^[A-Z](\.\s*[A-Z])?\.?$/.test(part))
    .map((part) => {
      // "López de Prado, M." → "López de Prado"；"Van Buren, J." → "Van Buren"
      // 规则：取"逗号前、且不含句点"的最长片段（作者姓名里不会有句点，首字母才有）。
      const head = part.split(',')[0].trim();
      const target = /[.。]/.test(head) ? part.split(/[.。]/)[0].trim() : head;
      const m = target.match(/^([A-ZÀ-Þ][\p{L}'’\-]+(?:\s+(?:de|del|van|von|der|la|le|da|dos|di)\s+[\p{L}'’\-]+|\s+[A-ZÀ-Þ][\p{L}'’\-]+)*)/u);
      // 🔴 匹配失败时**返回空**而不是 target —— 返回 target 会把中文前缀
      //    当作者名放出去（比"没解析出作者"更糟：假数据会进核验流程）
      return m ? norm(m[1]) : '';
    })
    .filter(Boolean);
}

/** 判定引用类型 */
function detectKind(t) {
  if (/\b(Working Paper|NBER|RFC|Technical Report)\b/i.test(t) || /工作论文/.test(t)) return 'report';
  if (/\b(ISBN)\b/i.test(t)) return 'book';
  // 教材章节：出现「第 N 章 / Chapter N」且同段有出版社
  if (/第\s*\d+\s*章|Chapter\s*\d+|Ch\.\s*\d+/i.test(t)) return 'chapter';
  // 🔴 期刊刊名匹配的三条实测教训（都导致真期刊论文被判成 report、
  //    进而被 DOI 补全流程**跳过**——是"漏"而不是"错"，更难发现）：
  //   ① **尾 `\b` 会漏掉派生词**：`econometric\b` 匹配不上 `Econometrica`
  //      （后随 `a` 仍是词字符，词边界不成立）；`science\b` 漏掉 `Sciences`。
  //      ⇒ 词表项一律**不加尾 `\b`**，用词首前缀匹配。
  //   ② **缩写刊名不在词表里**：`JRSS-B`（Journal of the Royal Statistical
  //      Society B）是标准缩写，词表无 `journal` 故漏判。
  //      ⇒ 显式收录常见缩写。
  //   ③ 词表再加若干本领域常见刊名首词（econometrica / biometrica / ssrn 等）。
  // 🔴 出版社信号（2026-10-08 审查修正，两次都踩过）：
  //   ① 必须**先于**期刊词表判 —— 否则 `Active Portfolio Management` 的
  //      `management` 命中期刊词表，把**书**判成期刊（书被判成期刊 =
  //      给书伪造 DOI 的入口）。
  //   ② 但**不能无条件抢先** —— 期刊名里常出现 `Wiley`/`Elsevier`：
  //      `… Journal of Finance. 数据见 Wiley Online Library` 会被误判成书
  //      （实测复现）。
  //   ⇒ 正确做法：**期刊形态优先，但要求"刊名 + 卷期页"同时出现**；
  //      仅凭刊名词就判期刊时，才让出版社信号参与（书的书名通常无卷期页）。
  const JOURNALS = 'journal|review|quarterly|economics|finance|science|reports|annals|notices|'
    + 'econometric|biometric|statistic|psychometr|banking|financial|'
    + 'jrss|jf|jfe|rfs|aer|qje|jpe|ssrn|risk|portfolio|forecast|management';
  // ① 期刊最强形态：刊名 + （20 字符内）卷期括号 ⇒ 直接判期刊，出版社信号不参与
  if (new RegExp(`(${JOURNALS})[^.;]{0,40},?\\s*\\d+\\s*\\(`, 'i').test(t)) return 'journal';
  // ② 出版社信号（含 Random House/Princeton 等商业社 + Wiley/McGraw-Hill 等学术社）
  const PUBLISHERS = ['Press', 'Publishing', 'Publishers?', 'McGraw-?Hill', 'Springer',
    'Pearson', 'Random House', 'Princeton', 'Harvard Business', 'MIT Press',
    'Oxford University Press', 'Cambridge University', 'John Wiley', 'FT Press',
    'Penguin', 'Harper', 'Simon & Schuster', '出版社'];
  if (new RegExp(`\\b(${PUBLISHERS.join('|')})`, 'i').test(t) && !/\bWorking Paper\b/i.test(t)) return 'book';
  // ③ 仅凭刊名词（无卷期页）⇒ 也判期刊（放行 `Wiley Online Library` 这类）
  if (new RegExp(`\\b(${JOURNALS})`, 'i').test(t)) return 'journal';
  if (/\b(Wiley|Elsevier|Springer|Pearson)\b/i.test(t)) return 'book';
  if (/^https?:\/\//.test(t)) return 'web';
  return 'report';
}

/**
 * 解析单条出处的自由文本。
 * 🔴 解析失败**不抛异常**，返回 `parsed:false` + 原文：
 *   出处解析是"锦上添花"，不该因为一条写歪了而让整个知识库加载失败
 *   （与 readAll 的容错口径一致）。
 * @param {string} text 单条出处的文本
 * @returns {SourceRef}
 */
function parseRef(text) {
  const raw = norm(text);
  const ref = {
    raw,
    kind: detectKind(raw),
    parsed: true,
    authors: [],
    year: null,
    title: '',
    container: '',
    volume: '',
    issue: '',
    pages: '',
    publisher: '',
    doi: '',
    isbn: '',
    url: '',
    note: '',
  };

  // DOI：`10.XXXX/suffix`
  // 🔴 两条实测教训（都导致 DOI 字段对不上 Crossref，校验成谎话）：
  //   ① 不能吃到中文："…tb04702.x。中国市场对照：…" ⇒ 必须限定 ASCII 字符类。
  //   ② 不能把 DOI 里**合法的圆括号**截断："10.1016/0304-405X(93)90023-5"
  //      去掉尾部 ". " 之后紧跟中文时，粗略的 `[（(].*$` 会从括号处砍掉后半截。
  //      ⇒ 只在**中文/全角括号**处截断，ASCII 圆括号保留。
  const doiM = raw.match(/(10\.\d{4,9}\/[A-Za-z0-9._;()\-/:]+)/);
  if (doiM) {
    ref.doi = doiM[1]
      .replace(/[.,;。：:；]+$/, '')   // 句末标点
      .replace(/[（【].*$/, '')        // 全角括号及其后（中文说明）
      .trim();
  }

  // ISBN
  const isbnM = raw.match(/ISBN\s*([0-9\-Xx]{10,17})/i);
  if (isbnM) ref.isbn = isbnM[1];

  // URL（排除 DOI 形式）
  const urlM = raw.match(/(https?:\/\/[^\s,;，；]+)/);
  if (urlM) ref.url = urlM[1].replace(/[.,;。]$/, '');

  // 年份：优先带括号的，其次 4 位裸年
  const yearM =
    raw.match(/\((\d{4})[a-z]?\)/) ||
    raw.match(/\b(19|20)\d{2}\b/g) ||
    raw.match(/\b(19|20)\d{2}\b/);
  if (yearM) {
    const y = raw.match(/(?:\(|,|\s)((?:19|20)\d{2})[a-z]?(?:\)|,|\s)/);
    if (y) ref.year = Number(y[1]);
  }

  // 作者 + 标题：形如 `Jegadeesh, N. & Titman, S. (1993). Title. Journal, 48(1), 65-91.`
  const head = raw.match(/^(.+?)\s*\(((?:19|20)\d{2})[a-z]?\)\.?\s*(.+)$/);
  let afterTitle = '';
  if (head) {
    ref.authors = parseAuthors(head[1]);
    const rest = head[3];
    // 🔴 必须按**切分点**定位"标题之后"，不能用 `raw.indexOf(title)`：
    //   title 是 rest 的**截断切片**（下面会 slice(0,300)），字符串不在 raw 里，
    //   indexOf 返回 -1 ⇒ 加偏移后得到空串 ⇒ container 恒为空（实测踩过）。
    //   正确做法：title 取 rest 的**第一个完整句**（到 ". " + 大写 为止），
    //   该子串在 rest 中真实存在，偏移量可精确算出。
    const cut = rest.search(/\.\s+[A-Z]/);
    const fullTitle = cut >= 0 ? rest.slice(0, cut) : rest.slice(0, 300);
    const titleEndInRaw = raw.indexOf(fullTitle) + fullTitle.length;
    afterTitle = titleEndInRaw > 0 ? raw.slice(titleEndInRaw) : rest.slice(fullTitle.length);
    ref.title = norm(fullTitle).replace(/[,;]\s*$/, '').slice(0, 300);
  } else {
    // 🔴 本知识库里另有两类**没有「作者(年)」骨架**的出处（实测占多数引用），
    //   实测统计：把它们判成 parsed:false 会让结构化率只有 43%，形同放弃。
    //   ⚠️ 这里**不写死条数** —— 数字会随条目增删腐坏（曾写"122 条"而实际已 127），
    //   而注释里的过期数字比没有数字更糟（读者会以为是当前事实）。
    //   需要具体数字就现场跑 tools/verify-sources.cjs。
    //   它们各有固定形态，**显式识别比一律判失败更有用**：
    //
    //   ① 教材章节：`教材：Grinold & Kahn《Active Portfolio Management》第 7 章`
    //      —— 书名在《》里，章节号在"第 N 章"。可核到"这本书的第 7 章存在吗"。
    //   ② 带前缀的说明：`方法讨论：…` / `工程实现：本项目 server/xxx.cjs（…）`
    //      —— 前缀说明的是**这条出处的性质**（教材/方法讨论/工程实现/官方依据），
    //         不是书名。这类无法结构化，但**性质本身是可核查信息**，须留在 note 里。
    const chapterM = raw.match(/《([^》]{3,120})》\s*(?:第\s*([0-9]+(?:[-–][0-9]+)?)\s*章)?/);
    if (chapterM) {
      ref.kind = 'chapter';
      ref.container = norm(chapterM[1]); // 书名
      if (chapterM[2]) ref.pages = `第${chapterM[2]}章`;
      const preM = raw.match(/^([^：:]{2,12})[：:]/);
      if (preM) ref.authors = parseAuthors(preM[1]);
      ref.parsed = true; // 至少能核到书名 + 章节号
      ref.note = norm(raw.slice(0, chapterM.index + chapterM[0].length));
      return ref;
    }

    const prefixM = raw.match(/^([^：:]{2,12})[：:]\s*(.+)$/);
    if (prefixM) {
      ref.note = norm(prefixM[1]); // 「教材」「方法讨论」「工程实现」「官方依据」
      ref.title = norm(prefixM[2]).slice(0, 200);
      // 这类仍算存在性可核（能核"这个文件/公告存在吗"），但不给 structured 强度
      ref.parsed = true;
      return ref;
    }

    ref.parsed = false; // 连上述形态都不是 ⇒ 只能核存在性
    return ref;
  }

  // 卷(期), 页码
  const vip = raw.match(/\b(\d{1,4})\s*\(\s*([0-9]{1,4}\s*(?:-\s*[0-9A-Z]+)?)\s*\)\s*[,，]\s*([0-9A-Za-z]+(?:\s*[-–]\s*[0-9A-Za-z]+)?)/);
  if (vip) {
    ref.volume = vip[1];
    ref.issue = vip[2].replace(/\s*-\s*[0-9A-Z]+$/, ''); // 页码范围混入时剔除
    ref.pages = vip[3].replace(/\s+/g, '');
  } else {
    const vOnly = raw.match(/\b(\d{1,4})\s*\(\s*([0-9]{1,4})\s*\)\s*$/);
    if (vOnly) {
      ref.volume = vOnly[1];
      ref.issue = vOnly[2];
    }
  }

  // 期刊/书名：`Title. Journal Name, 48(1), 65-91` ⇒ 期刊名在标题之后
  //
  // 🔴 这里踩过两个坑，都表现为"解析出的容器名是句子里的一段废话"：
  //   ① 必须**排除中文正文**：`case-1987-crash` 的出处含
  //      "（主席 Nicholas F. Brady 时任美国财政部长，该委员会专为此事设立）"，
  //      而出处里混着中文说明 —— 只按 `.` 切会把中文说明当容器名。
  //   ② 必须**排除出版社**：书籍的形态是 `Author (Year). Title. Publisher.`，
  //      "Publisher" 已被 `publisher` 字段收走，再填进 container 就是重复且误导
  //      （container 应是"期刊名/书名"，不是"出版社名"）。
  const afterTitleRef = afterTitle;
  const containerM = afterTitleRef.match(
    /\.\s*([A-ZÀ-Þ][^.,;]{2,90}?)\s*(?:,\s*\d+\s*\(|,|$|\.)/,
  );
  if (containerM) {
    const cand = norm(containerM[1]);
    // 排除：含中文（说明文字，不是刊名）/ 出版社名（已单列）/ 过短
    if (!/[一-鿿]/.test(cand) && !/Press|Publishing|出版社/i.test(cand) && cand.length >= 3) {
      ref.container = cand;
    }
  }

  // 出版社
  const pubM = raw.match(/([A-Z][A-Za-z&.\s]{2,40}(?:Press|Publishing|Books))\b/);
  if (pubM) ref.publisher = norm(pubM[1]);

  // 🔴 书籍的 container 就是书名本身（`Author (Year). Book Title. Publisher.`），
  //   此时上面那个"排除出版社"的容器匹配会失手 ⇒ 显式补上：
  //   标题之后、出版社之前那一段就是书名。这条不能省，否则书籍条目的
  //   container 恒为空，等于"知道书名却没存下来"。
  if (!ref.container && ref.kind === 'book' && ref.title) {
    const bookTitle = raw
      .match(/\((?:19|20)\d{2}[a-z]?\)\.?\s*([^.;]{3,120}?)\s*\.\s*[A-Z]/);
    if (bookTitle) ref.container = norm(bookTitle[1]);
  }

  // 补充说明：「（第 6-7 章…）」「相关机制分析见 …」「行情可在本平台归档中核对」
  const noteM = raw.match(/[（(]\s*((?:相关|另见|参见|第|行情|机制|完整出处)[^）)]*)[）)]/);
  if (noteM) ref.note = norm(noteM[1]);

  return ref;
}

/**
 * 解析一条条目的完整 source（可能含多条出处）。
 * @param {string} source 条目的 source 字段
 * @returns {{raw:string, refs: SourceRef[], parsedCount:number}}
 */
function parseSource(source) {
  const raw = norm(source);
  const refs = splitRefs(raw).map(parseRef);
  return { raw, refs, parsedCount: refs.filter((r) => r.parsed).length };
}

/**
 * 条目是否达到「可发布」的出处强度。
 *
 * 🔴 为什么要有这条判据：现有发布门只判 `source` 非空。但"非空"门槛太低 ——
 *   「见某教材」也非空，可它无法被任何人核查。
 *   分级说明（注意：**不**用来做发布门的硬判定，见下）：
 *   · verifiable  有 DOI ⇒ 可机器逐字段比对（最强）
 *   · structured   有作者+年+标题 ⇒ 可比对标题（较强）
 *   · existential  只能核"这东西存在吗"（最弱，但总比不核强）
 *   · none         连出处都没写
 *
 * ⚠️ 为什么不把它直接接进 `draft` 判据（会改变发布门语义、让存量 49 条集体变草稿）：
 *   强度分级是**渐进增强**的工具，应先用于"挑出最该修的"，
 *   而不是一次性把存量全部打回。真正的门禁留给下一阶段（人工补完出处后再收紧）。
 *
 * @param {SourceRef} ref
 * @returns {'verifiable'|'structured'|'existential'|'none'}
 */
function citationStrength(ref) {
  if (!ref || !ref.raw) return 'none';
  if (ref.doi) return 'verifiable';
  // 🔴 structured 的判据（2026-10-08 审查修正）：
  //   原先写 `ref.title || ref.container` ⇒ **只要有 container 就算 structured**，
  //   而 container 常是"交易规则"/"关于…的公告"这类**无法比对任何东西**的值。
  //   实测：74 条 structured 里 **41 条只有 container 没有 title** ——
  //   接近一半的"结构化"是虚的，UI 上的强度徽标因此被高估。
  //   ⇒ 与上方定义对齐：必须有**可核验的标题**才算 structured。
  //   ⚠️ 有作者+年+标题的"完整结构化"仍算 structured（不另设等级，避免徽标口径膨胀）。
  //   ⚠️ 只有 title 没有作者/年（如机构公告）也算 —— 标题本身可被搜索核验。
  if (ref.title) return 'structured';
  return 'existential';
}

module.exports = {
  REF_KINDS,
  parseRef,
  parseSource,
  splitRefs,
  parseAuthors,
  detectKind,
  citationStrength,
  norm,
};