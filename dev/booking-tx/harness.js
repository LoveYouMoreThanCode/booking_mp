/* ══════════════════════════════════════════════════════════════
   harness.js —— 在本地把四个「写路径」云函数跑起来

   覆盖 createBooking / updateBooking / savePrices / clearAll。这四个是
   同一套东西的四面：都只在真云上跑过才作数，而它们各自都有一类
   【在真机上看起来只是没反应】的错：

     createBooking  · skipped 子集算错 → 客人的单少了半小时还显示成功
                    · 把「占用文档不在」当成「全空」→ 一格一单当场破
                    · 重试环没接住冲突 → 并发时一单都下不进来
     updateBooking  · 恢复时不查占用 → 两单占同一格（第 2 步的核心风险）
                    · 取消时把【别人】的坑一起删了 → 客人莫名丢时段
     savePrices     · 把异常吞了，只说「失败」不说【为什么】→ 真机上
                      只能拿到一句「部分时段没存上」，查不下去
                    · 删一个本来就没有的格子算成失败 → 「恢复规则价」
                      选到几个没改过价的格子就整批回滚（空操作报错）
     clearAll       · 顺序反了 → 中途断掉之后界面上救不回来

   ⚠️ 它【不能】替代真机那一次。真云的事务怎么加锁、往不存在的文档上写
      算不算冲突、runTransaction 返回什么形状 —— 那些是云端的实现细节，
      假 db 还原不出来。这个台架做的是另一件事：**在花掉一次真机往返之前，
      把这些函数里的分支走一遍**，让「变量名打错」这种错在本地就红掉。

   跑法：./dev/booking-tx/run.sh

   ⚠️ 成败是【印在输出里】的，不体现在退出码上 —— jsc 里未处理的 Promise
      拒绝是静默 exit 0。看最后那行「通过 N / 失败 M」。
   ══════════════════════════════════════════════════════════════ */

var IS_NODE = (typeof process !== 'undefined' && process.versions && process.versions.node);
if (IS_NODE) {
  var fs = require('fs');
  var readFile = function (p) { return fs.readFileSync(p, 'utf8'); };
  var print = function (s) { process.stdout.write(s + '\n'); };
}

var ROOT = '/Users/fanwei/Code/mini_program/';
var FN_CREATE = ROOT + 'cloudfunctions/createBooking/index.js';
var FN_UPDATE = ROOT + 'cloudfunctions/updateBooking/index.js';
var FN_CLEAR  = ROOT + 'cloudfunctions/clearAll/index.js';
var FN_PRICES = ROOT + 'cloudfunctions/savePrices/index.js';

var DAY = '2026-09-18';

/* ══════════════════════════════════════════════════════════════
   假数据库

   事务按 2026-09-18 在真云上量到的那套行为做：
     · 提交时发现【读过的】文档版本变了 → 冲突，抛出去
     · ⚠️ 【不替调用方重试】。那条实测结论（errCode -501001、
       [ResourceUnavailable.TransactionConflict]）是这个台架的地基：
       重试环是云函数【自己】写的，台架要验的正是它接不接得住。
       ⚠️ 报错文案照抄实测那条 —— 被测的 isConflict() 只看文本，
          假 db 自己编一个好看的码，测出来的就是假绿。
   ══════════════════════════════════════════════════════════════ */

