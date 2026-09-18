/* ══════════════════════════════════════════════════════════════
   harness.js —— 在本地把 getSchedule 这个云函数跑起来

   ⚠️ 它【不能】替代真机那一次：真的云数据库怎么执行 where/in、limit 算不算
      数、OPENID 从哪来 —— 那些都是云端的实现细节，假 db 还原不出来。

   它能做的是另一件事：**在花掉你一次真机往返之前，把云函数里的分支走一遍**。
     这个函数有四条容易写错、且在真机上「看起来只是没数据」的路：
       · 投影（非管理员不能拿到 phone）
       · _id → id 的换算
       · 价格从「一手一格一条」还原成 core 认识的那张 map
       · 白名单非空时，口令【完全】不看

   跑法：./dev/get-schedule/run.sh

   ⚠️ 成败是【印在输出里】的，不体现在退出码上 —— jsc 里未处理的 Promise
      拒绝是静默 exit 0。看最后那行「通过 N / 失败 M」。
   ══════════════════════════════════════════════════════════════ */

var IS_NODE = (typeof process !== 'undefined' && process.versions && process.versions.node);
if (IS_NODE) {
  var fs = require('fs');
  var readFile = function (p) { return fs.readFileSync(p, 'utf8'); };
  var print = function (s) { process.stdout.write(s + '\n'); };
}

var FN_PATH = '/Users/fanwei/Code/mini_program/cloudfunctions/getSchedule/index.js';

/* ── 假云数据库：只实现 getSchedule 用到的那几样 ───────────
   command.in / where / limit / get。别的一概没有 —— 用到了就报错，
   好过悄悄返回一个看起来合理的空结果。 */

function makeDb(data, broken) {
  var store = JSON.parse(JSON.stringify(data || {}));
  var calls = { reads: [] };
  /* 点名让某张集合「读不到」——模拟「控制台里忘了建」。
     这是搭起来时最可能撞的失败，也是唯一一条【本地测不了但值得测】的：
     真云的报错文案我编不出来，所以这里只验「函数有没有把它点名报出来」。 */
  var dead = {};
  (broken || []).forEach(function (n) { dead[n] = true; });

  var isOp = v => v && typeof v === 'object' && v.__op === 'in';

  function matches(row, where) {
    return Object.keys(where || {}).every(function (k) {
      var cond = where[k];
      return isOp(cond) ? cond.vals.indexOf(row[k]) >= 0 : row[k] === cond;
    });
  }

  function coll(name) {
    function query(where) {
      var limit = Infinity;
      var q = {
        limit: function (n) { limit = n; return q; },
        get: function () {
          if (dead[name]) {
            calls.reads.push({ coll: name, where: where, limit: limit, hit: 'ERR' });
            return Promise.reject(new Error('collection not exists: ' + name));
          }
          var rows = (store[name] || []).filter(function (r) { return matches(r, where); });
          calls.reads.push({ coll: name, where: where, limit: limit, hit: rows.length });
          /* 真云是「先按 limit 截断再返回」，这里照做 —— 不然
             over-limit 那条判断永远测不出来。 */
          return Promise.resolve({ data: rows.slice(0, limit) });
        },
      };
      return q;
    }
    return {
      where: function (w) { return query(w); },
      /* 不带 where 的 limit+get：只给「查到 0 条」那个诊断取样用。
         除了这一步，本函数不该有全表读 —— 有的话就是哪里写错了查询。 */
      limit: function (n) {
        return {
          get: function () {
            if (dead[name]) return Promise.reject(new Error('collection not exists: ' + name));
            return Promise.resolve({ data: (store[name] || []).slice(0, n) });
          },
        };
      },
      /* 全表计数，只在「查到 0 条」那个诊断里用 */
      count: function () {
        if (dead[name]) return Promise.reject(new Error('collection not exists: ' + name));
        return Promise.resolve({ total: (store[name] || []).length });
      },
    };
  }

  return {
    collection: coll,
    command: {
      in: function (vals) { return { __op: 'in', vals: vals }; },
    },
    _calls: calls,
  };
}

/* ── 加载云函数 ─────────────────────────────────────────── */

var CURRENT_OPENID = '';

/* ⚠️ jsc 【没有】 console。云函数跑在 Node 里，console.log 是本来就有的，
   写它不算错 —— 缺的是台架这边没把 Node 的运行时模拟全。
   这个桩把云函数的日志原样转到台架输出上，顺便也就验了「它到底打了什么」。 */
function makeConsole() {
  return {
    log: function () { print('    [云函数日志] ' + Array.prototype.join.call(arguments, ' ')); },
    info: function () { print('    [云函数日志] ' + Array.prototype.join.call(arguments, ' ')); },
    warn: function () { print('    [云函数日志/warn] ' + Array.prototype.join.call(arguments, ' ')); },
    error: function () { print('    [云函数日志/error] ' + Array.prototype.join.call(arguments, ' ')); },
  };
}

