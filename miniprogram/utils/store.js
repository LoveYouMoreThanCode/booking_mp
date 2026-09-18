/* ══════════════════════════════════════════════════════════════
   utils/store.js —— 数据存取层（后端可换）

   这一层【不持有任何内存数据】，只是传输：读本地镜像、往本地/远端写。
   业务逻辑和页面读的一律是 core.js 里的内存缓存，不是这里。

   ── 换云开发只改一行 ──────────────────────────────────────────
     const backend = localBackend;    →    const backend = cloudBackend;
   下面有一个写好注释的 cloudBackend 草稿，页面一行都不用动。

   ── task 契约（页面必须遵守）────────────────────────────────
   每个查询返回一个小对象，有 .done(fn) / .fail(fn)：

     · 本地后端在 .done() 注册的那一刻【同步】回调 —— 数据本来就在手边
     · 云端后端【异步】回调 —— 网络回来才 settle

   所以「拿到数据之后要做的事」必须写在 done 里，
   【绝不能】写在 .done() 的下一行：

       对的：  core.refresh(() => this.repaint());
       错的：  core.refresh();
               this.repaint();     // 本地能跑，云端必崩，且本地测不出来

   测试全程同步，靠的就是「本地后端同步回调」这条性质；
   smoke.js 里有一条断言专门盯着它（有人把本地后端改成 setTimeout 式
   会立刻红在 exit 3，而不是悄悄让整套断言变成假绿）。

   ⚠️ 为什么不用 Promise：这个项目的测试跑在 macOS 自带的 jsc 上，
      未处理的 Promise 拒绝在 jsc 里是「静默 exit 0」—— 断言失败会
      变成「假装通过」。任务对象没有这个问题。
   ══════════════════════════════════════════════════════════════ */

const STORE_KEY = 'mp_bookings_v1';

/* ⚠️ 价格表是 v2。v1 存的是「半小时价」（key 里的 min 是 1080/1110 这种
   半小时刻度）。计价粒度改成 1 小时以后，那些值会被当成「小时价」读出来 ——
   老板改过的 ¥45 会变成整个小时 ¥45，静默打对折。换键等于把旧值丢掉，
   让价格回到规则价，比悄悄算错强。客人订单【不受影响】：旧订单的第一格
   永远落在整点上（客人只能整小时订），照样能查到、照样挡得住。 */
const PRICE_KEY = 'mp_prices_v2';

/* ── task ──────────────────────────────────────────────── */

/* 一个「将来会有」的结果。后端内部用 settle() 交付，
   页面用 done()/fail() 注册。已 settle 之后再注册也会立刻补发，
   所以两条路径都不会漏。 */
function makeTask() {
  let settled = false, failed = false, value, error;
  const onDone = [], onFail = [];

  const t = {
    settle(err, v) {
      if (settled) return;                  // 只交付一次
      settled = true;
      failed = !!err;
      value = v;
      error = err;
      const fire = failed ? onFail : onDone;
      const drop = failed ? onDone : onFail;
      drop.length = 0;                      // 另一条路的回调不再可能触发
      fire.forEach(fn => fn(failed ? error : value));
      fire.length = 0;
    },
    done(fn) {
      if (settled) { if (!failed) fn(value); } else onDone.push(fn);
      return t;
    },
    fail(fn) {
      if (settled) { if (failed) fn(error); } else onFail.push(fn);
      return t;
    },
  };
  return t;
}

/** 一个已经 settle 的 task（core 自己拼业务结果时用） */
function fetched(err, v) {
  const t = makeTask();
  t.settle(err, v);
  return t;
}

/* ── core 为什么要拿到 makeTask ──────────────────────────
   因为一个业务写操作【不等于】一次存储写：

     createBooking  = 内存里先加订单（界面立刻能看，乐观写入）
                      + store.insert
                      + 失败时把订单摘掉

   结果要等 store.insert 回来才知道，所以 core 得自己造一个 task，
   在 store 的 done/fail 里 settle 它。业务层因此对外仍然只是
   「返回一个 task」，页面看不出中间串了几次写。 */

