'use strict';
// ─────────────────────────────────────────────────────────────
// 模型分享：可见性与审核状态机（Phase 2 · 模型分享 v1）
//
//   计划书依据（§4.6 分享）：
//     「三级可见性 —— 私有 / 邀请码圈内共享 / 平台公开示例（admin 审核）。
//       分享物 = 声明式 Model JSON + 报告，不含任何代码；一码一人的归属可追溯。」
//
//   🔴 两条设计裁定（2026-10-06，用户授权"哪个好用哪个"）：
//     ① **圈内 = 全站注册用户可见**，不引入 shareToken ——
//        计划书的「圈」就是邀请码准入的群体 ⇒ **身份准入**，不是**凭据准入**。
//        引入分享链接会让 circle 从"谁能进圈"漂移成"谁拿到链接"，语义失控，
//        且要给链接加生命周期管理。身份准入与既有鉴权同源，零额外状态。
//     ② **public 必须经 admin 审核才生效** —— 平台公开示例 = 平台替它背书，
//        未把关就挂出去等于平台自证（合规 + 质量双重风险）。
//
//   🔴 状态模型（关键设计：**visibility 始终是"当前生效值"**）
//     visibility : private | circle | public            —— 现在谁能看
//     reviewState: none | pending | approved | rejected —— 公开申请的状态
//     · 申请公开 **不改 visibility**（仍是 private/circle），只置 reviewState='pending'
//     · **只有批准**才把 visibility 置为 'public'
//     · 驳回 **不改 visibility**（既不悄悄降级、也不误升级）
//     ⇒ 任何时刻"实际可见范围"由 visibility 唯一决定，不需要回溯历史状态，
//       也就不存在"pending 期间到底谁能看"这类含糊地带。
//
//   ⚠️ 纯函数单一源：前端按 `modelshare.mjs` 导入、后端 `require('modelshare.cjs')`。
//      不读文件、不发请求、不碰时间（时间由 opts.now 注入 ⇒ 可测）。
// ─────────────────────────────────────────────────────────────

const SHARE_VERSION = 1;

const VISIBILITIES = ['private', 'circle', 'public'];
const REVIEW_STATES = ['none', 'pending', 'approved', 'rejected'];
const DEFAULT_VISIBILITY = 'private';
const DEFAULT_REVIEW_STATE = 'none';

/** 驳回理由长度上限（写入库/索引，必须有界） */
const REVIEW_NOTE_MAX = 200;

const VISIBILITY_LABELS = {
  private: '私有',
  circle: '圈内共享',
  public: '公开示例',
};

const REVIEW_LABELS = {
  none: '未申请',
  pending: '待审核',
  approved: '已通过',
  rejected: '已驳回',
};

/**
 * 分享物里允许出现的模型字段（**白名单**，不是黑名单）。
 * 🔴 用白名单的理由：将来 modelspec 新增字段时，黑名单会**静默泄露**新字段，
 *    白名单只会"少给"（可见的失败），不会"多给"（不可见的泄露）。
 * ⚠️ 与 `shared/modelspec.cjs` 的 normalizeModel 产出保持等价 ⇒ 有契约测试锁住。
 */
const MODEL_FIELDS = ['schemaVersion', 'name', 'factors', 'transforms', 'combine', 'filters', 'universe', 'backtest', 'meta'];

/** 动作目录：谁可以做、做什么（单一源；前端据此渲染按钮） */
const ACTIONS = {
  'set-private': { by: 'owner', desc: '设为私有', label: '设为私有' },
  'set-circle': { by: 'owner', desc: '设为圈内共享', label: '圈内共享' },
  'request-public': { by: 'owner', desc: '申请公开（需管理员审核）', label: '申请公开' },
  'withdraw-request': { by: 'owner', desc: '撤回公开申请', label: '撤回申请' },
  approve: { by: 'admin', desc: '通过公开申请', label: '通过' },
  reject: { by: 'admin', desc: '驳回公开申请', label: '驳回' },
};

/**
 * 动作按角色分组 —— **路由层必须据此校验**。
 *
 * 🔴 为什么状态机本身不够：`applyShareAction(doc, action)` 是纯函数，它**不知道调用者是谁**。
 *    若 owner 端点不校验角色，他就能传 `action:'approve'`。
 *    状态机只在"当前不是 pending"时才会拒绝 —— 也就是说**只要他自己申请过（pending）**，
 *    就能自己给自己过审，把模型直接变成公开示例。审核就形同虚设了。
 *    ⇒ 身份校验必须在路由层做，且用这里的分组做单一源。
 */
const OWNER_ACTIONS = ['set-private', 'set-circle', 'request-public', 'withdraw-request'];
const ADMIN_ACTIONS = ['approve', 'reject'];

/** 动作是否属于该角色（路由层闸门；未知动作一律 false） */
function actionBy(action) {
  const a = String(action || '');
  if (!Object.prototype.hasOwnProperty.call(ACTIONS, a)) return null;
  return ACTIONS[a].by;
}

const isValidVisibility = (v) => VISIBILITIES.includes(v);
const isValidReviewState = (s) => REVIEW_STATES.includes(s);