function loadFn(db) {
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
  var fn = new Function('module', 'exports', 'require', 'console', readFile(FN_PATH));
  fn(mod, mod.exports, mockRequire, makeConsole());
  return mod.exports;
}

/* ── 断言 ──────────────────────────────────────────────── */

var passed = 0, failed = 0;
function ok(cond, label, got) {
  if (cond) { passed++; print('  ✓ ' + label); }
  else { failed++; print('  ✗ ' + label + '  (got ' + JSON.stringify(got) + ')'); }
}

/* ── fixture ───────────────────────────────────────────── */

var DAY = '2026-09-18';
var OTHER = '2026-09-19';

function bookingDoc(id, dateKey, slotKeys, phone) {
  return {
    _id: id, id: id, dateKey: dateKey, slotKeys: slotKeys,
    phone: phone, name: '张三', note: '要两副拍子',
    items: [{ ci: 0, court: '1号场', from: 1140, to: 1200, price: 90 }],
    total: 90, status: 'pending', reply: '',
    createdAt: 1, updatedAt: 1,
  };
}

function fixture() {
  return {
    bookings: [
      bookingDoc('B001', DAY, ['0|1140'], '13500135000'),
      bookingDoc('B002', DAY, ['1|1200'], '13600136000'),
      bookingDoc('B003', OTHER, ['2|1080'], '13700137000'),
    ],
    prices: [
      { _id: DAY + '|0|1140', dateKey: DAY, price: 88 },
      { _id: DAY + '|1|1200', dateKey: DAY, price: 99 },
      { _id: OTHER + '|2|1080', dateKey: OTHER, price: 77 },
    ],
  };
}

/* ── 用例 ──────────────────────────────────────────────── */

var cases = [];

/** 每个用例单独一个假 db，互不影响。
    broken = 点名让哪张集合读不到；data = 换一份库内容（不给就用 fixture()） */
function C(name, openid, event, fn, broken, data) {
  cases.push({ name: name, openid: openid, event: event, check: fn, broken: broken, data: data });
}

C('客人（不带口令）', 'openid-guest', { dateKeys: [DAY] }, function (res, db) {
  ok(res.ok === true, 'ok:true', res);
  ok(res.isAdmin === false, 'isAdmin 是 false', res.isAdmin);
  ok(res.bookings.length === 2, '只拿到当天的 2 单，别天的不给', res.bookings.length);
  ok(res.bookings.every(function (b) { return b.phone === undefined; }),
    '【投影】订单里没有 phone', res.bookings[0]);
  ok(res.bookings.every(function (b) { return b.name === undefined && b.note === undefined; }),
    '【投影】也没有姓名和备注', res.bookings[0]);
  ok(res.bookings.every(function (b) {
    return typeof b.dateKey === 'string' && Array.isArray(b.slotKeys) && typeof b.status === 'string';
  }), '【投影】保留了 dateKey / slotKeys / status（core 算占用就靠这三个）', res.bookings[0]);
  ok(res.prices[DAY + '|0|1140'] === 88, '价格还原成了 { 格子key: 价格 }', res.prices);
});

C('老板（带对口令）', 'openid-boss', { dateKeys: [DAY], passcode: '8888' }, function (res) {
  ok(res.isAdmin === true, 'isAdmin 是 true', res.isAdmin);
  ok(res.bookings.length === 2, '拿到当天 2 单', res.bookings.length);
  var b = res.bookings[0];
  ok(b.phone === '13500135000', '【完整】订单里有 phone', b.phone);
  ok(b.name === '张三' && b.note === '要两副拍子', '姓名备注都在（老板要打电话）', [b.name, b.note]);
  ok(b.id === 'B001', 'id 是从 _id 换算来的', b.id);
  ok(b._id === undefined, '业务对象里没有 _id（别让同一个订单冒出两套取法）', b._id);
  ok(Array.isArray(b.items) && b.total === 90, 'items / total 都在', [b.items, b.total]);
});

C('口令错一个字符', 'openid-boss', { dateKeys: [DAY], passcode: '8889' }, function (res) {
  ok(res.isAdmin === false, '口令不对就不是管理员', res.isAdmin);
  ok(res.bookings.every(function (b) { return b.phone === undefined; }),
    '拿不到手机号', res.bookings[0]);
});

C('没有口令字段', 'openid-boss', { dateKeys: [DAY] }, function (res) {
  ok(res.isAdmin === false, '压根没传口令也不是管理员', res.isAdmin);
});

C('日期参数不合法', 'openid-guest', { dateKeys: ['20260918', '', null, '2026-9-18'] }, function (res) {
  ok(res.ok === false, '一个合法日期都没有 → ok:false', res);
  ok(res.reason === 'no-dates', 'reason 是 no-dates', res.reason);
});