function makeDb() {
  var store = {};                       // 集合名 → { _id → 文档 }
  var ver = {};                         // "集合/_id" → 版本号
  var stats = { commits: 0, conflicts: 0, callbackRuns: 0 };
  var hooks = { conflicts: 0, failOnce: null, breakColl: null, breakAdd: null, wrapResult: true };
  var wipeOrder = [];

  var coll = function (c) { return (store[c] = store[c] || {}); };
  var key = function (c, id) { return c + '/' + id; };
  var tick = function (c, id) { ver[key(c, id)] = (ver[key(c, id)] || 0) + 1; };
  var clone = function (o) { return o === undefined ? o : JSON.parse(JSON.stringify(o)); };

  function notExist(op) {
    var e = new Error('document.' + op + ':fail document does not exist');
    e.errCode = -502004;
    return e;
  }
  function dupKey() {
    var e = new Error('document.add:fail duplicate key error');
    e.errCode = -502001; e.code = 'DUPLICATE_KEY';
    return e;
  }
  function conflictError() {
    var e = new Error('document.update:fail -501001 resource system error. '
      + '[ResourceUnavailable.TransactionConflict] Transaction is conflict, '
      + 'maybe resource operated by others.');
    e.errCode = -501001;
    return e;
  }

  /* _id 查询条件里的操作符。clearAll 用的是 exists(true)，
     getSchedule / savePrices 用的是 in —— 这里都留着。 */
  var isOp = function (v) { return v && typeof v === 'object' && v.__op; };
  function matches(row, where) {
    return Object.keys(where || {}).every(function (k) {
      var cond = where[k];
      if (!isOp(cond)) return row[k] === cond;
      if (cond.__op === 'exists') return (row[k] !== undefined) === cond.v;
      if (cond.__op === 'in') return cond.vals.indexOf(row[k]) >= 0;
      throw new Error('假 db 不认识这个查询操作符: ' + cond.__op);
    });
  }

  function docRef(c, id) {
    return {
      get: function () {
        var d = coll(c)[id];
        if (d === undefined) throw notExist('get');
        return Promise.resolve({ data: clone(d) });
      },
      set: function (a) {
        /* ⚠️ 真云的 set 会因为很多原因整条拒绝（_id 不可变、集合不存在、
           字段名带点……），而它拒绝的方式是【抛】。台架不猜那些规则 ——
           只提供「让它抛」的开关，好验云函数把异常处理对了没有。
           breakSet = 整个集合挂；breakSetIds = 只有这几条挂。 */
        if (hooks.breakSet === c || (hooks.breakSetIds && hooks.breakSetIds[id])) {
          throw new Error('set ' + id + ' 被拒了');
        }
        /* 目标记录由 doc(id) 决定，data 里【不该】再出现 _id（真云会判成
           试图修改 _id）。台架照这个形状存，断言就能盯住它。 */
        coll(c)[id] = clone(a.data); tick(c, id);
        return Promise.resolve({});
      },
      update: function (a) {
        var d = coll(c)[id];
        if (d === undefined) throw notExist('update');
        Object.assign(d, clone(a.data)); tick(c, id);
        return Promise.resolve({ stats: { updated: 1 } });
      },
      remove: function () {
        var d = coll(c)[id];
        if (d === undefined) throw notExist('remove');
        delete coll(c)[id]; tick(c, id);
        return Promise.resolve({ stats: { removed: 1 } });
      },
    };
  }

  function collectionRef(c) {
    return {
      doc: function (id) { return docRef(c, id); },
      add: function (a) {
        if (hooks.breakAdd === c) throw new Error('集合 ' + c + ' 写不进去');
        var id = (a.data && a.data._id) || ('auto' + Math.random().toString(36).slice(2));
        if (coll(c)[id] !== undefined) throw dupKey();
        coll(c)[id] = clone(a.data); tick(c, id);
        return Promise.resolve({ _id: id });
      },
      where: function (q) {
        return {
          get: function () {
            if (hooks.breakColl === c) return Promise.reject(new Error('读 ' + c + ' 挂了'));
            var rows = Object.keys(coll(c)).filter(function (id) { return matches(coll(c)[id], q); })
              .map(function (id) { return clone(coll(c)[id]); });
            return Promise.resolve({ data: rows });
          },
          remove: function () {
            if (hooks.breakColl === c) return Promise.reject(new Error('集合 ' + c + ' 删不掉'));
            var hit = Object.keys(coll(c)).filter(function (id) { return matches(coll(c)[id], q); });
            /* 记下【真实发生】的删除顺序 —— clearAll 那三段顺序是硬性的，
               只能从这儿看出来。 */
            wipeOrder.push(c);
            hit.forEach(function (id) { delete coll(c)[id]; tick(c, id); });
            return Promise.resolve({ stats: { removed: hit.length } });
          },
        };
      },
    };
  }

  function txnFor(rec) {
    return {
      collection: function (c) {
        return {
          doc: function (id) {
            return {
              get: function () {
                rec.reads.push({ c: c, id: id, v: ver[key(c, id)] || 0 });
                return docRef(c, id).get();
              },
              set: function (a) { rec.writes.push({ t: 'set', c: c, id: id, data: clone(a.data) }); return Promise.resolve({}); },
              update: function (a) { rec.writes.push({ t: 'update', c: c, id: id, data: clone(a.data) }); return Promise.resolve({}); },
              remove: function () { rec.writes.push({ t: 'remove', c: c, id: id }); return Promise.resolve({}); },
            };
          },
          add: function (a) {
            rec.writes.push({ t: 'add', c: c, data: clone(a.data) });
            return Promise.resolve({ _id: a.data && a.data._id });
          },
        };
      },
    };
  }

  function runOnce(fn) {
    var rec = { reads: [], writes: [] };
    stats.callbackRuns++;
    return Promise.resolve(fn(txnFor(rec))).then(function (ret) {
      /* 注入的冲突：模拟「另一个人先提交了」。走的是和真冲突【同一段】
         代码（isConflict → 退避 → 重跑回调），所以验的是重试环本身。
         ⚠️ 它证明不了真云上会不会冲突 —— 那件事第 0 步已经量过了。 */
      if (hooks.conflicts > 0) { hooks.conflicts--; stats.conflicts++; throw conflictError(); }
      if (hooks.failOnce) { var e = hooks.failOnce; hooks.failOnce = null; throw e; }

      var dirty = rec.reads.some(function (r) { return (ver[key(r.c, r.id)] || 0) !== r.v; });
      if (dirty) { stats.conflicts++; throw conflictError(); }

      rec.writes.forEach(function (w) {
        if (w.t === 'remove') { delete coll(w.c)[w.id]; tick(w.c, w.id); return; }
        if (w.t === 'add') {
          var id = w.data && w.data._id;
          if (coll(w.c)[id] !== undefined) throw dupKey();
          coll(w.c)[id] = w.data; tick(w.c, id); return;
        }
        if (w.t === 'set') { coll(w.c)[w.id] = w.data; tick(w.c, w.id); return; }
        var d = coll(w.c)[w.id];
        if (d === undefined) throw notExist('update');
        Object.assign(d, w.data); tick(w.c, w.id);
      });
      stats.commits++;
      return ret;
    });
  }

  return {
    collection: collectionRef,
    command: {
      exists: function (v) { return { __op: 'exists', v: v }; },
      in: function (vals) { return { __op: 'in', vals: vals }; },
    },
    runTransaction: function (fn) {
      /* runTransaction 的返回值形状各版本不一样（实测的那份是裹着 result 的）。
         云函数两种都兜住了，所以两种也都在这里跑一遍。 */
      return runOnce(fn).then(function (ret) {
        return hooks.wrapResult ? { result: ret } : ret;
      });
    },
    _stats: stats,
    _hooks: hooks,
    _wipeOrder: wipeOrder,
    _store: store,
    /* 换一份库内容。⚠️ 原地改 store，【不换引用】—— `_store` 是 makeDb
       返回时就交出去的，换引用的话断言读到的是那个旧的空对象。 */
    _seeds: function (s) {
      Object.keys(store).forEach(function (k) { delete store[k]; });
      Object.keys(s || {}).forEach(function (k) { store[k] = s[k]; });
      ver = {};
    },
  };
}

/* ── 加载云函数 ─────────────────────────────────────────── */

var CURRENT_OPENID = '';

/* ⚠️ jsc 【没有】 console。云函数跑在 Node 里，console.log 是本来就有的，
   写它不算错 —— 缺的是台架这边没把 Node 的运行时模拟全。 */