/**
 * 从文档里读出分享状态（**归一化**：缺失/非法一律回落到安全默认值）。
 * 老数据没有这些字段 ⇒ 自动表现为"私有 / 未申请"，无需数据迁移。
 */
function shareOf(doc) {
  const d = doc || {};
  return {
    visibility: isValidVisibility(d.visibility) ? d.visibility : DEFAULT_VISIBILITY,
    reviewState: isValidReviewState(d.reviewState) ? d.reviewState : DEFAULT_REVIEW_STATE,
    reviewNote: typeof d.reviewNote === 'string' ? d.reviewNote.slice(0, REVIEW_NOTE_MAX) : '',
    requestedAt: typeof d.requestedAt === 'string' ? d.requestedAt : null,
    publishedAt: typeof d.publishedAt === 'string' ? d.publishedAt : null,
  };
}

/**
 * **实际生效**的可见性。
 * 正常路径下恒等于 visibility；这里只做**防御**：若数据被手工改坏
 * （visibility=public 而 reviewState 不是 approved），按**更保守**的私有处理 ——
 * 宁可少暴露，不可多暴露。
 */
function effectiveVisibility(doc) {
  const s = shareOf(doc);
  if (s.visibility === 'public' && s.reviewState !== 'approved') return 'private';
  return s.visibility;
}

/**
 * 可见性判定（权限矩阵的唯一实现）。
 * @param {object} doc 模型文档（含 uid / visibility / reviewState）
 * @param {{uid?:string, isAdmin?:boolean}|null} viewer 访问者（匿名传 null）
 * @returns {boolean}
 *
 * 规则：
 *   · 本人       → 恒可见（自己的东西）
 *   · public     → 任何人（含匿名）
 *   · circle     → 任何已登录用户（有 uid）
 *   · private    → 仅本人
 *   · admin 额外 → 可见 **pending / rejected** 的模型（审核必需）
 *                  ⚠️ 但**不可见**普通 private 模型 —— 最小权限：
 *                     没申请公开的模型与审核无关，管理员无权翻看。
 */
function canView(doc, viewer) {
  if (!doc) return false;
  const ownerUid = String(doc.uid || '');
  const viewerUid = viewer && viewer.uid ? String(viewer.uid) : '';
  if (viewerUid && viewerUid === ownerUid) return true;

  const v = effectiveVisibility(doc);
  if (v === 'public') return true;
  if (v === 'circle' && viewerUid) return true;

  const s = shareOf(doc);
  if (viewer && viewer.isAdmin && (s.reviewState === 'pending' || s.reviewState === 'rejected')) return true;

  return false;
}

/**
 * 状态机：给定当前文档与动作，算出**需要落库的补丁**（纯函数，不改入参）。
 *
 * @param {object} doc 当前文档
 * @param {string} action 见 ACTIONS
 * @param {{now?:string, note?:string}} [opts] now = ISO 时间（调用方注入）
 * @returns {{ok:true, patch:object} | {ok:false, error:string}}
 */
function applyShareAction(doc, action, opts = {}) {
  const a = String(action || '');
  if (!Object.prototype.hasOwnProperty.call(ACTIONS, a)) {
    return { ok: false, error: `未知分享动作：${a.slice(0, 40)}` };
  }
  const s = shareOf(doc);
  const now = opts.now || null;

  switch (a) {
    case 'set-private':
      // 撤回/降级：任何状态都可执行；**同时清空审核状态**（已经不在公开面上了）
      return {
        ok: true,
        patch: { visibility: 'private', reviewState: 'none', reviewNote: '', requestedAt: null, publishedAt: null },
      };

    case 'set-circle':
      return {
        ok: true,
        patch: { visibility: 'circle', reviewState: 'none', reviewNote: '', requestedAt: null, publishedAt: null },
      };

    case 'request-public': {
      if (s.reviewState === 'pending') return { ok: false, error: '公开申请已在审核中，无需重复提交' };
      if (s.visibility === 'public' && s.reviewState === 'approved') {
        return { ok: false, error: '该模型已是公开示例；如需重新审核请先撤回' };
      }
      // ⚠️ 不改 visibility：申请的这一刻还看不到，批准才生效
      return { ok: true, patch: { reviewState: 'pending', reviewNote: '', requestedAt: now } };
    }

    case 'withdraw-request':
      if (s.reviewState !== 'pending') return { ok: false, error: '当前没有待审核的公开申请' };
      return { ok: true, patch: { reviewState: 'none', requestedAt: null } };

    case 'approve':
      if (s.reviewState !== 'pending') return { ok: false, error: '只能审核"待审核"状态的申请' };
      return { ok: true, patch: { visibility: 'public', reviewState: 'approved', reviewNote: '', publishedAt: now } };

    case 'reject':
      if (s.reviewState !== 'pending') return { ok: false, error: '只能审核"待审核"状态的申请' };
      return {
        ok: true,
        // ⚠️ 驳回**不动 visibility**：用户原本是私有还是圈内，驳回后保持不变
        patch: { reviewState: 'rejected', reviewNote: String(opts.note || '').slice(0, REVIEW_NOTE_MAX) },
      };

    default:
      return { ok: false, error: `未实现的动作：${a}` };
  }
}

