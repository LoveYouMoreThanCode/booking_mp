/* ══════════════════════════════════════════════════════════════
   createBooking —— 客人下单

   对应 store.js 的 insert。

   ── 这个函数是整套设计的地基 ─────────────────────────────
   「一格一单」靠的是：两个抢同一格的人，两个事务会写同一个
   【已存在】的 occupancy 文档 → 写冲突。⚠️ 不是靠事务里那个「查」——
   云开发只提供快照隔离，官方明说挡不住写偏，读是不加锁的。

   ⚠️ 而且 runTransaction 【不会】自动重试。这是第 0 步实测出来的
      （探针 dev/concurrency-check/）：冲突被直接抛给调用方，
      回调一次都没被重跑。所以下面那个重试环是必须的，不是保险。
      实测 8 并发：1 成功 / 7 被拒 / 0 抛错，最大 attempts 是 2。

   ── 保留 skipped，不整单拒绝 ─────────────────────────────
   冲突的格子剔掉、只下剩下的，把 skipped 一并返回给客户端。
   这条链路上有现成的测试（core.js 的 createBooking、contact.js 的
   「部分时段已不可预约」提示），整单拒绝是对已测试行为的倒退 ——
   客人填完手机号才被告知全废。

   ── 服务端【不做定价】─────────────────────────────────────
   每格多少钱由客户端传来（slotPrices），服务端只做两件事：
   决定哪些格子活下来、把活下来的加起来。规则价怎么算仍然只有
   core.js 一份。items 在这里重新分组，是因为某一段的中间一格可能
   被别人抢走，那一段就得断成两截。

   ⚠️ 这个函数【谁都能调】—— 客人下单本来就不该要身份。
      所以恶意刷单、配额、黑名单一概不管（明确不在范围内）。
      能做的校验只有形状：id 合法、日期像日期、格子数不越界。
   ══════════════════════════════════════════════════════════════ */

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;

const COLL_OCC = 'occupancy';
const COLL_BOOKINGS = 'bookings';

const DATEKEY_RE = /^\d{4}-\d{2}-\d{2}$/;
/* 事务的操作数上限是 100，且随 CONFIG 变。当前最坏情况一单占满整张表
   = 7 天 × 4 场地 × 14 小时里的 56 格（单日）。改 courts / closeHour
   就可能越线（README §七 就是在教人改这个块），所以在门口就拦掉，
   让它【响亮地】失败，而不是撞上云端那个看不懂的上限报错。 */
const MAX_SLOTS = 90;

/* 订单号会被当 _id 用，所以要挡掉奇怪的东西。core.js 生成的是
   'B' + 时间戳36进制 + 3 位随机，形如 Bm1x2y3abc。 */
const ID_RE = /^B[0-9a-z]{4,32}$/;

/* ── 冲突判定：只看文本，不看 errCode ─────────────────────
   实测依据：同一个 errCode -1 既出现在「文档不存在」，也出现在别处；
   冲突是 -501001，而那个码官方描述是笼统的 "resource system error"，
   将来别的资源错误也会落进来。文本里的 TransactionConflict 才说得准。
   官方若改了文案，重试环会【直接抛出】而不是悄悄少重试 —— 响亮地坏。 */
const CONFLICT_RE = /TransactionConflict|TRANSACTION_CONFLICT/;
function isConflict(e) {
  if (!e) return false;
  return CONFLICT_RE.test([e.message, e.errMsg, e.raw].filter(Boolean).join(' '));
}

const RETRY_TRIES = 4;
const sleep = ms => (ms > 0 ? new Promise(r => setTimeout(r, ms)) : Promise.resolve());
/* 退避必须带抖动：几个人同时重试、又都没等到赢家提交的话，
   会反复撞在一起。 */
const backoff = () => sleep(30 + Math.floor(Math.random() * 70));

const occId = (dateKey, ci) => dateKey + '|' + ci;
const parseSlot = k => {
  const [ci, min] = String(k).split('|').map(Number);
  return { ci, min };
};
const slotKey = (ci, min) => ci + '|' + min;