function makeConsole() {
  return {
    log: function () { print('    [云函数日志] ' + Array.prototype.join.call(arguments, ' ')); },
    info: function () { print('    [云函数日志] ' + Array.prototype.join.call(arguments, ' ')); },
    warn: function () { print('    [云函数日志/warn] ' + Array.prototype.join.call(arguments, ' ')); },
    error: function () { print('    [云函数日志/error] ' + Array.prototype.join.call(arguments, ' ')); },
  };
}

function loadFn(path, db) {
  var mockSdk = {
    init: function () {},
    database: function () { return db; },
    getWXContext: function () { return { OPENID: CURRENT_OPENID }; },
    DYNAMIC_CURRENT_ENV: 'DYNAMIC_CURRENT_ENV',
  };
  var mockRequire = function (p) {
    if (p === 'wx-server-sdk') return mockSdk;
    throw new Error('未预期的 require: ' + p);
  };
  var mod = { exports: {} };
  var fn = new Function('module', 'exports', 'require', 'console', readFile(path));
  fn(mod, mod.exports, mockRequire, makeConsole());
  return mod.exports;
}

/* ── 断言 ──────────────────────────────────────────────── */

var passed = 0, failed = 0;
function ok(cond, label, got) {
  if (cond) { passed++; print('  ✓ ' + label); }
  else { failed++; print('  ✗ ' + label + '  (got ' + JSON.stringify(got) + ')'); }
}
function eq(got, want, label) {
  if (got === want) { passed++; print('  ✓ ' + label + '  (got ' + JSON.stringify(got) + ', want ' + JSON.stringify(want) + ')'); }
  else { failed++; print('  ✗ ' + label + '  (got ' + JSON.stringify(got) + ', want ' + JSON.stringify(want) + ')'); }
}

/* ── fixture ───────────────────────────────────────────── */

/** 一条待确认的单，占着 1 号场 19:00。slotKeys 不带日期（日期在 dateKey 上）。 */
function bookingDoc(id, dateKey, slotKeys, status) {
  return {
    _id: id, id: id, dateKey: dateKey, slotKeys: slotKeys,
    items: [], slotPrices: {},
    phone: '13500135000', name: '张三', note: '',
    total: 90, status: status || 'pending', reply: '',
    createdAt: 1, updatedAt: 1,
  };
}

function seed() {
  return {
    bookings: { B001: bookingDoc('B001', DAY, ['0|1140']) },
    occupancy: { [DAY + '|0']: { _id: DAY + '|0', slots: { 1140: 'B001' } } },
    prices: {},
  };
}

/** 读一张集合的内容。集合压根没被创建过时给个空表 —— 断言里
    `db._store.bookings` 会因为 undefined 直接抛，把「没写」报成崩了。 */
function coll(db, name) { return db._store[name] || {}; }

/** 某一格现在是谁占着（没占就是 undefined） */
function holder(db, ci, min) {
  var doc = coll(db, 'occupancy')[DAY + '|' + ci];
  return doc && doc.slots ? doc.slots[String(min)] : undefined;
}

function booking(id, dateKey, slotKeys, extra) {
  return Object.assign({
    id: id, dateKey: dateKey, slotKeys: slotKeys,
    items: [{ ci: 0, court: '1号场', from: 1140, to: 1200, price: 90 }],
    phone: '13900139000', name: '客人', note: '',
  }, extra || {});
}

/* ── core.js 的迷你加载器（只为了对拍 regrowItems）───────── */

var MINI = {};
function miniLoad(rel) {
  if (MINI[rel]) return MINI[rel].exports;
  var mod = { exports: {} };
  MINI[rel] = mod;
  var req = function (p) {
    var parts = rel.split('/'); parts.pop();
    p.split('/').forEach(function (seg) {
      if (seg === '.' || seg === '') return;
      if (seg === '..') parts.pop(); else parts.push(seg);
    });
    var out = parts.join('/');
    return miniLoad(/\.js$/.test(out) ? out : out + '.js');
  };
  var fn = new Function('module', 'exports', 'require', 'wx', 'getApp',
    readFile(ROOT + 'miniprogram/' + rel));
  fn(mod, mod.exports, req, { getStorageSync: function () { return undefined; } },
    function () { return null; });
  return mod.exports;
}

/* ── 主流程 ────────────────────────────────────────────── */

print('══ 写路径云函数本地台架（createBooking / updateBooking / savePrices / clearAll）══');
print('（只验函数里的分支；真云的事务语义只能在云上量）');
print('');

var steps = [];
function step(title, fn) { steps.push({ title: title, fn: fn }); }

/* ────────────────────────────────────────────────────────
   createBooking
   ──────────────────────────────────────────────────────── */

step('正常落单', function () {
  var db = makeDb();
  return loadFn(FN_CREATE, db).main({
    booking: booking('Bnew1111', DAY, ['0|1140']),
    slotPrices: { '0|1140': 90 },
    gap: 60,
  }).then(function (res) {
    eq(res.ok, true, 'ok:true', res);
    eq(res.booking.status, 'pending', '服务端写死 pending');
    eq(res.booking.total, 90, '总价 = 活下来的那几格的价钱之和');
    eq(res.booking.slotKeys.join(','), '0|1140', 'slotKeys 落库');
    eq(res.skipped.length, 0, '没有格子被跳过');
    eq(holder(db, 0, 1140), 'Bnew1111', '占用表指向新订单');
    eq(coll(db, 'bookings').Bnew1111.createdAt > 0, true, 'createdAt 由服务端写（列表排序靠它）');
  });
});

step('服务端不信客户端传来的 status', function () {
  var db = makeDb();
  return loadFn(FN_CREATE, db).main({
    booking: booking('Bnew1111', DAY, ['0|1140'], { status: 'confirmed', total: 1, createdAt: 0 }),
    slotPrices: { '0|1140': 90 }, gap: 60,
  }).then(function (res) {
    eq(res.booking.status, 'pending', '就算客户端说 confirmed，落库也是 pending');
    eq(res.booking.total, 90, '总价也不信客户端的，服务端自己加');
    eq(res.booking.createdAt > 0, true, 'createdAt 也不信客户端的（不然能把单排到最前）');
  });
});

