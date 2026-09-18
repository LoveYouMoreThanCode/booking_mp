/* ══════════════════════════════════════════════════════════════
   updateBooking —— 老板改订单状态（确认 / 取消 / 恢复）

   对应 store.js 的 update。

   ── 「恢复」为什么必须搬进这里 ─────────────────────────────
   orders.js 原来是在【客户端内存】里查那些格子有没有被重新订走。
   上云之后那两个管理员各拿一份过期的列表，可以同时把一单恢复到一个
   已经被占的格子上 —— 「一格一单」的不变量当场就没了。
   所以占用检查、状态断言、占用表更新，三件事必须在同一个事务里。

   从「已取消」恢复 = 重新占坑；改成「已取消」= 放坑。占用表里存的
   是 min → 订单号，所以「这坑是不是我的」是可以判的。

   ⚠️ 这是【管理端】操作，必须过鉴权。见下面的 isAdmin。
   ══════════════════════════════════════════════════════════════ */

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

const COLL_OCC = 'occupancy';
const COLL_BOOKINGS = 'bookings';

const STATUSES = ['pending', 'confirmed', 'cancelled'];
const PENDING = 'pending', CANCELLED = 'cancelled';

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

/* ── 冲突判定：只看文本，不看 errCode ─────────────────────
   实测依据见 createBooking 里的同一段说明。 */
const CONFLICT_RE = /TransactionConflict|TRANSACTION_CONFLICT/;
function isConflict(e) {
  if (!e) return false;
  return CONFLICT_RE.test([e.message, e.errMsg, e.raw].filter(Boolean).join(' '));
}

const RETRY_TRIES = 4;
const sleep = ms => (ms > 0 ? new Promise(r => setTimeout(r, ms)) : Promise.resolve());
const backoff = () => sleep(30 + Math.floor(Math.random() * 70));

const occId = (dateKey, ci) => dateKey + '|' + ci;

exports.main = async (event = {}) => {
  const openid = (cloud.getWXContext() || {}).OPENID || '';
  if (!isAdmin(event, openid)) return { ok: false, reason: 'forbidden' };

  const id = event.id;
  const patch = event.patch || {};
  if (typeof id !== 'string' || !id) return { ok: false, reason: 'bad-id' };
  if (STATUSES.indexOf(patch.status) < 0) return { ok: false, reason: 'bad-status' };
  if (patch.reply !== undefined && typeof patch.reply !== 'string') {
    return { ok: false, reason: 'bad-reply' };
  }

  const wantHeld = patch.status !== CANCELLED;

  let verdict = null;
  for (let attempt = 1; ; attempt++) {
    try {
      verdict = await db.runTransaction(async transaction => {
        let doc;
        try {
          doc = await transaction.collection(COLL_BOOKINGS).doc(id).get();
        } catch (e) {
          /* ⚠️ 云数据库里 get 一个不存在的 doc 是【抛错】的，实测 errCode
             是 -1，而且那个码并不专属于「不存在」。所以这里不判码，
             直接把「取不到」当成订单不在。 */
          return { ok: false, reason: 'not-found' };
        }
        const b = doc && doc.data;
        if (!b) return { ok: false, reason: 'not-found' };

        const cis = Array.from(new Set((b.slotKeys || []).map(k => Number(k.split('|')[0]))))
          .filter(n => Number.isInteger(n)).sort((a, x) => a - x);

        const slotsByCi = {};
        for (const ci of cis) {
          /* ⚠️ 两种形状都要兜住：真云上 get 一个【不存在】的 doc 是【抛错】的
             （实测 errCode -1），但各版本 SDK 行为不一致，「返回空」那条
             也一并接住。本地台架（dev/booking-tx）量到的就是抛错这条。 */
          let d;
          try {
            d = await transaction.collection(COLL_OCC).doc(occId(b.dateKey, ci)).get();
          } catch (e) {
            return { ok: false, reason: 'state-unknown' };
          }
          const data = d && d.data;
          /* 占用文档不见了 = 状态未知，不是「全空」。
             当成全空会让恢复动作把别人正在占的坑直接盖掉。 */
          if (!data) return { ok: false, reason: 'state-unknown' };
          slotsByCi[ci] = data.slots || {};
        }

        /* 要恢复（重新占坑）时，先把每一格查一遍：被【别人】占着就整笔拒绝。
           自己的单占着自己的格子是正常的（pending → confirmed 就是这种）。 */
        const taken = [];
        if (wantHeld) {
          (b.slotKeys || []).forEach(k => {
            const [ci, min] = k.split('|').map(Number);
            const holder = slotsByCi[ci][String(min)];
            if (holder && holder !== id) taken.push({ ci, min });
          });
          if (taken.length) return { ok: false, reason: 'slot-taken', taken };
        }

        for (const ci of cis) {
          const next = Object.assign({}, slotsByCi[ci]);
          (b.slotKeys || []).forEach(k => {
            const [kci, min] = k.split('|').map(Number);
            if (kci !== ci) return;
            if (wantHeld) next[String(min)] = id;
            else if (next[String(min)] === id) delete next[String(min)];
            /* 取消时如果坑已经被别人占了（不该发生，但真发生了也）
               别动它 —— 删掉等于替别人放坑。 */
          });
          await transaction.collection(COLL_OCC).doc(occId(b.dateKey, ci))
            .update({ data: { slots: next } });
        }

        const changes = { status: patch.status, updatedAt: Date.now() };
        if (patch.reply !== undefined) changes.reply = patch.reply;
        await transaction.collection(COLL_BOOKINGS).doc(id).update({ data: changes });

        return { ok: true, id, status: patch.status, released: !wantHeld };
      });
      break;
    } catch (e) {
      if (isConflict(e) && attempt < RETRY_TRIES) { await backoff(); continue; }
      return {
        ok: false,
        reason: isConflict(e) ? 'busy' : 'error',
        detail: (e && e.message) || String(e),
      };
    }
  }

  const r = verdict && typeof verdict === 'object' && 'result' in verdict ? verdict.result : verdict;
  if (!r || !r.ok) {
    return {
      ok: false,
      reason: (r && r.reason) || 'unknown',
      taken: (r && r.taken) || [],
    };
  }

  console.log('[updateBooking]', JSON.stringify({ id, status: patch.status, released: r.released }));
  return { ok: true, id };
};

exports._isConflict = isConflict;