/* ── items 重新分组 ───────────────────────────────────────
   客户端的 items 是「同一场地、连续时段」合并出来的最大段。
   去掉中间被抢走的格子之后，剩下的会在每一段【内部】断成几截 ——
   所以只需要在每段自己的格子里找连续段，不需要重做全局分组
   （那样就得知道 courts 和 slotMin 的配置，等于把配置抄一份）。

   ⚠️ 导出它是为了让本地台架能拿它和 core.js 的 groupSlots 对拍 ——
      两份实现必须有测试钉在一起，否则迟早走偏。 */
function regrowItems(items, alive, slotPrices, gap) {
  const out = [];
  (items || []).forEach(it => {
    const mins = [];
    for (let m = it.from; m < it.to; m += gap) {
      if (alive[slotKey(it.ci, m)]) mins.push(m);
    }
    if (!mins.length) return;

    let start = mins[0], prev = mins[0];
    for (let i = 1; i <= mins.length; i++) {
      const cur = mins[i];
      if (i < mins.length && cur === prev + gap) { prev = cur; continue; }
      let price = 0;
      for (let m = start; m <= prev; m += gap) price += Number(slotPrices[slotKey(it.ci, m)]) || 0;
      out.push({ ci: it.ci, court: it.court, from: start, to: prev + gap, price });
      start = prev = cur;
    }
  });
  return out;
}

/** 开事务之前确保占用文档存在。
    为什么放在事务【外面】：事务里「往一个还不存在的文档上写」算不算
    冲突，官方文档没写 —— 这是整套设计的地基，不该悬空。放到外面之后，
    事务碰的每一个文档都已知存在。 */
async function ensureOccupancy(dateKey, cis) {
  for (const ci of cis) {
    try {
      await db.collection(COLL_OCC).add({ data: { _id: occId(dateKey, ci), slots: {} } });
    } catch (e) {
      /* 已经存在正是我们要的结果。别的错也吞掉：真出事的话，
         下面事务里 get 不到文档会以 state-unknown 中止。 */
    }
  }
}