step('一段三格、中间被抢：断成两截', function () {
  var db = makeDb();
  /* 1 号场 18:00–21:00，中间 19:00 已经被别人占住 */
  db._seeds({
    bookings: {}, occupancy: { [DAY + '|0']: { _id: DAY + '|0', slots: { 1140: 'Bother' } } }, prices: {},
  });
  var prices = { '0|1080': 60, '0|1140': 90, '0|1200': 90 };
  return loadFn(FN_CREATE, db).main({
    booking: booking('Bnew1111', DAY, ['0|1080', '0|1140', '0|1200'],
      { items: [{ ci: 0, court: '1号场', from: 1080, to: 1260, price: 240 }] }),
    slotPrices: prices, gap: 60,
  }).then(function (res) {
    eq(res.ok, true, 'ok:true（部分被抢不该整单拒绝）', res);
    eq(res.skipped.map(function (s) { return s.ci + '|' + s.min; }).join(','), '0|1140',
      'skipped 点出被抢的那一格');
    eq(res.booking.items.length, 2, '剩下的断成两截');
    eq(res.booking.items[0].from + '-' + res.booking.items[0].to, '1080-1140', '第一截 18:00–19:00');
    eq(res.booking.items[1].from + '-' + res.booking.items[1].to, '1200-1260', '第二截 20:00–21:00');
    eq(res.booking.items[0].price, 60, '第一截按【每格】的价钱加');
    eq(res.booking.items[1].price, 90, '第二截同理');
    eq(res.booking.total, 150, '总价只算活下来的（240 里有 90 是别人的）');
    eq(holder(db, 0, 1140), 'Bother', '别人的坑没被覆盖');
    eq(holder(db, 0, 1080), 'Bnew1111', '自己那两格写进去了');
  });
});

step('全被占：整单拒绝，且什么都不写', function () {
  var db = makeDb();
  db._seeds({
    bookings: {}, occupancy: { [DAY + '|0']: { _id: DAY + '|0', slots: { 1140: 'Bother' } } }, prices: {},
  });
  return loadFn(FN_CREATE, db).main({
    booking: booking('Bnew1111', DAY, ['0|1140']), slotPrices: { '0|1140': 90 }, gap: 60,
  }).then(function (res) {
    eq(res.ok, false, 'ok:false');
    eq(res.reason, 'all-taken', 'reason=all-taken');
    eq(res.skipped.length, 1, 'skipped 也报出来（客户端要靠它说话）');
    eq(Object.keys(coll(db, 'bookings')).length, 0, '订单一条都没写');
    eq(holder(db, 0, 1140), 'Bother', '占用表原样不动');
  });
});

step('占用文档不在 = 状态未知，【不是】全空', function () {
  var db = makeDb();
  return loadFn(FN_CREATE, db).main({
    booking: booking('Bnew1111', DAY, ['0|1140']), slotPrices: { '0|1140': 90 }, gap: 60,
  }).then(function (res) {
    /* 占用文档不存在的常规情况由 ensureOccupancy 在事务【外面】补上 ——
       这正是「先建好再进事务」那条设计：事务碰的每个文档都已知存在。 */
    eq(res.ok, true, 'ensureOccupancy 把文档建出来了', res);
    eq(holder(db, 0, 1140), 'Bnew1111', '然后事务照常写占用');
  });
});

step('占用文档建不出来时，是 state-unknown 而不是「全空」', function () {
  var db = makeDb();
  db._seeds({ bookings: {}, occupancy: {}, prices: {} });
  /* 让 add 永远失败，而且事务里也 get 不到 —— 模拟「占用表刚被 clearAll 删掉」。
     这时把它当成「全空」，就会把别人正在占的坑直接盖掉，一格一单当场破。 */
  db._hooks.breakAdd = 'occupancy';
  return loadFn(FN_CREATE, db).main({
    booking: booking('Bnew1111', DAY, ['0|1140']), slotPrices: { '0|1140': 90 }, gap: 60,
  }).then(function (res) {
    eq(res.ok, false, 'ok:false');
    eq(res.reason, 'state-unknown', '明确说「状态未知」，中止这笔');
    eq(Object.keys(coll(db, 'bookings')).length, 0, '订单一条都没写');
  });
});

step('形状校验：门口就该拦掉', function () {
  var db = makeDb();
  var fn = loadFn(FN_CREATE, db);
  var good = { booking: booking('Bnew1111', DAY, ['0|1140']), slotPrices: { '0|1140': 90 }, gap: 60 };

  function withBooking(over) {
    var e = JSON.parse(JSON.stringify(good));
    Object.assign(e.booking, over);
    return fn.main(e).then(function (r) { return r.reason; });
  }

  return withBooking({ id: 'x1' }).then(function (r) {
    eq(r, 'bad-id', '订单号形状不对（它会被当 _id 用）');
    return withBooking({ dateKey: '2026-9-18' });
  }).then(function (r) {
    eq(r, 'bad-date', '日期必须是 YYYY-MM-DD');
    return withBooking({ slotKeys: [] });
  }).then(function (r) {
    eq(r, 'no-slots', '没有格子');
    return withBooking({ slotKeys: new Array(91).fill('0|1140') });
  }).then(function (r) {
    eq(r, 'too-many-slots', '超过 90 格直接拒（事务操作数有上限，要响亮地失败）');
    return withBooking({ slotKeys: ['0|abc'] });
  }).then(function (r) {
    eq(r, 'bad-slot', '格子 key 不是数字');
    return withBooking({ phone: '123' });
  }).then(function (r) {
    eq(r, 'bad-phone', '手机号短得离谱');
    return withBooking({ phone: 13500135000 });
  }).then(function (r) {
    eq(r, 'bad-phone', '手机号是数字不是字符串（存进去就变成 1.35e10）');
  });
});