C('日期参数里混了坏值', 'openid-guest', { dateKeys: [DAY, 'garbage'] }, function (res) {
  ok(res.ok === true, '好日期还在，坏值被剔掉即可', res);
  ok(res.bookings.length === 2, '只按好日期查', res.bookings.length);
});

C('问太多天', 'openid-guest', { dateKeys: new Array(40).fill(DAY) }, function (res) {
  ok(res.ok === false && res.reason === 'too-many-dates', '一天问超过 31 个日期直接拒', res);
});

C('dateKeys 不是数组', 'openid-guest', { dateKeys: '2026-09-18' }, function (res) {
  ok(res.ok === false && res.reason === 'no-dates', '字符串不算数组（别让 ... 之类的形状混进来）', res);
});

C('事件整个是空的', 'openid-guest', {}, function (res) {
  ok(res.ok === false && res.reason === 'no-dates', '不传参数不炸，给一个明确的 ok:false', res);
});

/* ── 「查到 0 条」的两种截然不同的原因 ────────────────────
   这个诊断存在的理由就是这两条：都表现为「回来 0 单、界面全空」，
   但一个要去控制台看环境，一个要去看记录里字段写成了什么。
   劈不开就只能瞎猜。 */
C('问的那天没有单，但库里有别天的单', 'openid-guest', { dateKeys: ['2026-01-01'] }, function (res) {
  ok(res.bookings.length === 0, '那天确实没有单', res.bookings);
  ok(res.anyBookings === true,
    'anyBookings=true —— 记录在库里，是日期对不上（去查字段名和值）', res.anyBookings);
  ok(res.shape && res.shape.dateKey === DAY,
    'shape 报出了那条记录的 dateKey 值（这正是要拿去对的东西）', res.shape);
  ok(res.shape && /dateKey/.test(res.shape.fields),
    'shape.fields 里有 dateKey', res.shape && res.shape.fields);
  ok(res.shape && res.shape.dateKeyType === 'string',
    '而且报出了它的类型 —— 存成别的类型同样匹配不上', res.shape);
});

/* 真正把「字段名写错了」这种病复现出来：库里那条记录压根没有 dateKey */
C('库里的记录字段名写错了', 'openid-guest', { dateKeys: [DAY] }, function (res) {
  ok(res.anyBookings === true, '记录在库里', res.anyBookings);
  ok(res.shape && !/dateKey/.test(res.shape.fields),
    '【一眼看出】fields 里没有 dateKey —— 字段名写错了', res.shape);
  ok(res.shape && res.shape.dateKey === 'undefined',
    'dateKey 取不到值，报成 undefined 而不是留空', res.shape);
  ok(res.bookings.every(function (b) { return b.phone === undefined; }),
    'shape 里【不含】手机号姓名（它是给客人也看得到的响应）', res.shape);
}, null, {
  bookings: [{ _id: 'X1', datekey: DAY, slotKeys: ['0|1140'], status: 'pending',
               phone: '13500135000', name: '张三' }],
  prices: [],
});

C('库里压根一条单都没有', 'openid-guest', { dateKeys: [DAY] }, function (res) {
  ok(res.bookings.length === 0, '空库当然查不到', res.bookings);
  ok(res.anyBookings === false,
    'anyBookings=false —— 记录压根不在这个环境的这张集合里', res.anyBookings);
}, null, { bookings: [], prices: [] });

C('查到东西时不带 anyBookings', 'openid-guest', { dateKeys: [DAY] }, function (res) {
  ok(res.bookings.length === 2, '这条用例本身有数据', res.bookings.length);
  ok(res.anyBookings === null || res.anyBookings === undefined,
    '查到东西时【不】去 count，也不带这个字段（省一次读，也少一处能挂的地方）', res.anyBookings);
});

/* ── 集合还没建（搭起来时最容易翻的车）─────────────────────
   裸查询的失败会变成云函数抛异常，客户端只看到一句「取数失败」，
   而界面上是一片空 —— 跟「还没人下单」长得一模一样。
   下面两条要的是：失败被点出【是哪张集合】。 */
C('bookings 还没建', 'openid-guest', { dateKeys: [DAY] }, function (res, db) {
  ok(res.ok === false && res.reason === 'read-failed', '明确失败，不是悄悄返回空表', res);
  ok(/bookings/.test(res.detail || ''), 'detail 里点了 bookings 的名', res.detail);
  ok(db._calls.reads.some(function (r) { return r.coll === 'prices'; }),
    'prices 那边照样查了（两张分开读，不因一张挂掉就不查另一张）', db._calls.reads);
}, ['bookings']);

