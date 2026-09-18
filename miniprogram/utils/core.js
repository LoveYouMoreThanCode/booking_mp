/* ══════════════════════════════════════════════════════════════
   utils/core.js —— 四个页面共用的配置与业务逻辑
   与 prototype/core.js 同源，存储层已抽到 utils/store.js。
   ══════════════════════════════════════════════════════════════ */

const store = require('./store.js');

/* 冷启动第一屏：模块加载时同步读一次本地镜像。
   页面第一次 buildGrid() 就有价格、有待/满状态，不用等网络。
   接云开发后这一步读的仍然是本地镜像，云端结果由 refresh() 补上 ——
   这就是「本地缓存先渲染，云端结果回来再刷新」里的前半句。 */
const CACHE0 = store.readCache();

/* ── 配置区 ──────────────────────────────────────────────── */
const CONFIG = {
  courts:     ['1号场', '2号场', '3号场', '4号场'], // 加场地就加项
  openHour:   8,      // 营业开始
  closeHour:  22,     // 营业结束

  // 计价粒度和预定粒度【都是 1 小时】，和客人界面上的一格一致：
  //   slotMin —— 计价粒度。老板改价页一格就是一小时，填 90 这一小时就是 90。
  //   bookMin —— 预定粒度。客人最少订 1 小时，界面上一格就是一小时。
  // 两个值保持相等即可，两边的网格都跟着它们走。
  slotMin:    60,
  bookMin:    60,

  daysAhead:  7,      // 可预约未来几天
  nightStart: 18,     // 晚间时段从几点开始

  // 默认规则价（元 / 小时，也就是上面 slotMin 的那一格）—— 管理端可逐格覆盖。
  // ⚠️ 这几条原来是「元 / 半小时」。slotMin 从 30 改成 60 时必须一起翻倍，
  //    否则客人看到的价格会整体打对折。
  rates: {
    weekdayDay:   60,
    weekdayNight: 90,
    weekend:      100,
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
// 管理端改价页按这个分行（一行就是一小时）
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

   ⚠️ 这张表【必须落存储】。它原来是个纯内存对象，于是老板在改价页
      改完价、关掉小程序再打开，价格全回到规则价 —— 真出过的 bug。
   ──────────────────────────────────────────────────────── */
/* 价格表从本地镜像里来（模块加载时读的那一次，见文件顶部的 CACHE0）。
   存储那头的读写细节全在 store.js，这里只留一个名字。 */
const PRICE_OVERRIDES = CACHE0.prices;

/* 改价的公共收尾：内存里已经改好了，这里只负责落库，失败再撤回。

   ⚠️ 撤回只回滚【这次动过的 key】，不整表写回 —— 云端可能有别人
      同时在改别的格子，整表覆盖会把他的改动一起抹掉。 */
function snapKeys(keys) {
  return keys.map(k => ({ key: k, had: has(PRICE_OVERRIDES, k), old: PRICE_OVERRIDES[k] }));
}

function commitPrices(undo) {
  const out = store.makeTask();
  store.savePrices(PRICE_OVERRIDES)
    .done(() => out.settle(null, true))
    .fail(err => {
      undo.forEach(u => { if (u.had) PRICE_OVERRIDES[u.key] = u.old; else delete PRICE_OVERRIDES[u.key]; });
      out.settle(err);
    });
  return out;
}

/* 整批换掉价格表的内容（refresh 用）。同样只原地增删，不换对象。 */
function applyPrices(map) {
  Object.keys(PRICE_OVERRIDES).forEach(k => delete PRICE_OVERRIDES[k]);
  Object.keys(map || {}).forEach(k => { PRICE_OVERRIDES[k] = map[k]; });
}

const ovKey = (dayIdx, ci, min) => `${toDateKey(DATES[dayIdx])}|${ci}|${min}`;

const hasOverride = (dayIdx, ci, min) => has(PRICE_OVERRIDES, ovKey(dayIdx, ci, min));

function setOverride(dayIdx, ci, min, price) {
  const k = ovKey(dayIdx, ci, min);
  const undo = snapKeys([k]);
  PRICE_OVERRIDES[k] = price;
  return commitPrices(undo);
}

function clearOverride(dayIdx, ci, min) {
  const k = ovKey(dayIdx, ci, min);
  const undo = snapKeys([k]);
  delete PRICE_OVERRIDES[k];
  return commitPrices(undo);
}

/* 批量版：改价页「应用到选中」一次能选 56 格（整张表），逐格写等于把整张表
   序列化几十次 —— 一次写完。接云开发后这一条对应【一次】云函数调用，
   而不是 56 次。keys 是 "ci|min" 字符串数组，和客人页的选择同一套格式。 */
function setOverrides(dayIdx, keys, price) {
  const ks = keys.map(k => {
    const [ci, min] = k.split('|').map(Number);
    return ovKey(dayIdx, ci, min);
  });
  const undo = snapKeys(ks);               // 必须在改之前拍快照
  ks.forEach(k => { PRICE_OVERRIDES[k] = price; });
  return commitPrices(undo);
}

function clearOverrides(dayIdx, keys) {
  const ks = keys.map(k => {
    const [ci, min] = k.split('|').map(Number);
    return ovKey(dayIdx, ci, min);
  });
  const undo = snapKeys(ks);
  ks.forEach(k => delete PRICE_OVERRIDES[k]);
  return commitPrices(undo);
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

/** 一个计价档（一小时）是否已过 */
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
   存储细节已经全部抽到 utils/store.js —— 接云开发时【只改那个文件里的
   一行】`const backend = localBackend`，这里的业务逻辑一行都不动。
   见 README 的「接云开发」一节。
   ══════════════════════════════════════════════════════════════ */

const PENDING = 'pending', CONFIRMED = 'confirmed', CANCELLED = 'cancelled';

const STATUS_TEXT = {
  [PENDING]:   '待确认',
  [CONFIRMED]: '已确认',
  [CANCELLED]: '已取消',
};

/* 内存工作集：本地镜像读出来的那一份。
   ⚠️ 从此【只原地增删，永不整体赋值】—— 页面和测试都握着这个数组本身，
      一旦换成新数组，它们看到的就是旧数据，而且界面会静默不更新。
      要整批换内容请用 applyBookings()。 */
const BOOKINGS = CACHE0.bookings;

function applyBookings(list) {
  BOOKINGS.length = 0;
  (list || []).forEach(b => BOOKINGS.push(b));
}

/**
 * 拉一次权威数据，覆盖内存缓存，然后回调。
 *
 * 契约（换云开发时最要紧的一条）：
 *   ① cb 【一定会】被调用 —— 成功、失败都调；失败时界面继续显示缓存里的旧数据。
 *   ② 本地后端【同步】回调，云端后端异步回调。
 *   ③ 所以「拿到数据之后要做的事」必须写在 cb 里，
 *      【绝不能】写在 refresh() 的下一行 —— 本地能跑，云端必崩。
 */
/**
 * 这次请求该不该带管理口令。
 *
 * ⚠️ 只有在【真的解锁过】管理端之后才发。要是无脑带上 CONFIG.adminPasscode，
 *    那么每个客人的手机都会拿着口令去问，云函数那边「非管理员只拿投影」
 *    就永远不会生效 —— 等于把所有人的手机号发给所有人，
 *    而那正是这套投影存在的理由。
 *
 * 解锁状态就存在 app.globalData.adminUnlocked（预约页长按标题时置上），
 * 这里只是读它，不另存一份 —— 两份状态迟早会不一致。
 */
function adminPasscode() {
  try {
    const app = typeof getApp === 'function' ? getApp() : null;
    return (app && app.globalData && app.globalData.adminUnlocked)
      ? CONFIG.adminPasscode : '';
  } catch (e) { return ''; }   // 测试环境里没有 getApp，当成没解锁
}

function refresh(cb) {
  /* dateKeys 在【这里】算，不在 store.js 里算 —— 全项目只有这一份
     「第几天 → 日期」的换算（buildDates / toDateKey）。store 再写一份
     就会多出一个会走偏的定义。 */
  const t = store.fetchAll({
    dateKeys: DATES.map(toDateKey),
    passcode: adminPasscode(),
  });
  t.done(d => {
    applyBookings(d.bookings);
    applyPrices(d.prices);
    /* ⚠️ 临时的（第 3 步删）。这一行回答的是「数据到了之后有没有落到内存里」
       —— 上面 store 那行打的是「网络回来什么」，这行打的是「内存里现在是什么」。
       两行一起看，能一次分清三种空：没回来 / 回来了但被丢掉 / 回来了但日期对不上
       （datakey 会和客人页正在看的那天一起打出来）。 */
    if (typeof console !== 'undefined' && console.info) {
      console.info('[core] 内存里 ' + BOOKINGS.length + ' 单，今天 = ' + toDateKey(DATES[0])
        + '，第0天起的 7 天 = ' + DATES.map(toDateKey).join(' '));
    }
  });
  t.fail(err => {
    // 失败【不清缓存】：宁可用旧数据，也别把界面清空
    if (typeof console !== 'undefined' && typeof console.warn === 'function') {
      console.warn('取数失败，继续用本地缓存', err);
    }
  });
  const wake = () => { if (cb) cb(); };
  t.done(wake);
  t.fail(wake);
  return t;
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

   【返回 task】，.done 里是 { ok, booking, skipped }，.fail 里是落库失败。

   ③ 乐观写入：订单先塞进内存，客人点完立刻看到「已提交」，不等落库。
      落库失败再把这一条摘掉 —— 否则客人会看到一条只存在于内存里的
      假订单，他以为约上了，老板那头什么都没有。
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

  // 一个格子都没剩下：没东西可写，直接给一个已 settle 的结果
  if (!free.length) return store.fetched(null, { ok: false, booking: null, skipped });

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

  BOOKINGS.push(b);                        // 乐观：界面当场就能看到这一条

  const out = store.makeTask();
  store.insert(b)
    .done(() => out.settle(null, { ok: true, booking: b, skipped }))
    .fail(err => {
      const i = BOOKINGS.indexOf(b);
      if (i >= 0) BOOKINGS.splice(i, 1);   // 回滚：别留一条只活在内存里的订单
      out.settle(err);
    });
  return out;
}

const findBooking = id => BOOKINGS.find(b => b.id === id);

/**
 * 改订单状态。返回 task：.done 给订单，.fail 给落库错误。
 * 订单不存在时返回 null（保持原来的语义）。
 */
function setBookingStatus(id, status, reply) {
  const b = findBooking(id);
  if (!b) return null;

  // 乐观 + 回滚：老板点「确认」，卡片当场跳到已确认那栏；写失败再弹回去
  const prev = { status: b.status, updatedAt: b.updatedAt, reply: b.reply };
  b.status = status;
  b.updatedAt = Date.now();
  if (reply !== undefined) b.reply = reply;

  const out = store.makeTask();
  store.update(id, { status: b.status, updatedAt: b.updatedAt, reply: b.reply })
    .done(() => out.settle(null, b))
    .fail(err => {
      Object.assign(b, prev);
      out.settle(err);
    });
  return out;
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

/**
 * 清空全部数据（订单 + 手改价）。返回 task。
 *
 * 两步写（订单、价格）都要成功才算清干净；任何一步失败就整体回滚 ——
 * 否则会留下「订单清空了、价格还在」这种半拉子状态，老板看不出来。
 */
function clearAllData() {
  const prevBookings = BOOKINGS.slice();
  const prevPrices = Object.assign({}, PRICE_OVERRIDES);
  const rollback = () => { applyBookings(prevBookings); applyPrices(prevPrices); };

  applyBookings([]);                    // 原地清空，别换数组（页面握着它）
  Object.keys(PRICE_OVERRIDES).forEach(k => delete PRICE_OVERRIDES[k]);

  const out = store.makeTask();
  const fail = err => { rollback(); out.settle(err); };
  store.replaceBookings([])
    .done(() => {
      // 手改价也要清掉，否则「清空数据」后价格还是旧的
      store.savePrices({})
        .done(() => out.settle(null, true))
        .fail(fail);
    })
    .fail(fail);
  return out;
}

module.exports = {
  CONFIG, SLOTS, HOURS, BOOKS,
  get DATES() { return DATES; },
  buildDates, refreshDates, refresh,
  fmt, toDateKey, dateLabel, prettyDateKey, nowMinutes,
  rulePrice, priceFor, hasOverride, setOverride, clearOverride,
  setOverrides, clearOverrides,
  isPast, isPastSpan,
  PENDING, CONFIRMED, CANCELLED, STATUS_TEXT,
  createBooking, findBooking, setBookingStatus, confirmBooking, cancelBooking,
  bookingAt, slotStatus, spanStatus, spanPrice, bookingsByStatus, countByStatus, firstMin,
  timeAgo, isToday, groupSlots, parseKeys, summarize,
  clearAllData,
  get BOOKINGS() { return BOOKINGS; },
};
