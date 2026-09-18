/* ══════════════════════════════════════════════════════════════
   getSchedule —— 只读取数（客人页和管理页共用这一个）

   对应 store.js 的 fetchAll。本地后端那里它就是「读 storage 那两个键」，
   这里换成「查两张集合」。

   ── 身份是【这里】算出来的，不是客户端自报的 ──────────────
   客户端只传口令本身，绝不传「我是管理员」这句话。
   两种身份拿到的东西【形状都不一样】：

     管理员   完整订单（含手机号、姓名、备注）→ 管理页要用
     其他人   只有 { dateKey, slotKeys, status } → 客人页只靠这三个就能
              算出「哪一格被占了」（见 core.js 的 bookingAt）

   ⚠️ ADMIN_WHITELIST 是空数组时，唯一的门就是那个口令，而口令写在
      客户端代码里、反编译可见 —— 也就是说【任何人调用这个函数都能拿到
      全部订单和手机号】。这是当前明确接受的取舍，不是漏写。
      补上只需要填那个数组，客户端和别处一行都不用改。

   ⚠️ 时区：云函数跑在 UTC（实测 tzOffsetMinutes = 0）。这个函数【不自己
      算「今天」】—— dateKey 一律以客户端算好传来的为准，这里只校验形状
      和数量。凡是将来要在服务端算日期的地方，都必须显式按 +8 算。
   ══════════════════════════════════════════════════════════════ */

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

const ADMIN_PASSCODE = '8888';

/* ← 填上老板的 openid 就启用白名单；空数组 = 退回口令校验（当前选择）。
   非空时【只认白名单】，口令完全不看 —— 两套机制不会互相削弱。 */
const ADMIN_WHITELIST = [];

const COLL_BOOKINGS = 'bookings';
const COLL_PRICES = 'prices';

/* 云函数端不写 limit 默认只返回 100 条，而超出部分是【静默消失】——
   界面上一部分已订的格子会显示成空的，客人点下去才被拒。这种错看起来
   像偶发，最难查。当前上界是 7 天 × 4 场地 × 14 小时 = 392，今天安全，
   但 CONFIG 里的 daysAhead / courts 一改就会逼近，所以显式写死，
   并且把「撞到上限」变成一次响亮的失败，而不是悄悄少给几条。 */
const LIMIT = 1000;

const DATEKEY_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_DAYS = 31;            // 一次最多问 31 天，防止有人把整年拉走

/* 非管理员只拿得到这三个字段 —— 手机号、姓名、备注、金额都没离开云函数。
   这三个正好是 core.js 算占用要的全部（bookingAt 只看 dateKey/status/slotKeys）。 */
function brief(b) {
  return { dateKey: b.dateKey, slotKeys: b.slotKeys, status: b.status };
}

/* 管理员拿完整订单。
   _id 换成 id：客户端从头到尾用的都是 b.id，云数据库的 _id 是另一个
   命名空间，别把它漏进业务对象里 —— 否则同一个订单在客人端叫 id、
   在管理端叫 _id，页面里会冒出两套取法。
   第 2 步起写入时 _id 就等于 id；这里 || 是给控制台手插的测试数据兜底。 */
function full(b) {
  const out = Object.assign({}, b);
  out.id = b.id || b._id;
  delete out._id;
  return out;
}

