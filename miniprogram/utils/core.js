/* ══════════════════════════════════════════════════════════════
   utils/core.js —— 三个页面共用的配置与业务逻辑
   与 prototype/core.js 同源，只把存储层换成了小程序 API。
   ══════════════════════════════════════════════════════════════ */

/* ── 配置区 ──────────────────────────────────────────────── */
const CONFIG = {
  courts:     ['1号场', '2号场', '3号场', '4号场'], // 加场地就加项
  openHour:   8,      // 营业开始
  closeHour:  22,     // 营业结束

  // 两个粒度是分开的，别搞混：
  //   slotMin —— 计价粒度。价格按半小时算，管理员也能按半小时改价。
  //   bookMin —— 预定粒度。客人最少订 1 小时，界面上一格就是一小时。
  // 客人看到的是「一小时一个总价」，那个总价是这一小时里两个半小时价的和。
  slotMin:    30,
  bookMin:    60,

  daysAhead:  7,      // 可预约未来几天
  nightStart: 18,     // 晚间时段从几点开始

  // 默认规则价（元 / 半小时）—— 管理端可逐格覆盖
  rates: {
    weekdayDay:   30,
    weekdayNight: 45,
    weekend:      50,
  },

  // 管理端入口口令（长按首页标题触发）。
  // ⚠️ 写在客户端代码里，任何人都能反编译看到。
  //    体验版阶段只用于「防误触」；正式版必须换成
  //    openid 白名单 + 云函数校验，见 README。
  adminPasscode: '8888',
};

/* ── 派生数据 ────────────────────────────────────────────── */

// 每个格子的起始分钟数，例如 [480, 510, 540, ...]
const SLOTS = [];
for (let m = CONFIG.openHour * 60; m < CONFIG.closeHour * 60; m += CONFIG.slotMin) {
  SLOTS.push(m);
}

// 每小时的起始分钟数，例如 [480, 540, 600, ...]
// 管理端改价页按这个分行（每行两个半小时格）
const HOURS = [];
for (let m = CONFIG.openHour * 60; m < CONFIG.closeHour * 60; m += 60) {
  HOURS.push(m);
}

// 可预订的整段起始分钟数，例如 [480, 540, 600, ...]
// 客人预约页按这个分行 —— 一格就是一段，点了就订这一段
const BOOKS = [];
for (let m = CONFIG.openHour * 60; m + CONFIG.bookMin <= CONFIG.closeHour * 60; m += CONFIG.bookMin) {
  BOOKS.push(m);
}

const DOW = ['日', '一', '二', '三', '四', '五', '六'];

/** 重新计算"未来 N 天"。跨天时页面 onShow 会调用它刷新日期条。 */
function buildDates() {
  const dates = [];
  for (let i = 0; i < CONFIG.daysAhead; i++) {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() + i);
    dates.push(d);
  }
  return dates;
}

let DATES = buildDates();

const pad2 = n => String(n).padStart(2, '0');
const fmt = m => `${pad2(Math.floor(m / 60))}:${pad2(m % 60)}`;