/**
 * 归属显示名（**脱敏**）。计划书要求"一码一人的归属可追溯"，但外露的必须是**显示名**。
 *
 * 🔴 为什么必须有这一层：`broker.uidOf()` 在**未启用鉴权**的部署下返回 `ip:1.2.3.4`
 *    （按来源 IP 分账，见 server/paper/broker.cjs）。若直接把它当作者名渲染到
 *    公开广场，等于把访问者 IP 挂到公网 —— 既是隐私泄露，也让作者无法识别自己。
 *    故：`ip:` 前缀一律显示为"匿名用户"，不外露任何网络标识。
 *
 * @param {string} uid
 * @returns {string}
 */
function authorNameOf(uid) {
  const u = String(uid || '').trim();
  if (!u) return '匿名用户';
  if (u.startsWith('ip:')) return '匿名用户'; // 绝不外露 IP
  if (u === 'default') return '本机';
  return u.slice(0, 40);
}

/**
 * 分享物：**声明式 Model JSON + 报告**，不含任何代码（计划书 §4.6）。
 *
 * 🔴 必须剥掉 `uid` —— 它既是所有权凭据、也是个人信息（PIPL 最小化）。
 *    对外只给"作者显示名"，由调用方解析后经 opts.author 传入（本模块不查库）。
 * 🔴 用**字段白名单**挑选模型本体：将来 doc 上新增存储字段不会自动跟着漏出去。
 *
 * @param {object} doc 存储文档
 * @param {{author?:string, modelHash?:string, includeReview?:boolean}} [opts]
 */
function shareView(doc, opts = {}) {
  const s = shareOf(doc);
  const d = doc || {};
  const model = {};
  for (const k of MODEL_FIELDS) if (d[k] !== undefined) model[k] = d[k];
  return {
    shareVersion: SHARE_VERSION,
    // ⚠️ 类型收紧为 string（不是 string|null）：存储里的模型必有 id，
    //    标成 nullable 会让**每个调用方**都要判空。防御仍在 —— 缺失时给空串，
    //    调用方一次 `if (!id)` 就能挡住。
    id: String(d.id || ''),
    name: d.name || (d.meta && d.meta.name) || '(未命名)',
    /** 归属可追溯（计划书要求）；**不是** uid */
    author: opts.author || null,
    modelHash: opts.modelHash || null,
    visibility: s.visibility,
    publishedAt: s.publishedAt,
    sharedAt: d.updatedAt || null,
    ...(opts.includeReview ? { reviewState: s.reviewState, reviewNote: s.reviewNote, requestedAt: s.requestedAt } : {}),
    model,
  };
}

/** 列表行用的分享摘要（不含模型本体，避免列表响应体膨胀） */
function shareSummary(doc, opts = {}) {
  const s = shareOf(doc);
  const d = doc || {};
  return {
    id: String(d.id || ''),
    name: d.name || '(未命名)',
    author: opts.author || null,
    modelHash: opts.modelHash || null,
    visibility: s.visibility,
    effective: effectiveVisibility(d),
    reviewState: s.reviewState,
    reviewNote: opts.includeReview ? s.reviewNote : undefined,
    publishedAt: s.publishedAt,
    updatedAt: d.updatedAt || null,
    /** 因子数：列表走索引行时拿不到正文 ⇒ null（前端显示为"—"，不谎报 0） */
    factorCount: Array.isArray(d.factors) ? d.factors.length : null,
  };
}

/** 供前端渲染的动作清单（按身份过滤） */
function actionsFor(doc, actor) {
  const s = shareOf(doc);
  const isOwner = !!(actor && actor.isOwner);
  const isAdmin = !!(actor && actor.isAdmin);
  const out = [];
  if (isOwner) {
    if (s.visibility !== 'private' || s.reviewState !== 'none') out.push('set-private');
    if (s.visibility !== 'circle' || s.reviewState !== 'none') out.push('set-circle');
    if (s.reviewState === 'pending') out.push('withdraw-request');
    else if (!(s.visibility === 'public' && s.reviewState === 'approved')) out.push('request-public');
  }
  if (isAdmin && s.reviewState === 'pending') {
    out.push('approve');
    out.push('reject');
  }
  return out;
}

module.exports = {
  SHARE_VERSION,
  VISIBILITIES,
  REVIEW_STATES,
  DEFAULT_VISIBILITY,
  DEFAULT_REVIEW_STATE,
  REVIEW_NOTE_MAX,
  VISIBILITY_LABELS,
  REVIEW_LABELS,
  MODEL_FIELDS,
  ACTIONS,
  OWNER_ACTIONS,
  ADMIN_ACTIONS,
  actionBy,
  isValidVisibility,
  isValidReviewState,
  shareOf,
  effectiveVisibility,
  canView,
  applyShareAction,
  authorNameOf,
  shareView,
  shareSummary,
  actionsFor,
};