step('撞上一次冲突：重试环接住', function () {
  var db = makeDb();
  db._hooks.conflicts = 1;
  return loadFn(FN_CREATE, db).main({
    booking: booking('Bnew1111', DAY, ['0|1140']), slotPrices: { '0|1140': 90 }, gap: 60,
  }).then(function (res) {
    eq(res.ok, true, '重试之后成功落单', res);
    eq(db._stats.callbackRuns, 2, '回调被重跑了一次');
    eq(db._stats.commits, 1, '只提交了一次');
    eq(holder(db, 0, 1140), 'Bnew1111', '占用真的写进去了');
  });
});

step('每次都冲突：响亮地失败，绝不假装成功', function () {
  var db = makeDb();
  db._hooks.conflicts = 999;
  return loadFn(FN_CREATE, db).main({
    booking: booking('Bnew1111', DAY, ['0|1140']), slotPrices: { '0|1140': 90 }, gap: 60,
  }).then(function (res) {
    eq(res.ok, false, 'ok:false');
    eq(res.reason, 'busy', 'reason=busy（客户端翻成「请再试一次」）');
    eq(db._stats.callbackRuns, 4, '重试到上限就停（RETRY_TRIES=4）');
    eq(db._stats.commits, 0, '一次都没提交');
    eq(Object.keys(coll(db, 'bookings')).length, 0, '库里没有半成品订单');
  });
});

step('非冲突的错：直接抛出，不重试', function () {
  var db = makeDb();
  var boom = new Error('网络抖了一下');
  db._hooks.failOnce = boom;
  return loadFn(FN_CREATE, db).main({
    booking: booking('Bnew1111', DAY, ['0|1140']), slotPrices: { '0|1140': 90 }, gap: 60,
  }).then(function (res) {
    eq(res.ok, false, 'ok:false');
    eq(res.reason, 'error', 'reason=error（不是 busy —— 重试一万次也没用）');
    eq(db._stats.callbackRuns, 1, '只跑了一次');
  });
});

step('runTransaction 不裹 result 也能跑通', function () {
  var db = makeDb();
  db._hooks.wrapResult = false;
  return loadFn(FN_CREATE, db).main({
    booking: booking('Bnew1111', DAY, ['0|1140']), slotPrices: { '0|1140': 90 }, gap: 60,
  }).then(function (res) {
    /* 两种形状都得兜住：各版本 SDK 不一样，猜错的那次是【每一单都失败】。 */
    eq(res.ok, true, '返回值不裹 result 时也认得出来', res);
  });
});

step('regrowItems 和 core.js 的 groupSlots 对拍', function () {
  var fn = loadFn(FN_CREATE, makeDb());
  var core = miniLoad('utils/core.js');

  /* 全部格子都活着时，服务端重分组的结果必须和客人页当初分组的结果
     一模一样 —— 否则「客人看到 18:00–21:00 三小时，老板看到两截」
     这种事只会出现在真机上。 */
  var shapes = [
    ['0|1080'],
    ['0|1080', '0|1140', '0|1200'],
    ['0|1080', '1|1080', '1|1140'],
    ['0|1080', '0|1200'],
    ['3|1200', '0|1080', '0|1140'],
  ];
  var bad = 0;
  shapes.forEach(function (keys) {
    var prices = {};
    keys.forEach(function (k, i) { prices[k] = 60 + i * 10; });
    var alive = {};
    keys.forEach(function (k) { alive[k] = true; });

    var fromCore = core.groupSlots(core.parseKeys(keys), 60);
    var fromFn = fn._regrowItems(fromCore, alive, prices, 60);

    var a = JSON.stringify(fromCore.map(function (g) { return [g.ci, g.court, g.from, g.to]; }));
    var b = JSON.stringify(fromFn.map(function (g) { return [g.ci, g.court, g.from, g.to]; }));
    if (a !== b) { bad++; print('      · ' + keys.join(' ') + ' → core ' + a + ' / 云函数 ' + b); }
  });
  eq(bad, 0, '5 组形状下两份分组结果逐字一致');

  /* 价钱：整段活着时 = 各格之和 */
  var keys2 = ['0|1080', '0|1140'];
  var p2 = { '0|1080': 60, '0|1140': 90 };
  var alive2 = { '0|1080': true, '0|1140': true };
  var one = fn._regrowItems([{ ci: 0, court: '1号场', from: 1080, to: 1200 }], alive2, p2, 60);
  eq(one.length, 1, '连着的一整段合成一条');
  eq(one[0].price, 150, '价钱 = 60 + 90');
});

/* ────────────────────────────────────────────────────────
   updateBooking
   ──────────────────────────────────────────────────────── */

step('确认：坑本来就是自己的，不动', function () {
  var db = makeDb();
  db._seeds(seed());
  return loadFn(FN_UPDATE, db).main({
    id: 'B001', patch: { status: 'confirmed', reply: '电话已确认' }, passcode: '8888',
  }).then(function (res) {
    eq(res.ok, true, 'ok:true', res);
    eq(coll(db, 'bookings').B001.status, 'confirmed', '订单状态改了');
    eq(coll(db, 'bookings').B001.reply, '电话已确认', 'reply 也写进去了');
    eq(holder(db, 0, 1140), 'B001', '坑还是自己的（没被抹掉）');
  });
});

step('取消：释放占坑', function () {
  var db = makeDb();
  db._seeds(seed());
  return loadFn(FN_UPDATE, db).main({
    id: 'B001', patch: { status: 'cancelled' }, passcode: '8888',
  }).then(function (res) {
    eq(res.ok, true, 'ok:true', res);
    eq(coll(db, 'bookings').B001.status, 'cancelled', '订单变成已取消');
    eq(holder(db, 0, 1140), undefined, '【占坑被释放】—— 客人页那一格重新变空');
  });
});