const toDateKey = d =>
  `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

const dateLabel = (d, i) =>
  i === 0 ? '今天' : i === 1 ? '明天' : '周' + DOW[d.getDay()];

/** "2026-09-17" → "9/17 周四" */
function prettyDateKey(dk) {
  const [y, m, d] = dk.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  return `${m}/${d} 周${DOW[dt.getDay()]}`;
}

const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

/** 今天已经过去了多少分钟 */
function nowMinutes() {
  const n = new Date();
  return n.getHours() * 60 + n.getMinutes();
}

/* ── 定价 · 规则价 ───────────────────────────────────────── */
function rulePrice(date, minutes) {
  const dow = date.getDay();
  if (dow === 0 || dow === 6) return CONFIG.rates.weekend;
  return minutes >= CONFIG.nightStart * 60
    ? CONFIG.rates.weekdayNight
    : CONFIG.rates.weekdayDay;
}

/* ── 定价 · 管理员覆盖 ───────────────────────────────────
   覆盖表按【真实日期】存，不按"第几天"。否则跨过零点后，
   管理员今天手改的价格会整体错位到另一天。
   key 形如 "2026-09-17|2|1080"
   ──────────────────────────────────────────────────────── */
const PRICE_OVERRIDES = {};

const ovKey = (dayIdx, ci, min) => `${toDateKey(DATES[dayIdx])}|${ci}|${min}`;

const hasOverride = (dayIdx, ci, min) => has(PRICE_OVERRIDES, ovKey(dayIdx, ci, min));

function setOverride(dayIdx, ci, min, price) {
  PRICE_OVERRIDES[ovKey(dayIdx, ci, min)] = price;
}

function clearOverride(dayIdx, ci, min) {
  delete PRICE_OVERRIDES[ovKey(dayIdx, ci, min)];
}

/** 最终价格 = 管理员手改值 ?? 规则价 */
function priceFor(dayIdx, ci, min) {
  const k = ovKey(dayIdx, ci, min);
  return has(PRICE_OVERRIDES, k) ? PRICE_OVERRIDES[k] : rulePrice(DATES[dayIdx], min);
}

/* ── 是否已过（仅对今天生效）───────────────────────────────
   判断标准是「这段结束之前都还能订」。晚上 20:15 打开，
   20:00–21:00 这一段仍然可订 —— 客人愿意花钱买一段已经开始的
   时段，我们允许，所以不能按时段的开始时刻去卡。
   ──────────────────────────────────────────────────────── */

/** 一个计价格（半小时）是否已过 */
function isPast(dayIdx, minutes) {
  return isPastSpan(dayIdx, minutes, minutes + CONFIG.slotMin);
}

/** 一整段 [from, to) 是否已过：以结束时刻为准 */
function isPastSpan(dayIdx, from, to) {
  if (dayIdx !== 0) return false;
  return to <= nowMinutes();
}

/* ══════════════════════════════════════════════════════════════
   预约数据
   ══════════════════════════════════════════════════════════════
   ⚠️ 当前是「单机版」：数据存在各自手机本地，客人和老板的数据不通。
   要跑通双角色流程，把下面 readStore / writeStore 换成云开发调用即可，
   其余逻辑不用动。见 README 的「接云开发」一节。
   ══════════════════════════════════════════════════════════════ */

const STORE_KEY = 'mp_bookings_v1';
const SEED_FLAG = 'mp_seeded_v1';

const PENDING = 'pending', CONFIRMED = 'confirmed', CANCELLED = 'cancelled';

const STATUS_TEXT = {
  [PENDING]:   '待确认',
  [CONFIRMED]: '已确认',
  [CANCELLED]: '已取消',
};

let BOOKINGS = readStore();

function readStore() {
  try { return wx.getStorageSync(STORE_KEY) || []; }
  catch (e) { return []; }
}

function writeStore() {
  try { wx.setStorageSync(STORE_KEY, BOOKINGS); } catch (e) {}
}

/** 日期跨天时调用：重算日期表并把过期的日期索引拉回 0 */
function refreshDates() {
  DATES = buildDates();
  return DATES;
}

/* ── 创建预约 ────────────────────────────────────────────
   两道保障：
   ① 落单前再查一次占用，已被订走的格子直接剔除。
      前端提交前虽然查过，但从渲染到点提交之间可能已被订走。
      云开发版里这一层对应数据库的唯一索引，是最后一道防线。
   ② 把每段价格【快照】存进订单。之后管理员改价不会、
      也不能影响已提交的订单。

   返回 { ok, booking, skipped }
   ──────────────────────────────────────────────────────── */
function createBooking({ dayIdx, groups, phone, name, note }) {
  const dateKey = toDateKey(DATES[dayIdx]);

  const free = [], skipped = [];
  groups.forEach(g => {
    // 过期按【整段】判断，不按单个计价格 —— 段内前半截已经过去、
    // 但整段还没结束时，这一段仍然可以卖（客人愿意牺牲那点时间）。
    // 界面点不到过期的段，但落单这层必须自己扛住：页面停留久了会跨过整点。
    const expired = isPastSpan(dayIdx, g.from, g.to);
    for (let m = g.from; m < g.to; m += CONFIG.slotMin) {
      if (expired || bookingAt(dateKey, g.ci, m)) skipped.push({ ci: g.ci, min: m });
      else free.push({ ci: g.ci, min: m });
    }
  });

  if (!free.length) return { ok: false, booking: null, skipped };

  const items = [];
  let total = 0;
  groupSlots(free).forEach(g => {
    let segPrice = 0;
    for (let m = g.from; m < g.to; m += CONFIG.slotMin) {
      segPrice += priceFor(dayIdx, g.ci, m);
    }
    total += segPrice;
    items.push({ ci: g.ci, court: g.court, from: g.from, to: g.to, price: segPrice });
  });

  const now = Date.now();
  const b = {
    id: 'B' + now.toString(36) + Math.random().toString(36).slice(2, 5),
    createdAt: now,
    updatedAt: now,
    dateKey,
    items,
    slotKeys: free.map(f => `${f.ci}|${f.min}`),
    phone,
    name: name || '',
    note: note || '',
    total,
    status: PENDING,
    reply: '',
  };

  BOOKINGS.push(b);
  writeStore();
  return { ok: true, booking: b, skipped };
}

const findBooking = id => BOOKINGS.find(b => b.id === id);

function setBookingStatus(id, status, reply) {
  const b = findBooking(id);
  if (!b) return null;
  b.status = status;
  b.updatedAt = Date.now();
  if (reply !== undefined) b.reply = reply;
  writeStore();
  return b;
}

const confirmBooking = (id, reply) => setBookingStatus(id, CONFIRMED, reply);
const cancelBooking  = (id, reply) => setBookingStatus(id, CANCELLED, reply);

/* ── 时段占用查询 ──────────────────────────────────────── */
function bookingAt(dateKey, ci, min) {
  const k = `${ci}|${min}`;
  return BOOKINGS.find(b =>
    b.dateKey === dateKey && b.status !== CANCELLED && b.slotKeys.indexOf(k) >= 0);
}

/**
 * 格子状态：
 *   'past'      已过
 *   'pending'   待确认
 *   'confirmed' 已确认
 *   'free'      可预约
 */
function slotStatus(dayIdx, ci, min) {
  if (isPast(dayIdx, min)) return 'past';
  const b = bookingAt(toDateKey(DATES[dayIdx]), ci, min);
  return b ? b.status : 'free';
}

/**
 * 一个「可预订整段」的状态。段内任何一个计价格被占，整段就不可订 ——
 * 客人只能整段整段地买，所以不能把半截已经卖掉的时段再卖一次。
 */
function spanStatus(dayIdx, ci, from, to) {
  if (isPastSpan(dayIdx, from, to)) return 'past';
  const dateKey = toDateKey(DATES[dayIdx]);
  for (let m = from; m < to; m += CONFIG.slotMin) {
    const b = bookingAt(dateKey, ci, m);
    if (b) return b.status;
  }
  return 'free';
}

/** 一整段的价格 = 段内每个计价格的和 */
function spanPrice(dayIdx, ci, from, to) {
  let sum = 0;
  for (let m = from; m < to; m += CONFIG.slotMin) sum += priceFor(dayIdx, ci, m);
  return sum;
}

/* ── 列表查询（管理端用）──────────────────────────────── */
const firstMin = b => (b.items[0] ? b.items[0].from : 0);

function bookingsByStatus(status) {
  const list = BOOKINGS.filter(b => b.status === status);
  // 待确认 / 已确认 都按使用时间排，最快用到的排最前
  if (status === PENDING || status === CONFIRMED) {
    return list.sort((a, b) =>
      a.dateKey.localeCompare(b.dateKey) || firstMin(a) - firstMin(b));
  }
  return list.sort((a, b) => b.updatedAt - a.updatedAt);
}

const countByStatus = s => BOOKINGS.filter(b => b.status === s).length;

/* ── 时间显示辅助 ──────────────────────────────────────── */
function timeAgo(ts) {
  const min = Math.floor((Date.now() - ts) / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return min + ' 分钟前';
  const h = Math.floor(min / 60);
  if (h < 24) return h + ' 小时前';
  return Math.floor(h / 24) + ' 天前';
}

const isToday = dk => dk === toDateKey(new Date());

/* ── 把选中格子合并成连续区间 ────────────────────────────
   step 是「一格代表多少分钟」，默认计价粒度。
   客人页传 CONFIG.bookMin（一小时），否则相邻的两小时不会被合并。
   ──────────────────────────────────────────────────────── */
function groupSlots(picked, step) {
  const gap = step || CONFIG.slotMin;
  const byCourt = {};
  picked.forEach(({ ci, min }) => (byCourt[ci] = byCourt[ci] || []).push(min));

  const groups = [];
  Object.keys(byCourt).forEach(ci => {
    const mins = byCourt[ci].sort((a, b) => a - b);
    let start = mins[0], prev = mins[0];
    for (let i = 1; i <= mins.length; i++) {
      const cur = mins[i];
      if (i < mins.length && cur === prev + gap) { prev = cur; continue; }
      groups.push({ ci: +ci, court: CONFIG.courts[ci], from: start, to: prev + gap });
      start = prev = cur;
    }
  });
  groups.sort((a, b) => a.from - b.from || a.ci - b.ci);
  return groups;
}

/** 把 "ci|min" 字符串数组转成 groupSlots 需要的结构 */
const parseKeys = keys => keys.map(k => {
  const [ci, min] = k.split('|').map(Number);
  return { ci, min };
});

/** 把一组选中的格子整理成给客人看的清单：按场地、连续时段合并，并算钱。
    预约页的底栏和填写页的清单都用它 —— 一边一个算法迟早会对不上。 */
function summarize(dayIdx, keys) {
  const groups = groupSlots(parseKeys(keys), CONFIG.bookMin);
  let total = 0;
  const items = groups.map(g => {
    const price = spanPrice(dayIdx, g.ci, g.from, g.to);
    total += price;
    return { court: g.court, time: `${fmt(g.from)}–${fmt(g.to)}`, price };
  });
  // 每一格就是一小时，所以「几格」和「几小时」在这里是一回事
  return { items, total, count: keys.length, hours: keys.length * CONFIG.bookMin / 60 };
}

/* ── 演示数据 ────────────────────────────────────────── */
function seedDemoBookings() {
  if (BOOKINGS.length) return;
  try { if (wx.getStorageSync(SEED_FLAG)) return; } catch (e) {}

  const now = Date.now();
  const H = h => h * 60;

  const mk = (dayIdx, ci, from, to, phone, name, note, status, hoursAgo) => {
    const slotKeys = [];
    let total = 0;
    for (let m = from; m < to; m += CONFIG.slotMin) {
      slotKeys.push(`${ci}|${m}`);
      total += priceFor(dayIdx, ci, m);
    }
    const t = now - hoursAgo * 3600e3;
    return {
      id: 'B' + t.toString(36) + Math.random().toString(36).slice(2, 5),
      createdAt: t, updatedAt: t,
      dateKey: toDateKey(DATES[dayIdx]),
      items: [{ ci, court: CONFIG.courts[ci], from, to, price: total }],
      slotKeys, phone, name, note, total, status,
      reply: status === CONFIRMED ? '电话已确认' : '',
    };
  };

  BOOKINGS = [
    mk(1, 1, H(19),   H(20),   '13700137003', '王强', '带小朋友，麻烦留矮网', PENDING, 0.4),
    mk(1, 3, H(20),   H(21),   '13600136004', '陈静', '',                     PENDING, 1.2),
    mk(2, 0, H(9),    H(10),   '13500135005', '刘洋', '公司团建，8 个人',     PENDING, 2.6),
    mk(3, 2, H(18),   H(20),   '13400134006', '赵敏', '',                     PENDING, 5.1),

    mk(0, 0, H(18),   H(19),   '13800138001', '张伟', '需要球网',             CONFIRMED, 30),
    mk(0, 2, H(20),   H(21),   '13900139002', '李娜', '',                     CONFIRMED, 26),
    mk(1, 0, H(8),    H(9),    '13300133007', '孙磊', '每周固定',             CONFIRMED, 20),
    mk(1, 2, H(15),   H(17),   '13200132008', '周涛', '',                     CONFIRMED, 18),
    mk(2, 1, H(17),   H(18),   '13100131009', '吴倩', '租两支球拍',           CONFIRMED, 12),
    mk(2, 3, H(19),   H(20),   '13000130010', '郑凯', '',                     CONFIRMED, 9),
    mk(3, 0, H(10),   H(11),   '15900159011', '马丽', '',                     CONFIRMED, 7),
    mk(4, 2, H(21),   H(22),   '15800158012', '黄鹏', '晚场，别锁门',         CONFIRMED, 4),

    mk(2, 0, H(14),   H(15),   '15700157013', '徐婷', '',                     CANCELLED, 8),
  ];

  try { wx.setStorageSync(SEED_FLAG, 1); } catch (e) {}
  writeStore();
}

function clearAllData() {
  BOOKINGS = [];
  Object.keys(PRICE_OVERRIDES).forEach(k => delete PRICE_OVERRIDES[k]);
  try { wx.setStorageSync(SEED_FLAG, 1); } catch (e) {}
  writeStore();
}

module.exports = {
  CONFIG, SLOTS, HOURS, BOOKS,
  get DATES() { return DATES; },
  buildDates, refreshDates,
  fmt, toDateKey, dateLabel, prettyDateKey, nowMinutes,
  rulePrice, priceFor, hasOverride, setOverride, clearOverride,
  isPast, isPastSpan,
  PENDING, CONFIRMED, CANCELLED, STATUS_TEXT,
  createBooking, findBooking, setBookingStatus, confirmBooking, cancelBooking,
  bookingAt, slotStatus, spanStatus, spanPrice, bookingsByStatus, countByStatus, firstMin,
  timeAgo, isToday, groupSlots, parseKeys, summarize,
  seedDemoBookings, clearAllData,
  get BOOKINGS() { return BOOKINGS; },
};
