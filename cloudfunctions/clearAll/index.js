/* ══════════════════════════════════════════════════════════════
   clearAll —— 清空三张集合

   对应 store.js 的 clearAll（core.js 的 clearAllData 调它）。

   ── 为什么不是一个事务 ────────────────────────────────────
   两个独立的理由，任何一个都够：
     ① 会超过事务 100 次操作的上限
     ② 事务里【不能写 where 查询】—— 连「要删哪些」都枚举不出来

   所以只能分三次删，而三段的顺序是【硬性】的：

     先占 → 后单，中途断：客人看到一片空，管理端看到一堆挡不住任何
                          东西的订单。界面不对，但再点一次「清空」
                          就能收拾干净。
     先单 → 后占，中途断：占用文档还在，每个都指着一个已经不存在的
                          订单，所有格子永远显示「满」，而管理端没有
                          任何订单可以取消。【界面上救不回来】，而且
                          操作的人没有理由怀疑需要再清一次。

   所以写死：occupancy → bookings → prices。

   ⚠️ 管理端操作，必须过鉴权。而且它比另外两个更该紧张 ——
      这是唯一一个能把整库抹掉的接口。见下面的 isAdmin。
   ══════════════════════════════════════════════════════════════ */

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;

const COLL_OCC = 'occupancy';
const COLL_BOOKINGS = 'bookings';
const COLL_PRICES = 'prices';

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

/** 删掉一张集合的全部文档。空集合不算失败（第二次点「清空」是正常的）。 */
async function wipe(coll) {
  const r = await db.collection(coll).where({ _id: _.exists(true) }).remove();
  return (r && r.stats && r.stats.removed) || 0;
}

exports.main = async (event = {}) => {
  const openid = (cloud.getWXContext() || {}).OPENID || '';
  if (!isAdmin(event, openid)) return { ok: false, reason: 'forbidden' };

  const done = { occupancy: 0, bookings: 0, prices: 0 };
  const order = [
    ['occupancy', COLL_OCC],
    ['bookings', COLL_BOOKINGS],
    ['prices', COLL_PRICES],
  ];

  for (const [label, coll] of order) {
    try {
      done[label] = await wipe(coll);
    } catch (e) {
      /* 停在这儿，不往下删 —— 顺序是硬性的，跳过一张继续删会让状态
         变成上面说的第二种（最难收拾的那种）。返回已经删了什么。 */
      return {
        ok: false,
        reason: 'partial',
        detail: label + ': ' + ((e && e.message) || e),
        done,
      };
    }
  }

  console.log('[clearAll]', JSON.stringify(done));
  return { ok: true, done };
};