step('恢复：格子空着就重新占坑', function () {
  var db = makeDb();
  db._seeds(seed());
  coll(db, 'bookings').B001.status = 'cancelled';
  db._store.occupancy[DAY + '|0'].slots = {};
  return loadFn(FN_UPDATE, db).main({
    id: 'B001', patch: { status: 'pending' }, passcode: '8888',
  }).then(function (res) {
    eq(res.ok, true, 'ok:true', res);
    eq(holder(db, 0, 1140), 'B001', '坑重新占上');
  });
});

step('恢复撞车：整笔拒绝，且订单状态不许变', function () {
  var db = makeDb();
  db._seeds(seed());
  coll(db, 'bookings').B001.status = 'cancelled';
  /* 那格被另一个客人合法订走了 */
  db._store.occupancy[DAY + '|0'].slots = { 1140: 'Bother' };
  return loadFn(FN_UPDATE, db).main({
    id: 'B001', patch: { status: 'pending' }, passcode: '8888',
  }).then(function (res) {
    eq(res.ok, false, 'ok:false');
    eq(res.reason, 'slot-taken', 'reason=slot-taken（orders.js 靠它弹窗）');
    eq(res.taken.length, 1, 'taken 报出被占的是哪几格');
    eq(res.taken[0].ci + '|' + res.taken[0].min, '0|1140', '明细是 0|1140');
    eq(coll(db, 'bookings').B001.status, 'cancelled', '【订单状态没变】—— 没造出两单占同一格');
    eq(holder(db, 0, 1140), 'Bother', '别人的坑没被抢过来');
  });
});

step('取消时那格已被别人占：不替别人放坑', function () {
  var db = makeDb();
  db._seeds(seed());
  /* 不该发生的状态：这单还是 pending，但坑已经指向别人了。
     真发生了也不能把别人的坑删掉 —— 那是替别人放坑，客人会莫名丢时段。 */
  db._store.occupancy[DAY + '|0'].slots = { 1140: 'Bother' };
  return loadFn(FN_UPDATE, db).main({
    id: 'B001', patch: { status: 'cancelled' }, passcode: '8888',
  }).then(function (res) {
    eq(res.ok, true, 'ok:true（取消本身是允许的）', res);
    eq(holder(db, 0, 1140), 'Bother', '别人的坑原样留着');
  });
});

step('跨场地：只动自己涉及的那几个占用文档', function () {
  var db = makeDb();
  db._seeds({
    bookings: { B001: bookingDoc('B001', DAY, ['0|1140', '2|1200']) },
    occupancy: {
      [DAY + '|0']: { _id: DAY + '|0', slots: { 1140: 'B001' } },
      [DAY + '|1']: { _id: DAY + '|1', slots: { 1080: 'Bother' } },
      [DAY + '|2']: { _id: DAY + '|2', slots: { 1200: 'B001' } },
    },
    prices: {},
  });
  return loadFn(FN_UPDATE, db).main({
    id: 'B001', patch: { status: 'cancelled' }, passcode: '8888',
  }).then(function (res) {
    eq(res.ok, true, 'ok:true', res);
    eq(holder(db, 0, 1140), undefined, '0 号场那格释放了');
    eq(holder(db, 2, 1200), undefined, '2 号场那格也释放了');
    eq(holder(db, 1, 1080), 'Bother', '没碰到的场地一个字节都没动');
  });
});

step('订单不存在 / 占用文档不在', function () {
  var db = makeDb();
  db._seeds(seed());
  return loadFn(FN_UPDATE, db).main({
    id: 'Bnope', patch: { status: 'confirmed' }, passcode: '8888',
  }).then(function (res) {
    eq(res.ok, false, 'ok:false');
    eq(res.reason, 'not-found', '订单找不到就说找不到');

    var db2 = makeDb();
    db2._seeds(seed());
    delete db2._store.occupancy[DAY + '|0'];
    return loadFn(FN_UPDATE, db2).main({
      id: 'B001', patch: { status: 'cancelled' }, passcode: '8888',
    });
  }).then(function (res) {
    eq(res.reason, 'state-unknown', '占用表不在 = 状态未知，不是「全空」');
    eq(holder(db, 0, 1140), 'B001', '订单状态也没动');
  });
});

step('updateBooking 的鉴权', function () {
  var db = makeDb();
  db._seeds(seed());
  var fn = loadFn(FN_UPDATE, db);
  CURRENT_OPENID = 'openid-someone';
  return fn.main({ id: 'B001', patch: { status: 'cancelled' }, passcode: '8889' }).then(function (res) {
    eq(res.ok, false, '口令错 → ok:false');
    eq(res.reason, 'forbidden', 'reason=forbidden');
    eq(coll(db, 'bookings').B001.status, 'pending', '【一个字节都没改】');
    eq(holder(db, 0, 1140), 'B001', '占用表也没动');
    return fn.main({ id: 'B001', patch: { status: 'cancelled' } });
  }).then(function (res) {
    eq(res.reason, 'forbidden', '压根不带口令也是 forbidden');
    return fn.main({ id: 'B001', patch: { status: 'deleted' }, passcode: '8888' });
  }).then(function (res) {
    eq(res.reason, 'bad-status', '状态只认三个值');
    return fn.main({ id: '', patch: { status: 'pending' }, passcode: '8888' });
  }).then(function (res) {
    eq(res.reason, 'bad-id', '订单号是空的');
    return fn.main({ id: 'B001', patch: { status: 'pending', reply: 123 }, passcode: '8888' });
  }).then(function (res) {
    eq(res.reason, 'bad-reply', 'reply 必须是字符串');
    eq(coll(db, 'bookings').B001.status, 'pending', '这一串下来订单状态一直是 pending');
  });
});

step('updateBooking 也接得住冲突', function () {
  var db = makeDb();
  db._seeds(seed());
  db._hooks.conflicts = 1;
  return loadFn(FN_UPDATE, db).main({
    id: 'B001', patch: { status: 'cancelled' }, passcode: '8888',
  }).then(function (res) {
    eq(res.ok, true, '重试之后成功', res);
    eq(db._stats.callbackRuns, 2, '回调被重跑了一次');
    eq(holder(db, 0, 1140), undefined, '释放真的落库了');
  });
});