exports.main = async (event = {}) => {
  const b = event.booking || {};
  const slotPrices = event.slotPrices || {};
  const gap = Number(event.gap) || 60;

  /* ── 形状校验。全部在门口做完，事务里只剩下真正要原子的那部分 ── */
  if (typeof b.id !== 'string' || !ID_RE.test(b.id)) return { ok: false, reason: 'bad-id' };
  if (typeof b.dateKey !== 'string' || !DATEKEY_RE.test(b.dateKey)) return { ok: false, reason: 'bad-date' };
  if (!Array.isArray(b.slotKeys) || !b.slotKeys.length) return { ok: false, reason: 'no-slots' };
  if (b.slotKeys.length > MAX_SLOTS) return { ok: false, reason: 'too-many-slots' };
  if (typeof b.phone !== 'string' || b.phone.length < 5 || b.phone.length > 30) {
    return { ok: false, reason: 'bad-phone' };
  }

  const wanted = [];
  for (const k of b.slotKeys) {
    const { ci, min } = parseSlot(k);
    if (!Number.isInteger(ci) || !Number.isInteger(min) || ci < 0 || min < 0) {
      return { ok: false, reason: 'bad-slot' };
    }
    wanted.push({ ci, min, key: slotKey(ci, min) });
  }

  const cis = Array.from(new Set(wanted.map(w => w.ci))).sort((a, x) => a - x);

  await ensureOccupancy(b.dateKey, cis);

  /* ── 事务 + 重试环 ────────────────────────────────────── */
  let verdict = null;
  for (let attempt = 1; ; attempt++) {
    try {
      verdict = await db.runTransaction(async transaction => {
        const slotsByCi = {};
        for (const ci of cis) {
          /* ⚠️ 两种形状都要兜住：真云上 get 一个【不存在】的 doc 是【抛错】的
             （实测 errCode -1，而且那个码并不专属于「不存在」），但各版本
             SDK 的行为不一致，所以「返回空」那条也一并接住。
             本地台架（dev/booking-tx）量到的就是抛错这条 —— 只写 if (!data)
             的话，这个分支在真机上根本不会被执行，reason 会退化成笼统的 error。 */
          let doc;
          try {
            doc = await transaction.collection(COLL_OCC).doc(occId(b.dateKey, ci)).get();
          } catch (e) {
            return { ok: false, reason: 'state-unknown' };
          }
          const data = doc && doc.data;
          /* ⚠️ get 不到 = 「状态未知」，绝不是「全空」。
             刚被 clearAll 删掉就是这个样子 —— 这时当成全空会把
             一格一单的不变量直接打破。 */
          if (!data) return { ok: false, reason: 'state-unknown' };
          slotsByCi[ci] = data.slots || {};
        }

        const alive = {}, skipped = [];
        wanted.forEach(w => {
          const taken = slotsByCi[w.ci][String(w.min)];
          if (taken && taken !== b.id) skipped.push({ ci: w.ci, min: w.min });
          else alive[w.key] = true;
        });

        if (!Object.keys(alive).length) {
          return { ok: false, reason: 'all-taken', skipped };
        }

        /* 先写占用：这一笔才是让并发冲突落到【同一个物理文档】上的那一下 */
        for (const ci of cis) {
          const next = Object.assign({}, slotsByCi[ci]);
          wanted.forEach(w => { if (w.ci === ci && alive[w.key]) next[String(w.min)] = b.id; });
          await transaction.collection(COLL_OCC).doc(occId(b.dateKey, ci))
            .update({ data: { slots: next } });
        }

        const items = regrowItems(b.items, alive, slotPrices, gap);
        const total = items.reduce((s, it) => s + it.price, 0);
        const now = Date.now();

        const stored = {
          id: b.id,                       // _id 和业务 id 始终是同一个值
          dateKey: b.dateKey,
          items,
          slotKeys: wanted.filter(w => alive[w.key]).map(w => w.key),
          phone: b.phone,
          name: typeof b.name === 'string' ? b.name : '',
          note: typeof b.note === 'string' ? b.note : '',
          total,
          /* status 由服务端写死，不信客户端传来的 —— 否则有人可以
             直接下单成 confirmed。createdAt 同理，用它排列表。 */
          status: 'pending',
          reply: '',
          createdAt: now,
          updatedAt: now,
        };

        await transaction.collection(COLL_BOOKINGS).add({ data: Object.assign({ _id: b.id }, stored) });
        return { ok: true, booking: stored, skipped };
      });
      break;
    } catch (e) {
      if (isConflict(e) && attempt < RETRY_TRIES) { await backoff(); continue; }
      /* 重试耗尽、或者根本不是冲突 —— 都抛出去。调用方看到的是失败，
         绝不会是「假装成功」。 */
      return {
        ok: false,
        reason: isConflict(e) ? 'busy' : 'error',
        detail: (e && e.message) || String(e),
      };
    }
  }

  const unwrapped = verdict && typeof verdict === 'object' && 'result' in verdict
    ? verdict.result : verdict;

  if (!unwrapped || !unwrapped.ok) {
    return { ok: false, reason: (unwrapped && unwrapped.reason) || 'unknown',
             skipped: (unwrapped && unwrapped.skipped) || [] };
  }

  console.log('[createBooking]', JSON.stringify({
    id: b.id, dateKey: b.dateKey, wanted: wanted.length,
    took: unwrapped.booking.slotKeys.length, skipped: unwrapped.skipped.length,
  }));

  return { ok: true, booking: unwrapped.booking, skipped: unwrapped.skipped };
};

/* 只给本地台架对拍用（见 regrowItems 上面的说明） */
exports._regrowItems = regrowItems;
exports._isConflict = isConflict;
