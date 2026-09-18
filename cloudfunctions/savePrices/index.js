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

  const written = [], removed = [], failed = [], errors = [];

  /* 把【真正的报错】留下来。只 push 一个 key 的话，「一格都没写进去」
     在返回值里和云函数日志里都只表现为「失败了」，为什么失败一个字都没有 ——
     老板那边看到的是一句「部分时段没存上」，然后谁也查不下去。
     ⚠️ 只留前几条：满屏同样的错误没有更多信息，还会把返回值撑大。 */
  const note = (k, e) => {
    if (errors.length < 3) {
      errors.push(k + ' → ' + ((e && (e.errMsg || e.message)) || String(e)));
    }
  };

  /* ⚠️ 逐格写、逐格删，而且【不整表覆盖】。一格失败不影响别的格 ——
      老板改了 5 格，第 3 格网络抖了一下，另外 4 格该落还是落。
      客户端那边会把失败的那几格标出来（core.js 的 commitPrices
      只回滚这次动过的 key）。 */
  for (const k of setKeys) {
    try {
      /* ⚠️ data 里【不写 _id】。目标记录由 doc(k) 指定，本来就轮不到
         data 再说一遍；而 _id 是不可变的，往替换更新的 data 里塞它会被
         判成「试图修改 _id」而【整条拒绝】—— 于是每一格都失败、返回
         partial，而老板只看到一句「部分时段没存上」，数据库里一个字
         都没有。改价写不进库，就是这一行。

         结论是这么确认的：这一次改的只有两处 —— 去掉这个 _id，和把
         catch 里的异常带出来（note()）。后者只会多给一句话，不可能让
         写入成功。所以真机上「去掉之后就通了」这件事，只可能是它。
         ⚠️ 但服务端的报错原文没有被留下来（那一轮 note() 还没上），
            所以这句结论是排除法得到的，不是抄下来的错误消息。

         `dateKey` 留着：getSchedule 是按它过滤的，_id 前缀做不了索引。 */
      await db.collection(COLL_PRICES).doc(k).set({
        data: { dateKey: k.split('|')[0], price: Number(set[k]) },
      });
      written.push(k);
    } catch (e) { failed.push(k); note(k, e); }
  }
  for (const k of del) {
    try {
      /* ⚠️ 删一个【不存在】的格子不算失败 —— 想要的状态（这格没有改价）
         本来就已经是了。真云上 doc().remove() 对不存在的文档是【抛】的
         （台架量到的原文：document.remove:fail document does not exist），
         于是「恢复规则价」一旦选到几个本来就没改过价的格子，整批就报
         partial 并回滚 —— 老板点的是一个空操作，却收到一句「部分时段
         没存上」。

         ⚠️ 判「在不在」用 get，不用去猜 remove 报错的文案。get 一个不存在
            的文档是【抛】的，这一条是第 0 步在真云上实测过的（errCode -1），
            比新编一个 /does not exist/ 正则可靠。 */
      let exists = true;
      try {
        const d = await db.collection(COLL_PRICES).doc(k).get();
        exists = !!(d && d.data);
      } catch (e) { exists = false; }

      if (exists) await db.collection(COLL_PRICES).doc(k).remove();
      removed.push(k);
    } catch (e) { failed.push(k); note(k, e); }
  }

  if (failed.length) {
    /* ⚠️ 把失败的是【哪几格】原样带回去，不是只给一个数字。
       客户端要靠它决定回滚哪些 —— 写了的那几格回滚等于把已经存好的
       值从界面上抹掉，下一次 refresh 之前老板看到的就是假的。 */
    console.error('[savePrices] 写失败', JSON.stringify(errors));
    return {
      ok: false, reason: 'partial', failed,
      detail: errors.join(' ｜ '),
      written: written.length, removed: removed.length,
    };
  }

  console.log('[savePrices]', JSON.stringify({ set: written.length, del: removed.length }));
  return { ok: true, written: written.length, removed: removed.length };
};