/* ────────────────────────────────────────────────────────
   clearAll
   ──────────────────────────────────────────────────────── */

step('清空三张集合', function () {
  var db = makeDb();
  db._seeds({
    bookings: { B001: bookingDoc('B001', DAY, ['0|1140']) },
    occupancy: { [DAY + '|0']: { _id: DAY + '|0', slots: { 1140: 'B001' } } },
    prices: { x: { _id: DAY + '|0|1140', dateKey: DAY, price: 88 } },
  });
  return loadFn(FN_CLEAR, db).main({ passcode: '8888' }).then(function (res) {
    eq(res.ok, true, 'ok:true', res);
    eq(res.done.occupancy, 1, 'occupancy 删了 1 条');
    eq(res.done.bookings, 1, 'bookings 删了 1 条');
    eq(res.done.prices, 1, 'prices 删了 1 条');
    eq(db._wipeOrder.join(' → '), 'occupancy → bookings → prices',
      '【顺序】先占后单（反了的话中途断掉界面上救不回来）');
  });
});

step('空集合不算失败（第二次点「清空」是正常的）', function () {
  var db = makeDb();
  db._seeds({ bookings: {}, occupancy: {}, prices: {} });
  return loadFn(FN_CLEAR, db).main({ passcode: '8888' }).then(function (res) {
    eq(res.ok, true, '空库再清一次也是 ok:true', res);
    eq(res.done.bookings, 0, '删了 0 条');
  });
});

step('中途失败就停住，绝不跳过继续删', function () {
  var db = makeDb();
  db._seeds({
    bookings: { B001: bookingDoc('B001', DAY, ['0|1140']) },
    occupancy: { [DAY + '|0']: { _id: DAY + '|0', slots: { 1140: 'B001' } } },
    prices: { x: { _id: DAY + '|0|1140', dateKey: DAY, price: 88 } },
  });
  db._hooks.breakColl = 'bookings';       // 第二段挂掉
  return loadFn(FN_CLEAR, db).main({ passcode: '8888' }).then(function (res) {
    eq(res.ok, false, 'ok:false（不能假装清干净了）');
    eq(res.reason, 'partial', 'reason=partial');
    eq(res.done.occupancy, 1, '第一段删成功了，如实报出来');
    eq(res.done.bookings, 0, '第二段一条没删');
    eq(Object.keys(coll(db, 'prices')).length, 1, '【没有往下删】prices 原样留着');
  });
});

step('clearAll 的鉴权', function () {
  var db = makeDb();
  db._seeds({
    bookings: { B001: bookingDoc('B001', DAY, ['0|1140']) },
    occupancy: { [DAY + '|0']: { _id: DAY + '|0', slots: { 1140: 'B001' } } },
    prices: {},
  });
  return loadFn(FN_CLEAR, db).main({ passcode: '8889' }).then(function (res) {
    eq(res.reason, 'forbidden', '口令错 → forbidden');
    eq(Object.keys(coll(db, 'bookings')).length, 1, '【一张集合都没被删】');
    return loadFn(FN_CLEAR, db).main({});
  }).then(function (res) {
    eq(res.reason, 'forbidden', '不带口令也是 forbidden');
    eq(Object.keys(coll(db, 'bookings')).length, 1, '订单还在');
  });
});

/* ────────────────────────────────────────────────────────
   savePrices
   ──────────────────────────────────────────────────────── */

var PK_A = DAY + '|0|1140';
var PK_B = DAY + '|0|1200';

step('改一格：写进去的是那一格，不是整张表', function () {
  var db = makeDb();
  db._seeds({ prices: { old: { dateKey: DAY, price: 77 } } });
  return loadFn(FN_PRICES, db).main({
    passcode: '8888', set: { [PK_A]: 99 }, del: [],
  }).then(function (res) {
    eq(res.ok, true, 'ok:true', res);
    eq(res.written, 1, '写了 1 格');
    eq(coll(db, 'prices')[PK_A].price, 99, '那一格的值落库了');
    eq(coll(db, 'prices')[PK_A].dateKey, DAY,
      'dateKey 单独存了一份（getSchedule 按它过滤，_id 前缀做不了索引）');
    eq(coll(db, 'prices').old.price, 77,
      '【别的格子没被碰】—— 整表覆盖会把另一个管理员同时改的抹掉');
  });
});

step('恢复规则价：删掉那一格', function () {
  var db = makeDb();
  db._seeds({ prices: { a: { dateKey: DAY, price: 99 } } });
  /* 注意闸门 key 是 PK_A，种下去的那条也叫 PK_A —— 种成别的名字的话
     这条断的就是「删一个不存在的东西」（那是下一条的事）。 */
  db._seeds({ prices: {} });
  db._store.prices[PK_A] = { dateKey: DAY, price: 99 };
  db._store.prices.other = { dateKey: DAY, price: 55 };
  return loadFn(FN_PRICES, db).main({
    passcode: '8888', set: {}, del: [PK_A],
  }).then(function (res) {
    eq(res.ok, true, 'ok:true', res);
    eq(res.removed, 1, '删了 1 格');
    eq(coll(db, 'prices')[PK_A], undefined, '那一格没了');
    eq(coll(db, 'prices').other.price, 55, '别的格子还在');
  });
});

step('⚠️ 删一个【本来就没有】的格子不算失败', function () {
  var db = makeDb();
  db._seeds({ prices: {} });
  /* 老板点「恢复规则价」，选中的格子里有几个压根没改过价 ——
     del 会把它们一起带上，而库里没有对应的文档。这必须是个空操作，
     不能把整批拖成 partial：否则他点的是一个什么都不用做的事，
     却收到一句「部分时段没存上」，然后整批回滚。 */
  return loadFn(FN_PRICES, db).main({
    passcode: '8888', set: {}, del: [PK_A, PK_B],
  }).then(function (res) {
    eq(res.ok, true, 'ok:true（删不到就是已经删过了）', res);
    eq(res.removed, 2, '如实报成删掉了');
    eq(res.failed, undefined, '没有 failed');
  });
});

