/* ══════════════════════════════════════════════════════════════
   core.js —— 客人端(index) / 管理端(admin, orders) 共用的配置与逻辑
   改配置只需要改这一个文件
   ══════════════════════════════════════════════════════════════ */

/* ── 配置区 ──────────────────────────────────────────────── */
const CONFIG = {
  courts:     ['1号场', '2号场', '3号场', '4号场'], // 加场地就加项
  openHour:   8,      // 营业开始
  closeHour:  22,     // 营业结束
  slotMin:    30,     // 最小预定粒度（分钟）
  daysAhead:  7,      // 可预约未来几天
  nightStart: 18,     // 晚间时段从几点开始

  // 默认规则价（元 / 半小时）—— 管理端可逐格覆盖
  rates: {
    weekdayDay:   30,
    weekdayNight: 45,
    weekend:      50,
  },
};

/* ── 派生数据 ────────────────────────────────────────────── */

// 每个格子的起始分钟数，例如 [480, 510, 540, ...]
const SLOTS = [];
for (let m = CONFIG.openHour * 60; m < CONFIG.closeHour * 60; m += CONFIG.slotMin) {
  SLOTS.push(m);
}

// 每小时的起始分钟数，用于把格子成对分组，例如 [480, 540, 600, ...]
const HOURS = [];
for (let m = CONFIG.openHour * 60; m < CONFIG.closeHour * 60; m += 60) {
  HOURS.push(m);
}

const DOW = ['日', '一', '二', '三', '四', '五', '六'];

const DATES = [];
for (let i = 0; i < CONFIG.daysAhead; i++) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + i);
  DATES.push(d);
}

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

function hasOverride(dayIdx, ci, min) { return has(PRICE_OVERRIDES, ovKey(dayIdx, ci, min)); }
function setOverride(dayIdx, ci, min, price) { PRICE_OVERRIDES[ovKey(dayIdx, ci, min)] = price; }
function clearOverride(dayIdx, ci, min) { delete PRICE_OVERRIDES[ovKey(dayIdx, ci, min)]; }

/** 最终价格 = 管理员手改值 ?? 规则价 */
function priceFor(dayIdx, ci, min) {
  const k = ovKey(dayIdx, ci, min);
  return has(PRICE_OVERRIDES, k) ? PRICE_OVERRIDES[k] : rulePrice(DATES[dayIdx], min);
}

/* ── 是否已过（仅对今天生效）──────────────────────────────── */
function isPast(dayIdx, minutes) {
  if (dayIdx !== 0) return false;
  const now = new Date();
  return minutes + CONFIG.slotMin <= now.getHours() * 60 + now.getMinutes();
}

/* ══════════════════════════════════════════════════════════════
   预约数据
   ══════════════════════════════════════════════════════════════
   真实系统里这一层是数据库。原型用 localStorage 模拟，
   客人端提交后管理端刷新即可看到。
   ══════════════════════════════════════════════════════════════ */

const STORE_KEY = 'mp_bookings_v1';

const PENDING = 'pending', CONFIRMED = 'confirmed', CANCELLED = 'cancelled';

const STATUS_TEXT = {
  [PENDING]:   '待确认',
  [CONFIRMED]: '已确认',
  [CANCELLED]: '已取消',
};

// localStorage 在个别环境下不可用（如某些浏览器的 file:// 限制），
// 此时降级为内存存储：同一页面内可用，跨页面/刷新会丢。
let STORAGE_OK = true;
try {
  localStorage.setItem('__probe__', '1');
  localStorage.removeItem('__probe__');
} catch (e) { STORAGE_OK = false; }

function readStore() {
  try { return JSON.parse(localStorage.getItem(STORE_KEY)) || []; }
  catch (e) { return []; }
}
function writeStore() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(BOOKINGS)); }
  catch (e) { /* 降级为仅内存 */ }
}

let BOOKINGS = readStore();

/* ── 创建预约 ────────────────────────────────────────────
   两道保障：
   ① 落单前再查一次占用，已被订走的格子直接剔除。
      前端提交前虽然查过，但从渲染到点提交之间可能已被订走。
      真实系统里这一层对应数据库的唯一索引，是最后一道防线，
      不能只靠前端。
   ② 把每段价格【快照】存进订单。之后管理员改价不会、
      也不能影响已提交的订单。

   返回 { ok, booking, skipped }
   ──────────────────────────────────────────────────────── */