C('prices 还没建', 'openid-guest', { dateKeys: [DAY] }, function (res) {
  ok(res.ok === false && res.reason === 'read-failed', '价格表缺了也不能假装成功', res);
  ok(/prices/.test(res.detail || ''), 'detail 里点了 prices 的名', res.detail);
}, ['prices']);

/* ── 白名单 ──────────────────────────────────────────────
   这一条要临时改掉云函数里的 ADMIN_WHITELIST 才能测 —— 做法是
   把源码里的 `const ADMIN_WHITELIST = [];` 替换成带内容的版本，
   用【同一份】文件重新求值。测的是「白名单非空时口令完全失效」这条，
   它是补权限那天最可能出错的逻辑（两套机制互相削弱）。 */
function loadFnWithWhitelist(db, ids) {
  var src = readFile(FN_PATH)
    .replace('const ADMIN_WHITELIST = [];',
             'const ADMIN_WHITELIST = [' + ids.map(function (i) { return JSON.stringify(i); }).join(',') + '];');
  if (src.indexOf('const ADMIN_WHITELIST = [];') >= 0) {
    throw new Error('白名单那行没被替换掉 —— 源码形状变了，用例失效');
  }
  var mockSdk = {
    init: function () {}, database: function () { return db; },
    getWXContext: function () { return { OPENID: CURRENT_OPENID }; },
    DYNAMIC_CURRENT_ENV: 'X',
  };
  var mod = { exports: {} };
  var fn = new Function('module', 'exports', 'require', 'console', src);
  fn(mod, mod.exports, function (p) {
    if (p === 'wx-server-sdk') return mockSdk;
    throw new Error('未预期的 require: ' + p);
  }, makeConsole());
  return mod.exports;
}

/* ── 主流程 ────────────────────────────────────────────── */

print('══ getSchedule 本地台架 ══════════════════════════════');
print('（只验云函数里的分支；真云的查询语义只能在云上量）');
print('');

var idx = 0;
function next() {
  if (idx >= cases.length) return afterCases();

  var c = cases[idx++];
  var db = makeDb(c.data || fixture(), c.broken);
  CURRENT_OPENID = c.openid;
  var fn = loadFn(db);

  return fn.main(c.event).then(function (res) {
    print('── ' + c.name + ' ' + '─'.repeat(Math.max(0, 40 - c.name.length)));
    c.check(res, db);
    print('');
    return next();
  });
}

function afterCases() {
  /* 白名单：单独一组，因为它要换一份源码 */
  var db = makeDb(fixture());
  CURRENT_OPENID = 'openid-boss';
  var fn = loadFnWithWhitelist(db, ['openid-boss']);

  print('── 白名单非空时 ' + '─'.repeat(30));
  return fn.main({ dateKeys: [DAY], passcode: '8888' }).then(function (res) {
    ok(res.isAdmin === true, '白名单里的 openid 是管理员', res.isAdmin);
    print('');
    var db2 = makeDb(fixture());
    CURRENT_OPENID = 'openid-guest';
    var fn2 = loadFnWithWhitelist(db2, ['openid-boss']);
    return fn2.main({ dateKeys: [DAY], passcode: '8888' });
  }).then(function (res) {
    ok(res.isAdmin === false,
      '白名单非空时，【口令完全失效】—— 名单外的人拿着正确口令也不是管理员', res.isAdmin);
    ok(res.bookings.every(function (b) { return b.phone === undefined; }),
      '名单外的人即使报出口令也拿不到手机号', res.bookings[0]);
    print('');
    return afterWhitelist();
  });
}

function afterWhitelist() {
  /* 撞上限：造 1000 条，应当【响亮地】失败，而不是悄悄少给几条 */
  var many = { bookings: [], prices: [] };
  for (var i = 0; i < 1000; i++) {
    many.bookings.push(bookingDoc('B' + i, DAY, ['0|' + (480 + i)], '13500135000'));
  }
  var db = makeDb(many);
  CURRENT_OPENID = 'openid-guest';
  return loadFn(db).main({ dateKeys: [DAY] }).then(function (res) {
    print('── 撞上 limit ' + '─'.repeat(34));
    ok(res.ok === false && res.reason === 'over-limit',
      '查询撞上 1000 上限时明确失败（超出部分是静默消失的，最难看）', res);
    print('');

    print('══════════════════════════════════════════════');
    print('  通过 ' + passed + ' / 失败 ' + failed);
    print('══════════════════════════════════════════════');
    if (failed > 0) print('!! 有失败 —— 别往云上传，先修代码');
  });
}

next().catch(function (e) {
  print('  ✗ 整个台架崩了：' + (e && e.name) + ' / ' + (e && e.message) + ' / ' + (e && e.stack || e));
  print('');
  print('  通过 ' + passed + ' / 失败 ' + (failed + 1));
  print('!! 有失败 —— 别往云上传，先修代码');
});