step('⚠️ data 里不许出现 _id', function () {
  var db = makeDb();
  db._seeds({ prices: {} });
  return loadFn(FN_PRICES, db).main({
    passcode: '8888', set: { [PK_A]: 99 }, del: [],
  }).then(function () {
    /* 目标记录由 doc(k) 指定，data 再说一遍 _id 就是「试图修改 _id」——
       真云会整条拒绝（而它拒绝的方式是抛，表现出来是每一格都失败）。 */
    eq('_id' in coll(db, 'prices')[PK_A], false,
      'set 的 data 里没有 _id（_id 由 doc(k) 决定）');
    eq(coll(db, 'prices')[PK_A].price, 99, '但价格本身写进去了');
  });
});

step('一格失败不影响别的格，但必须报 partial 并说【为什么】', function () {
  var db = makeDb();
  db._seeds({ prices: {} });
  /* 只让【第一格】挂：老板改了 5 格、第 3 格抖了一下，另外 4 格不该跟着白改。 */
  db._hooks.breakSetIds = { [PK_A]: true };
  return loadFn(FN_PRICES, db).main({
    passcode: '8888', set: { [PK_A]: 99, [PK_B]: 88 }, del: [],
  }).then(function (res) {
    eq(res.ok, false, 'ok:false（不能报成功）', res);
    eq(res.reason, 'partial', 'reason=partial');
    eq(res.written, 1, '没挂的那格照样写进去了');
    eq(coll(db, 'prices')[PK_B].price, 88, '第二格的值落库了');
    eq(coll(db, 'prices')[PK_A], undefined, '挂掉的那格没落库');
    eq(res.failed.join(','), PK_A, 'failed 只列出【真正没写进去】的那几格');
    /* ⚠️ 这几条是拿真机的一次改价换来的：原来 catch 里只 push 一个 key，
       异常本身被吞掉，于是「一格都没写进去」在返回值里和云函数日志里
       都只表现为「失败了」，为什么失败一个字都没有 —— 老板看到一句
       「部分时段没存上」，然后谁也查不下去，只能靠猜。 */
    ok(!!res.detail && res.detail.length > 0,
      'detail 里有【真正的报错原文】（不然只能靠猜）', res.detail);
    ok(/被拒了/.test(res.detail || ''), 'detail 里就是那个异常的消息', res.detail);
  });
});

step('写全挂时如实报 partial，同时删的格子照样算数', function () {
  var db = makeDb();
  db._seeds({ prices: {} });
  db._hooks.breakSet = 'prices';
  return loadFn(FN_PRICES, db).main({
    passcode: '8888', set: { [PK_A]: 99 }, del: [PK_B],
  }).then(function (res) {
    eq(res.ok, false, 'ok:false（写失败绝不报成功）', res);
    eq(res.written, 0, '一格都没写成');
    eq(res.failed.join(','), PK_A, 'failed 只列【写失败】的那格');
    /* del 那条路走的是 get → 不存在 → 不删，和 set 的失败无关：
       两个循环是分开的，一个挂不该把另一个也判成失败。 */
    eq(res.removed, 1, '要删的那格照样算成删掉了（它本来就没有）');
    ok(!!res.detail, 'detail 照样给出来（这时候就靠它查）', res.detail);
  });
});

step('savePrices 的校验和鉴权', function () {
  var db = makeDb();
  db._seeds({ prices: {} });
  var fn = loadFn(FN_PRICES, db);

  return fn.main({ passcode: '8889', set: { [PK_A]: 99 }, del: [] }).then(function (res) {
    eq(res.reason, 'forbidden', '口令错 → forbidden');
    return fn.main({ set: { [PK_A]: 99 }, del: [] });
  }).then(function (res) {
    eq(res.reason, 'forbidden', '不带口令 → forbidden');
    return fn.main({ passcode: '8888', set: { 'not-a-key': 99 }, del: [] });
  }).then(function (res) {
    eq(res.reason, 'bad-key', 'key 形状不对 → bad-key（不是默默写坏数据）');
    return fn.main({ passcode: '8888', set: { [PK_A]: 'abc' }, del: [] });
  }).then(function (res) {
    eq(res.reason, 'bad-price', '价钱不是数 → bad-price');
    return fn.main({ passcode: '8888', set: { [PK_A]: -5 }, del: [] });
  }).then(function (res) {
    eq(res.reason, 'bad-price', '负数价钱 → bad-price');
    var big = {};
    for (var i = 0; i < 201; i++) { big[DAY + '|0|' + (600 + i)] = 90; }
    return fn.main({ passcode: '8888', set: big, del: [] });
  }).then(function (res) {
    eq(res.reason, 'too-many-cells', '一次改超过 200 格 → 直接拒（别拿它当批量写口）');
    eq(Object.keys(coll(db, 'prices')).length, 0, '上面这些没有一条真的写进去了');
  });
});

/* ── 跑 ────────────────────────────────────────────────── */

var idx = 0;
function next() {
  if (idx >= steps.length) return done();
  var s = steps[idx++];
  print('── ' + s.title + ' ' + '─'.repeat(Math.max(0, 40 - s.title.length)));
  return Promise.resolve().then(s.fn).then(function () {
    print('');
    return next();
  });
}

function done() {
  print('══════════════════════════════════════════════');
  print('  通过 ' + passed + ' / 失败 ' + failed);
  print('══════════════════════════════════════════════');
  if (failed > 0) print('!! 有失败 —— 别往云上传，先修代码');
}

next().catch(function (e) {
  print('  ✗ 整个台架崩了：' + (e && e.name) + ' / ' + (e && e.message) + ' / ' + (e && e.stack || e));
  print('');
  print('  通过 ' + passed + ' / 失败 ' + (failed + 1));
  print('!! 有失败 —— 别往云上传，先修代码');
});