function createBooking({ dayIdx, groups, phone, name, note }) {
  const dateKey = toDateKey(DATES[dayIdx]);

  const free = [], skipped = [];
  groups.forEach(g => {
    for (let m = g.from; m < g.to; m += CONFIG.slotMin) {
      // 已过期的时段一并剔除。界面上点不到，但落单这层必须自己扛住 ——
      // 页面停留久了会跨过整点，早先可选的格子就变成过期了。
      if (isPast(dayIdx, m) || bookingAt(dateKey, g.ci, m)) skipped.push({ ci: g.ci, min: m });
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
    reply: '',          // 老板的处理备注
  };

  BOOKINGS.push(b);
  writeStore();
  return { ok: true, booking: b, skipped };
}

function findBooking(id) { return BOOKINGS.find(b => b.id === id); }

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
/** 找出占用该格的预约（已取消的不算） */
function bookingAt(dateKey, ci, min) {
  const k = `${ci}|${min}`;
  return BOOKINGS.find(b =>
    b.dateKey === dateKey && b.status !== CANCELLED && b.slotKeys.indexOf(k) >= 0);
}

/**
 * 格子状态：
 *   'past'      已过
 *   'pending'   待确认（客人已提交，老板还没核实）
 *   'confirmed' 已确认
 *   'free'      可预约
 */
function slotStatus(dayIdx, ci, min) {
  if (isPast(dayIdx, min)) return 'past';
  const b = bookingAt(toDateKey(DATES[dayIdx]), ci, min);
  return b ? b.status : 'free';
}

/* ── 列表查询（管理端用）──────────────────────────────── */
const firstMin = b => (b.items[0] ? b.items[0].from : 0);

function bookingsByStatus(status) {
  const list = BOOKINGS.filter(b => b.status === status);

  // 待确认 / 已确认 都按【使用时间】排，最快用到的排最前 ——
  // 明早 8 点的场比下周的场更需要尽快打电话核实
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

/* ── 把选中格子合并成连续区间 ──────────────────────────── */
function groupSlots(picked) {
  const byCourt = {};
  picked.forEach(({ ci, min }) => (byCourt[ci] = byCourt[ci] || []).push(min));

  const groups = [];
  Object.keys(byCourt).forEach(ci => {
    const mins = byCourt[ci].sort((a, b) => a - b);
    let start = mins[0], prev = mins[0];
    for (let i = 1; i <= mins.length; i++) {
      const cur = mins[i];
      if (i < mins.length && cur === prev + CONFIG.slotMin) { prev = cur; continue; }
      groups.push({ ci: +ci, court: CONFIG.courts[ci], from: start, to: prev + CONFIG.slotMin });
      start = prev = cur;
    }
  });
  groups.sort((a, b) => a.from - b.from || a.ci - b.ci);
  return groups;
}

/* ── 演示数据 ──────────────────────────────────────────
   首次打开时灌一批预约，让两端都有东西可看。
   管理端有「清空全部数据」按钮可以随时清掉重来。
   ──────────────────────────────────────────────────────── */
const SEED_FLAG = 'mp_seeded_v1';

function seedDemoBookings() {
  if (BOOKINGS.length) return;
  // 用户主动清空过之后就不再自动灌演示数据
  try { if (localStorage.getItem(SEED_FLAG)) return; } catch (e) {}

  const now = Date.now();
  const H = h => h * 60;

  const mk = (dayIdx, ci, from, to, phone, name, note, status, hoursAgo) => {
    const dateKey = toDateKey(DATES[dayIdx]);
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
      dateKey,
      items: [{ ci, court: CONFIG.courts[ci], from, to, price: total }],
      slotKeys, phone, name, note, total, status,
      reply: status === CONFIRMED ? '电话已确认' : '',
    };
  };

  BOOKINGS = [
    // 待确认 —— 等老板打电话
    mk(1, 1, H(19),   H(20),   '13700137003', '王强', '带小朋友，麻烦留矮网', PENDING, 0.4),
    mk(1, 3, H(20),   H(21),   '13600136004', '陈静', '',                     PENDING, 1.2),
    mk(2, 0, H(9),    H(10),   '13500135005', '刘洋', '公司团建，8 个人',     PENDING, 2.6),
    mk(3, 2, H(18),   H(19.5), '13400134006', '赵敏', '',                     PENDING, 5.1),

    // 已确认
    mk(0, 0, H(18),   H(19),   '13800138001', '张伟', '需要球网',             CONFIRMED, 30),
    mk(0, 2, H(20),   H(21),   '13900139002', '李娜', '',                     CONFIRMED, 26),
    mk(1, 0, H(8),    H(9),    '13300133007', '孙磊', '每周固定',             CONFIRMED, 20),
    mk(1, 2, H(15),   H(16.5), '13200132008', '周涛', '',                     CONFIRMED, 18),
    mk(2, 1, H(17),   H(18),   '13100131009', '吴倩', '租两支球拍',           CONFIRMED, 12),
    mk(2, 3, H(19),   H(20),   '13000130010', '郑凯', '',                     CONFIRMED, 9),
    mk(3, 0, H(10),   H(11),   '15900159011', '马丽', '',                     CONFIRMED, 7),
    mk(4, 2, H(21),   H(22),   '15800158012', '黄鹏', '晚场，别锁门',         CONFIRMED, 4),

    // 已取消
    mk(2, 0, H(14),   H(15),   '15700157013', '徐婷', '',                     CANCELLED, 8),
  ];

  try { localStorage.setItem(SEED_FLAG, '1'); } catch (e) {}
  writeStore();
}

function clearAllData() {
  BOOKINGS = [];
  Object.keys(PRICE_OVERRIDES).forEach(k => delete PRICE_OVERRIDES[k]);
  try { localStorage.setItem(SEED_FLAG, '1'); } catch (e) {}
  writeStore();
}