/**
 * 本地后端专用：调用即执行，`.done()` 注册的那一刻同步回调。
 *
 * ⚠️ 这里把【写失败】变成 .fail，而不是像以前那样 try/catch 吞掉 ——
 *    否则「落库失败要回滚内存里的乐观订单」这件事根本没法测。
 *    （读失败仍然吞：读不到就是「还没有数据」，是正常状态。）
 */
function settleNow(run) {
  const t = makeTask();
  try { t.settle(null, run()); } catch (e) { t.settle(e); }
  return t;
}

/* ── 读本地镜像（同步）───────────────────────────────────
   冷启动第一屏靠它：模块加载时同步读出上一次的快照，
   所以页面第一次 buildGrid() 就有价格、有待/满状态，不用等网络。
   接云开发后这里【仍然读本地】—— 云端结果由 refresh 补上。 */

function readArr(key) {
  try {
    const v = wx.getStorageSync(key);
    return Array.isArray(v) ? v : [];
  } catch (e) { return []; }
}

function readMap(key) {
  try {
    const v = wx.getStorageSync(key);
    // 存坏了（null / 数组 / 字符串）就当没有，别让脏数据把改价页搞崩
    return (v && typeof v === 'object' && !Array.isArray(v)) ? v : {};
  } catch (e) { return {}; }
}

function readCache() {
  return { bookings: readArr(STORE_KEY), prices: readMap(PRICE_KEY) };
}

/* ── 本地后端 ────────────────────────────────────────────
   它就是 storage。方法全部【无状态】：每次重新读一遍再写回去，
   所以这里不缓存任何东西（「store 不存状态」是重开 App 测试成立的前提）。 */

const localBackend = {
  fetchAll() {
    return settleNow(() => ({
      bookings: readArr(STORE_KEY),
      prices: readMap(PRICE_KEY),
    }));
  },

  /* 整表覆盖。2a 阶段所有写都走它，行为与原来的 writeStore() 完全一致。 */
  replaceBookings(list) {
    return settleNow(() => {
      wx.setStorageSync(STORE_KEY, list || []);
      return list || [];
    });
  },

  savePrices(map) {
    return settleNow(() => {
      wx.setStorageSync(PRICE_KEY, map || {});
      return map || {};
    });
  },

  /* 下面两个是「按需写」，2b 阶段启用：只动一条订单，不重写整张表。
     云端版对应一次云函数调用。 */
  insert(b) {
    return settleNow(() => {
      const list = readArr(STORE_KEY);
      list.push(b);
      wx.setStorageSync(STORE_KEY, list);
      return b;
    });
  },

  update(id, patch) {
    return settleNow(() => {
      const list = readArr(STORE_KEY);
      const b = list.find(x => x.id === id);
      if (!b) throw new Error('订单不存在: ' + id);
      Object.assign(b, patch);
      wx.setStorageSync(STORE_KEY, list);
      return b;
    });
  },
};

/* ── 云端后端（还没写，接口形状先摆在这儿）─────────────────
   写它的时候唯一要注意的：这些方法必须【异步】settle，
   也就是在网络回来之后再调 t.settle()。页面代码不用改，
   因为页面已经写成「事情放在 done 里」了。

const cloudBackend = {
  fetchAll()         { return callCloud('listBookings'); },
  insert(b)          { return callCloud('createBooking', b); },
  update(id, patch)  { return callCloud('updateBooking', { id, patch }); },
  replaceBookings(l) { return callCloud('replaceBookings', l); },
  savePrices(map)    { return callCloud('savePrices', map); },
};

   callCloud 长这样（到时候再加）：

function callCloud(name, data) {
  const t = makeTask();
  wx.cloud.callFunction({ name, data })
    .then(r => t.settle(null, r.result))
    .catch(e => t.settle(e));
  return t;          // ← 注意：这里是异步 settle，页面照样只管在 done 里做事
}
   ──────────────────────────────────────────────────────── */

const backend = localBackend;   // ← 接云开发时只改这一行

module.exports = {
  readCache,
  makeTask,       // core 要自己造 task（拼业务结果、串两次写），见下面的说明
  fetched,
  fetchAll:         ()          => backend.fetchAll(),
  insert:           b           => backend.insert(b),
  update:           (id, patch) => backend.update(id, patch),
  replaceBookings:  list        => backend.replaceBookings(list),
  savePrices:       map         => backend.savePrices(map),
};