exports.main = async (event = {}) => {
  const openid = (cloud.getWXContext() || {}).OPENID || '';

  /* 优先白名单，白名单空时才看口令。写成一处，补白名单那天不用改别处。 */
  const isAdmin = ADMIN_WHITELIST.length
    ? ADMIN_WHITELIST.indexOf(openid) >= 0
    : event.passcode === ADMIN_PASSCODE;

  const asked = Array.isArray(event.dateKeys) ? event.dateKeys : [];
  const dateKeys = asked.filter(k => typeof k === 'string' && DATEKEY_RE.test(k));
  if (!dateKeys.length) return { ok: false, reason: 'no-dates' };
  if (dateKeys.length > MAX_DAYS) return { ok: false, reason: 'too-many-dates' };

  const _ = db.command;
  const inDays = { dateKey: _.in(dateKeys) };

  /* 两张集合分开读、各自把失败【标注上是哪一张】。
     为什么不直接 Promise.all 两个裸查询：搭起来的时候最容易翻的车就是
     「集合忘了建」（手动建的，官方现在不自动建了）。裸查询的失败会变成
     云函数抛异常，客户端只看到一句笼统的「取数失败」，真正的原因（哪张
     集合）埋在云函数日志里 —— 而那时候页面是一片空，看起来跟「还没人下单」
     一模一样，最难查。
     两句都失败也只报第一句：一次修一张，够了。 */
  async function readAll(coll) {
    try {
      const r = await db.collection(coll).where(inDays).limit(LIMIT).get();
      return { rows: r.data };
    } catch (e) {
      return { err: coll + ': ' + ((e && e.message) || e) };
    }
  }

  const [bQ, pQ] = await Promise.all([
    readAll(COLL_BOOKINGS),
    readAll(COLL_PRICES),
  ]);

  if (bQ.err || pQ.err) {
    return { ok: false, reason: 'read-failed', detail: bQ.err || pQ.err };
  }

  if (bQ.rows.length >= LIMIT || pQ.rows.length >= LIMIT) {
    return {
      ok: false,
      reason: 'over-limit',
      bookings: bQ.rows.length,
      prices: pQ.rows.length,
    };
  }

  const bookings = bQ.rows.map(isAdmin ? full : brief);

  /* ⚠️ 临时的（第 3 步删）。只在「一条都没查到」时跑，把两类完全不同的
     原因劈开：
       anyBookings=false → 集合是空的。记录压根不在【这个环境下】的这张
                           集合里（插到别的环境/别的集合去了）
       anyBookings=true  → 记录在，但 dateKey 跟问的那 7 天对不上
                            （字段名写错、值不是字符串、插的时候被改了）
     故意只回一个【布尔】不回条数：非管理员也能拿到这个响应，而「店里一共
     有多少单」是经营数据。是/否就够劈开问题了，多的不必要。 */
  let anyBookings = null;
  let shape = null;
  if (bookings.length === 0) {
    try {
      const total = (await db.collection(COLL_BOOKINGS).count()).total;
      anyBookings = total > 0;
    } catch (e) {
      anyBookings = 'count-failed: ' + ((e && e.message) || e);
    }

    /* ⚠️ 临时的（第 3 步删）。走不到这里就说明查询是好的，走到了就说明
       「记录在库里、但日期对不上」—— 这时唯一还想知道的是【那条记录
       长什么样】。只回字段名和 dateKey 的值：
         fields 里没有 dateKey  → 字段名写错了
         dateKey 不在那 7 天里  → 值不对（或者压根不是字符串）
       手机号、姓名、备注一概不回，也不需要。 */
    if (anyBookings === true) {
      try {
        const one = (await db.collection(COLL_BOOKINGS).limit(1).get()).data[0] || {};
        shape = {
          fields: Object.keys(one).sort().join(','),
          dateKey: String(one.dateKey),
          dateKeyType: typeof one.dateKey,
        };
      } catch (e) {
        shape = 'sample-failed: ' + ((e && e.message) || e);
      }
    }
  }

  /* 价格在库里是一手改一格一条（_id = "2026-09-17|0|1140"），
     回到客户端要还原成 core.js 认识的那张表：{ 那个 key: 价格 }。
     ⚠️ 存的时候把 dateKey 也单存了一份（_id 里虽然有，但用 _id 前缀查
        等于全表扫）。两份是同一个事实，写入时一起写。 */
  const prices = {};
  pQ.rows.forEach(d => { prices[d._id] = d.price; });

  /* 服务端自己的记录。客户端那两行 console.info 只在开发者工具里看得见，
     而「客人用真手机扫码时到底发生了什么」在那边是完全黑的。
     这行进【云函数日志】，跟调用方是谁无关。

     只打计数和布尔，不打订单内容 —— 手机号不该出现在日志里。
     hasOpenid 单独打：它要是 false，说明 getWXContext 没给到身份，
     那样即便带着正确口令也算不出管理员（白名单将来会因此静默失效）。 */
  console.log('[getSchedule]', JSON.stringify({
    hasOpenid: !!openid,
    isAdmin,
    asked: dateKeys.length,
    got: bookings.length,
    prices: Object.keys(prices).length,
    anyBookings,
    shape,
  }));

  return { ok: true, isAdmin, bookings, prices, anyBookings, shape };
};
