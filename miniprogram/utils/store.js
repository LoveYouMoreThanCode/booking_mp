/* ══════════════════════════════════════════════════════════════
   utils/store.js —— 数据存取层（后端可换）

   这一层【不持有任何内存数据】，只是传输：读本地镜像、往本地/远端写。
   业务逻辑和页面读的一律是 core.js 里的内存缓存，不是这里。

   ── 后端可换，开关在文件下半部分 ────────────────────────────
     const backend = cloudBackend;    ← 出货配置（本地后端只在测试里用）
   两个后端实现同一个接口，页面和 core.js 一行都不用动。

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

  /* 整表覆盖。现在只剩「清空数据」在用它。
     单条订单的增改走 insert / update —— 云端那两条各对应一次云函数调用，
     而整表替换会用一台手机的数据盖掉所有人的。 */
  replaceBookings(list) {
    return settleNow(() => {
      wx.setStorageSync(STORE_KEY, list || []);
      return list || [];
    });
  },

  /* 和云函数同一个契约：diff = { set: {格子key: 价格}, del: [格子key] }，
     逐格增删，【不整表覆盖】。原来收的是整张 map —— 那样两个管理员
     同时改价会互相抹掉，谁都不会发现。 */
  savePrices(diff) {
    return settleNow(() => {
      const d = diff || {};
      const map = readMap(PRICE_KEY);
      Object.keys(d.set || {}).forEach(k => { map[k] = d.set[k]; });
      (d.del || []).forEach(k => { delete map[k]; });
      wx.setStorageSync(PRICE_KEY, map);
      return map;
    });
  },

  /* 清空。云端版是一次云函数调用（顺序在那边写死），本地这边就是
     把那两个键抹掉。签名对齐是为了 cloudBackend 能顶上同一个位置。 */
  clearAll() {
    return settleNow(() => {
      wx.setStorageSync(STORE_KEY, []);
      wx.setStorageSync(PRICE_KEY, {});
      return true;
    });
  },

  /* 下面两个是「按需写」，2b 阶段启用：只动一条订单，不重写整张表。
     云端版对应一次云函数调用。 */
  /* ⚠️ 返回的是 {ok, booking}，不是订单对象本身 —— 两个后端必须是
     同一个契约，否则 core.js 那边得按「用的是哪个后端」分两套读法，
     而在本地永远测不出云端那条分支。

     这里【不返回 skipped】：本地后端没有服务端的视角，它看不到
     「事务里又发现了几个被抢的格子」。core 那边 res.skipped 为空
     就退回用客户端自己算的那份 —— 那是本地后端唯一说得准的东西。 */
  insert(b) {
    return settleNow(() => {
      const list = readArr(STORE_KEY);
      list.push(b);
      wx.setStorageSync(STORE_KEY, list);
      return { ok: true, booking: b };
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

/* ── 云端后端 ────────────────────────────────────────────
   和本地后端的唯一区别：这些方法【异步】settle —— 网络回来才交付。
   页面代码一行都不用改，因为它们早就写成「事情放在 done 里」了。

   每个方法对应一个云函数（名字写在下面，别改错：
   insert 打的是 createBooking，不是 insertBooking）。 */

/**
 * 把 wx.cloud 的 Promise 适配成 task。
 *
 * ⚠️ 这是全项目【唯一】碰 Promise 的地方，而且 Promise 到这儿为止 ——
 *    它绝不会漏进 core.js 或页面。原因见文件顶部：测试跑在 jsc 上，
 *    未处理的 Promise 拒绝在那里是「静默 exit 0」，断言失败会变成
 *    「假装通过」。这里 .then / .catch 两条路都通到 t.settle，没有第三种。
 */
function callCloud(name, data) {
  const t = makeTask();
  wx.cloud.callFunction({ name, data })
    .then(r => {
      const res = r && r.result;
      /* ⚠️ 临时的（第 3 步删）。云函数说「不行」时，本地什么痕迹都没有 ——
         页面该弹的提示由调用方决定，但【为什么不行】只有这里有。 */
      if (res && res.ok === false && typeof console !== 'undefined' && console.warn) {
        console.warn('[cloud] ' + name + ' 回了 ok:false → ' + res.reason
          + (res.detail ? '（' + res.detail + '）' : ''));
      }
      t.settle(null, res);
    })
    .catch(e => t.settle(e));
  return t;
}

/* 写方法专用的收尾：云函数回 ok:false 时，把它变成一次【失败】。

   ⚠️ 少了这一步，云函数说「不行」会被当成【成功】。这是真出过的 bug：
      改价返回 forbidden，页面照样弹「已改 3 个时段」，数据库里一个字都没有 ——
      老板只能自己发现价格没变，而且【没改的那些格和改过的长得一模一样】。
      凡是「写」的路径，都不能把 ok:false 当成功往下放。

   ⚠️ insert 是唯一的例外，它走的还是 callCloud。因为它失败时带着
      `skipped`（哪几格被抢走了）—— 那是要交给客人的业务数据，不是错误
      信息，core.js 的 createBooking 专门读它。契约不同是故意的，
      不是漏改；这里留个记号，免得下次有人「顺手统一」把它改掉。 */
function callCloudWrite(name, data) {
  const out = makeTask();
  callCloud(name, data)
    .done(res => {
      const bad = unwrapCloud(res);
      if (bad) out.settle(bad); else out.settle(null, res);
    })
    .fail(e => out.settle(e));
  return out;
}

/* 云函数用 ok:false 表达「我跑通了，但这事办不成」（比如日期参数不合法）。
   那不是网络错误，但也不能当成成功往下走 —— 统一在这儿变成一次失败，
   免得每个调用方都自己判一遍。 */
function unwrapCloud(res) {
  if (res && res.ok) return null;          // ← 成功必须是 null，调用方靠真假判
  const reason = (res && res.reason) || 'unknown';
  /* detail 是云函数给的可读原因（比如「哪张集合读不到」）。
     它只进控制台，不进界面 —— 这些是搭建期的错，给开发看的，
     客人看了也没用。失败时 core 那条 console.warn 会把它带出来。 */
  const detail = (res && res.detail) || '';
  const e = new Error('云函数返回 ok:false: ' + reason + (detail ? ' —— ' + detail : ''));
  e.cloudReason = reason;
  e.cloudDetail = detail;
  /* 「恢复」被拒时要告诉老板是哪几格被占了，所以把明细带上。
     core.js 的 errText() 负责把它翻成人话。 */
  e.cloudTaken = (res && res.taken) || [];
  /* savePrices 部分失败时，告诉调用方【哪几格】没写进去 —— 它要靠
     这个决定回滚哪些，而不是把写成功的也一起回滚掉。 */
  e.cloudFailed = (res && res.failed) || [];
  return e;
}

const cloudBackend = {
  /**
   * 取数。opts = { dateKeys: [...], passcode: '' }
   *
   * ⚠️ 成功之后要把结果【写回本地 storage】—— 这是「两段式」在云端
   *    真正兑现的地方：下次冷启动时 readCache() 读到的就是这一次的快照，
   *    第一屏立刻有内容，不用等网络。
   *
   * ⚠️ 失败时【不写镜像】。宁可留着上一次的，也别用一份空的盖掉它。
   */
  fetchAll(opts) {
    const out = makeTask();
    callCloud('getSchedule', opts || {})
      .done(res => {
        const bad = unwrapCloud(res);
        if (bad) { out.settle(bad); return; }
        const bookings = res.bookings || [];
        const prices = res.prices || {};

        /* ⚠️ 临时的（第 3 步删）。接云这一段里，「成功但结果不对」和
           「压根没成功」在界面上长得一模一样 —— 都是一屏空。失败那边
           有 core.js 的 console.warn 兜着，成功这边原来一个字都不打，
           于是「回 ok:true 但 0 条」这种最像偶发的错完全无声。
           把【问了什么、回来什么】打出来，这一整类问题就不用猜了。 */
        if (typeof console !== 'undefined' && console.info) {
          console.info('[getSchedule] 问了 ' + ((opts && opts.dateKeys) || []).join(' ')
            + ' → 回来 ' + bookings.length + ' 单 / ' + Object.keys(prices).length + ' 个改价'
            + ' / isAdmin=' + (res.isAdmin === true)
            /* anyBookings 只在「一条都没查到」时才有值（云函数那边有说明）。
               true = 记录在库里但日期对不上；false = 库里压根没有单。 */
            + (res.anyBookings === null || res.anyBookings === undefined
                ? '' : ' / 库里有没有单=' + res.anyBookings)
            + (res.shape ? ' / 那条长这样=' + JSON.stringify(res.shape) : ''));
        }

        try {
          wx.setStorageSync(STORE_KEY, bookings);
          wx.setStorageSync(PRICE_KEY, prices);
        } catch (e) {
          /* 镜像写不进去（存储满了之类）不该让这次取数失败 ——
             数据已经在手上，页面照样能画。下次冷启动才会没东西可读。 */
        }
        out.settle(null, { bookings, prices });
      })
      .fail(e => out.settle(e));
    return out;
  },

  /* ⚠️ 注意 insert 打的是 createBooking，不是 insertBooking。
     extra 是「下单要用的、但不属于订单本身」的东西：每格的价钱，
     以及时段粒度。分成两个参数是故意的 —— 订单对象原样进库，
     不掺运行时用的字段。 */
  insert(b, extra) {
    return callCloud('createBooking', Object.assign({ booking: b }, extra || {}));
  },

  /* 后三个是管理端操作，必须带上口令 —— 鉴权在云函数里做，
     客户端只是把口令【在真解锁之后】发出去（见 core.js 的 adminPasscode）。

     ⚠️ 三个都走 callCloudWrite（不是 callCloud）：它们的调用方都是
        「成功了就弹一句已办妥、失败了才回滚」，把 ok:false 放过去
        就等于报假成功。见上面 callCloudWrite 的说明。 */
  update(id, patch, passcode) {
    return callCloudWrite('updateBooking', { id, patch, passcode });
  },

  /* diff = { set: {格子key: 价格}, del: [格子key] }
     ⚠️ 发的是【被改动的那几格】，不是整张价格表 —— 整表覆盖会把
        另一个管理员同时改的别的格子一起抹掉，而且谁都不会发现。 */
  savePrices(diff, passcode) {
    const d = diff || {};
    return callCloudWrite('savePrices', { set: d.set || {}, del: d.del || [], passcode });
  },

  /* 清空三张集合，一次调用。顺序在云函数里写死（occupancy → bookings
     → prices），客户端管不着也不该管。 */
  clearAll(passcode) {
    return callCloudWrite('clearAll', { passcode });
  },
};

/* ── 后端开关 ────────────────────────────────────────────
   ⚠️ 这一行是整套东西的总闸。谁把它改回 localBackend，整个项目会
      【静默退回单机版】：功能看着一切正常，只是客人的订单老板永远
      收不到。没有任何别的断言能发现这种回退 —— smoke.js 末尾有一条
      静态断言直接读这行源码盯着它。 */
let backend = cloudBackend;

const _backends = { localBackend, cloudBackend };

/* 测试专用：把整套断言切回本地后端。
   为什么必须能切：本地后端【同步】settle，这是 smoke.js 能在 jsc 里
   一路同步跑完的前提（云端后端是异步的，几百条断言没法那么写）。
   ⚠️ 它切的是「用哪个后端」这个配置指针，不是数据 —— 「store 不存状态」
      那条规矩说的是数据，没被破坏。下划线开头 = 产品代码不许碰。 */
function _useBackend(b) { backend = b; }

module.exports = {
  readCache,
  makeTask,       // core 要自己造 task（拼业务结果、串两次写），见下面的说明
  fetched,
  fetchAll:         opts        => backend.fetchAll(opts),
  insert:           (b, extra)         => backend.insert(b, extra),
  update:           (id, patch, code)  => backend.update(id, patch, code),
  replaceBookings:  list               => backend.replaceBookings(list),
  savePrices:       (diff, code)       => backend.savePrices(diff, code),
  clearAll:         code               => backend.clearAll(code),
  _backends,
  _useBackend,
};
