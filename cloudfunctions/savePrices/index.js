/* ══════════════════════════════════════════════════════════════
   savePrices —— 老板改价

   对应 store.js 的 savePrices。

   ── 为什么一手改一格一条 ──────────────────────────────────
   本来想一天一条文档。但客户端提交的是【被改动的那几格】，一天一条
   意味着两个管理员（或者老板手抖点了两下）会互相覆盖，而且【谁都不会
   发现】—— 各自屏幕上都显示着自己改的值，等下一次 refresh 才会跳。
   一手一格一条之后，写集就是真正被改的那几格，天然不丢更新。

   _id 直接复用 core.js 的 ovKey（"2026-09-17|0|1140"），全项目
   只有一个拼 key 的函数。

   ⚠️ 顺手把 dateKey 单独存一份：_id 前缀里虽然有，但按 _id 做前缀
      查等于全表扫，getSchedule 是按 dateKey 过滤的。

   ⚠️ 管理端操作，必须过鉴权。见下面的 isAdmin。
   ══════════════════════════════════════════════════════════════ */

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

const COLL_PRICES = 'prices';

/* 一次调用最多改多少格。改价页「应用到选中」最坏是把整张表 56 格
   一次写完，200 留了足够余量，同时挡住有人拿它当批量写接口刷。 */
const MAX_CELLS = 200;

const PRICE_KEY_RE = /^\d{4}-\d{2}-\d{2}\|\d+\|\d+$/;

/* ── 鉴权 ────────────────────────────────────────────────
   ⚠️ 这一段在 updateBooking / savePrices / clearAll 三个云函数里
      【逐字相同】地各有一份。云函数之间没法共享代码（除非上云函数层），
      所以只能复制 —— 但 smoke.js 里有一条断言把三份拉出来逐字比对，
      谁改歪了立刻红。改这里就要改那三处，别只改一处。

   ⚠️ ADMIN_WHITELIST 是空数组时，唯一的门就是那个口令，而口令写在
      客户端代码里、反编译可见 —— 也就是说【任何人调用这几个函数都能
      改数据、能清库】。这是当前明确接受的取舍，不是漏写。
      补上只需要填那个数组，客户端和别处一行都不用改。 */
const ADMIN_PASSCODE = '8888';
const ADMIN_WHITELIST = [];

function isAdmin(event, openid) {
  return ADMIN_WHITELIST.length
    ? ADMIN_WHITELIST.indexOf(openid) >= 0
    : event.passcode === ADMIN_PASSCODE;
}

exports.main = async (event = {}) => {
  const openid = (cloud.getWXContext() || {}).OPENID || '';
  if (!isAdmin(event, openid)) return { ok: false, reason: 'forbidden' };

  const set = event.set || {};
  const del = Array.isArray(event.del) ? event.del : [];

  const setKeys = Object.keys(set);
  if (setKeys.length + del.length > MAX_CELLS) return { ok: false, reason: 'too-many-cells' };

  for (const k of setKeys) {
    if (!PRICE_KEY_RE.test(k)) return { ok: false, reason: 'bad-key', detail: k };
    const p = Number(set[k]);
    if (!isFinite(p) || p < 0) return { ok: false, reason: 'bad-price', detail: k };
  }
  for (const k of del) {
    if (!PRICE_KEY_RE.test(k)) return { ok: false, reason: 'bad-key', detail: k };
  }

  const written = [], removed = [], failed = [];

  /* ⚠️ 逐格写、逐格删，而且【不整表覆盖】。一格失败不影响别的格 ——
      老板改了 5 格，第 3 格网络抖了一下，另外 4 格该落还是落。
      客户端那边会把失败的那几格标出来（core.js 的 commitPrices
      只回滚这次动过的 key）。 */
  for (const k of setKeys) {
    try {
      await db.collection(COLL_PRICES).doc(k).set({
        data: { _id: k, dateKey: k.split('|')[0], price: Number(set[k]) },
      });
      written.push(k);
    } catch (e) { failed.push(k); }
  }
  for (const k of del) {
    try {
      await db.collection(COLL_PRICES).doc(k).remove();
      removed.push(k);
    } catch (e) { failed.push(k); }
  }

  if (failed.length) {
    /* ⚠️ 把失败的是【哪几格】原样带回去，不是只给一个数字。
       客户端要靠它决定回滚哪些 —— 写了的那几格回滚等于把已经存好的
       值从界面上抹掉，下一次 refresh 之前老板看到的就是假的。 */
    return {
      ok: false, reason: 'partial', failed,
      written: written.length, removed: removed.length,
    };
  }

  console.log('[savePrices]', JSON.stringify({ set: written.length, del: removed.length }));
  return { ok: true, written: written.length, removed: removed.length };
};
