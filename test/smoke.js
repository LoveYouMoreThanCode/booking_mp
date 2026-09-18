/* 微信小程序逻辑冒烟测试 —— 不需要微信开发者工具。
   用桩件模拟 wx API，把三个页面的 Page 对象真跑一遍。

   跑法：./test/run.sh      （macOS 自带的 jsc，不需要 node）
         node test/smoke.js  （装了 node 也行）
*/
var IS_NODE = (typeof process !== 'undefined' && process.versions && process.versions.node);
if (IS_NODE) {
  var fs = require('fs');
  var readFile = function (p) { return fs.readFileSync(p, 'utf8'); };
  var print = function (s) { process.stdout.write(s + '\n'); };
}
var console = {
  log: function () { print(Array.prototype.slice.call(arguments).join(' ')); },
  // core.refresh 的失败路径会调 warn（真机上用来提示「网络不好」）。
  // 桩件里没有它的话，那条路径一被走到就炸「not a function」。
  warn: function () {},
};

/* ── 可控时钟 ────────────────────────────────────────
   core.js 用 new Date() 判断「是否已过」。要测「晚上才打开」
   「跨天」这类场景，就得能把表拨到指定时刻。
   ──────────────────────────────────────────────────── */
var RealDate = Date;

/* 测试里的「今天」固定在一个已知的【工作日】。
   ⚠️ 原来这里没有基准日期，setClock 拨的是「真实的今天」——于是
      DATES[1]（明天）是星期几，完全取决于你哪天跑测试：
      周五跑，明天是周六；周六跑，明天是周日 —— 周末价 ¥50，
      而断言里写的是工作日价（¥45 / ¥30），一次红 20 条。
      这套测试因此是「周一到周四能过」的，之前大概率都是工作日跑的。

   只固定【日期】，时分照旧跟着真实时刻走 —— 这样修的是那一类问题，
   又不动任何「几点跑」的现有行为。DATES[5]/[6] 从此稳定是六/日，
   周末价那一段规则也才有了可测的入口。 */
var BASE_DATE = new RealDate(2026, 8, 14);   // 2026-09-14，周一
var clockOffset = (function () {
  var now = new RealDate(), base = new RealDate(BASE_DATE.getTime());
  base.setHours(now.getHours(), now.getMinutes(), now.getSeconds(), 0);
  return base.getTime() - now.getTime();
})();

function FakeDate() {
  if (arguments.length === 0) return new RealDate(RealDate.now() + clockOffset);
  var args = [null].concat(Array.prototype.slice.call(arguments));
  return new (Function.prototype.bind.apply(RealDate, args))();
}
FakeDate.now = function () { return RealDate.now() + clockOffset; };
FakeDate.parse = RealDate.parse;
FakeDate.UTC = RealDate.UTC;
FakeDate.prototype = RealDate.prototype;
Date = FakeDate;

/** 把表拨到基准日（BASE_DATE）那天的 h:m */
function setClock(h, m) {
  var t = new RealDate(BASE_DATE.getTime());
  t.setHours(h, m, 0, 0);
  clockOffset = t.getTime() - RealDate.now();
  return t;
}

var ROOT = '/Users/fanwei/Code/mini_program/miniprogram/';

/* ── 可控定时器 ──────────────────────────────────────
   contact.js 在没有待提交预约时会 setTimeout 一下再退回上一页。
   真定时器在同步跑的测试里不会触发，所以这里排个队，由 flushTimers()
   决定什么时候响 —— 这样才能测「还没退」和「退了」两种情况。
   ──────────────────────────────────────────────────── */
var timerSeq = 0, timers = {};
globalThis.setTimeout = function (fn) { timers[++timerSeq] = fn; return timerSeq; };
globalThis.clearTimeout = function (id) { delete timers[id]; };
function flushTimers() {
  var due = timers;
  timers = {};
  Object.keys(due).forEach(function (k) { due[k](); });
}

/* ── 断言 ─────────────────────────────────────────── */
var pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.log('  ✗ ' + msg); }
}
function eq(a, b, msg) { ok(a === b, msg + '  (got ' + JSON.stringify(a) + ', want ' + JSON.stringify(b) + ')'); }

/* ── wx 桩 ────────────────────────────────────────── */
var store = {};
var log = [];
var modalAnswer = true;          // 下一次 showModal 的默认答复

/* 真机的存储是【序列化落盘】的：setStorageSync 写进去的是一份拷贝，
   getStorageSync 每次返回的也是【反序列化出来的新对象】，绝不是
   你手里那个引用的同一个对象。

   桩件照这个来，是为了断掉一条【只存在于测试里】的耦合：
   core 的 BOOKINGS 和存储里那份，现在必定是两个数组。

   为什么在意：落库走的是 store.insert，它是「读一遍存储 → 改 → 写回」，
   而乐观写入已经先把订单 push 进 BOOKINGS 了。要是 BOOKINGS 恰好
   【就是】存储里那个数组，这一条订单会被 push 两次，造出一条重复订单。
   真机上不可能发生（读写都过一遍序列化）。

   ⚠️ 说清楚：现在就改成浅拷贝，这套断言【仍然是全绿的】—— 我试过，
      没能造出一条变红的用例。所以这不是在修一个已发生的 bug，
      而是把一个「凑巧不出事」的状态换成「不可能出事」：浅拷贝下
      是否重复 push，取决于哪个数组引用被交给了 setStorageSync，
      那是个没人会想到要去维护的实现细节。

   ⚠️ 改这里之前先想清楚：本文件里没有任何一处可以依赖
      「读出来的就是写进去的那个对象」。 */
function clone(v) {
  return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
}

var wx = {
  getStorageSync: function (k) { return clone(store[k]); },
  setStorageSync: function (k, v) { store[k] = clone(v); },
  removeStorageSync: function (k) { delete store[k]; },
  showToast: function (o) { log.push('toast: ' + (o.title || '')); },
  showModal: function (o) {
    log.push('modal: ' + (o.title || ''));
    if (o.success) o.success({ confirm: modalAnswer, content: o.__answer || '' });
  },
  navigateTo: function (o) { log.push('nav: ' + o.url); },
  navigateBack: function () { log.push('back'); },
  makePhoneCall: function (o) { log.push('call: ' + o.phoneNumber); },
  stopPullDownRefresh: function () {},
};

/* ── 模块加载 ─────────────────────────────────────── */
var APP = { globalData: { adminUnlocked: false, pending: null }, onLaunch: function () {} };

function setPath(obj, path, val) {
  var parts = String(path).replace(/\[(\d+)\]/g, '.$1').split('.');
  var cur = obj;
  for (var i = 0; i < parts.length - 1; i++) cur = cur[parts[i]];
  cur[parts[parts.length - 1]] = val;
}

var pageDefs = [];
function Page(def) { pageDefs.push(def); }
function App(def) { Object.keys(def).forEach(function (k) { APP[k] = def[k]; }); }
function getApp() { return APP; }

/* ── 极小的模块系统 ──────────────────────────────────
   语义和真机一致：同一个模块只求值一次，之后返回缓存。
   为什么需要它：core.js 现在 require 了 utils/store.js（不再是单个文件），
   而测试还要能「重开 App」—— 把某个模块从缓存里删掉再求值一次。

   ⚠️ 页面文件【不进缓存】：booking.js 被 loadPage 4 次、contact.js 5 次，
      每次都必须重新求值才会重新触发 Page()。缓存页面模块会让第二次
      loadPage 拿不到 pageDefs 直接抛错。 */
var MODULES = {};                       // 键 = 相对 miniprogram/ 的路径

function resolvePath(fromRel, p) {
  var stack = fromRel.split('/');
  stack.pop();
  p.split('/').forEach(function (seg) {
    if (seg === '.' || seg === '') return;
    if (seg === '..') stack.pop(); else stack.push(seg);
  });
  var out = stack.join('/');
  return /\.js$/.test(out) ? out : out + '.js';
}

function loadModule(rel) {
  if (MODULES[rel]) return MODULES[rel];
  var mod = { exports: {} };
  MODULES[rel] = mod;                   // 先登记再求值：万一将来 require 成环也不会死循环
  var req = function (p) {
    if (p.charAt(0) !== '.') throw new Error('未预期的 require: ' + p);
    // 和 Node 一样：require 拿到的是 module.exports，不是模块对象本身
    return loadModule(resolvePath(rel, p)).exports;
  };
  var fn = new Function('module', 'exports', 'require', 'wx', 'Page', 'App', 'getApp', readFile(ROOT + rel));
  fn(mod, mod.exports, req, wx, Page, App, getApp);
  return mod;
}

/** 模拟「杀掉小程序再打开」：把模块从缓存里删掉，重新求值一次 */
function reload(rel) {
  delete MODULES[rel];
  return loadModule(rel).exports;
}

function loadPage(rel) {
  pageDefs = [];
  delete MODULES[rel];                  // 页面必须每次重新求值（见上面说明）
  loadModule(rel);
  if (!pageDefs.length) throw new Error(rel + ' 没有调用 Page()');
  return makePage(pageDefs[0]);
}

function makePage(def) {
  var p = {};
  Object.keys(def).forEach(function (k) { p[k] = def[k]; });
  p.data = JSON.parse(JSON.stringify(def.data || {}));
  p.setData = function (patch, cb) {
    Object.keys(patch).forEach(function (k) { setPath(p.data, k, patch[k]); });
    if (cb) cb();
  };
  return p;
}

function ev(dataset) { return { currentTarget: { dataset: dataset || {} } }; }

/* 反复要用到的两个时刻：19:00–20:00 和 20:00–21:00 */
var T19 = { ri: 11, ci: 0, key: '0|1140' };
var T20 = { ri: 12, ci: 0, key: '0|1200' };

/* 测试默认拿「明天」当参照。基准日固定是周一，所以明天稳定是工作日
   （见顶部 BASE_DATE 的说明）—— 价格断言都按工作日价写。 */
var DAY = 1;

/* ── 同步取值助手 ────────────────────────────────────
   写操作（createBooking / setBookingStatus / 改价 / 清空）现在返回 task，
   因为接云之后结果要等网络。

   本地后端是【同步】回调的，所以 .done 注册的那一刻就能拿到结果 ——
   整套测试因此仍然是全程同步、失败仍然是 exit 3。
   拿不到（undefined）说明本地后端被改成异步了，那会让下面几百条断言
   悄悄变成假绿：所以取到的值一旦是 undefined，用它就会抛，红在 exit 3。

   ⚠️ 只给【测试】用。页面代码绝不能这么写 —— 页面必须把后续动作
      放进 .done 里，否则本地能跑、云端必崩。 */
function sync(task) {
  var out;
  task.done(function (v) { out = v; });
  return out;
}

/* ══════════════════════════════════════════════════ */
console.log('\n── 载入 core ────────────────────────────────');
var core = loadModule('utils/core.js').exports;
var CONFIG = core.CONFIG;

eq(CONFIG.courts.length, 4, '4 片场地');
eq(CONFIG.slotMin, 60, '计价粒度 60 分钟（后台改价页和客人页一样，一格一小时）');
eq(CONFIG.bookMin, 60, '预定粒度 60 分钟（客人最少订一小时）');
eq(core.SLOTS.length, 14, '每天 14 个计价档 (8:00–22:00 每小时一档)');
eq(core.HOURS.length, 14, '14 个小时行');
eq(core.BOOKS.length, 14, '14 个可订段 (8:00–22:00 每小时一段)');
eq(core.DATES.length, 7, '未来 7 天');

/* ── 演示数据的 fixture ────────────────────────────────
   这段原来在 core.js 里，由 app.js 的 onLaunch 自动调用 —— 而 smoke.js
   从不加载 app.js，所以那一行是【零覆盖】的。

   为什么搬到测试里：接云之后「本机已灌过」那个标记不存在了，每个新客人
   第一次打开都会往共享数据库里灌 13 条假订单。生产代码不该夹带假手机号
   和「必须灌一次」的逻辑，而测试确实需要一张有数据的表格。

   说清楚它现在【管多少事】：只有紧接着的 4 条断言（13 / 4 / 8 / 1 条的
   状态分布）依赖它。装完之后第 336 行就 clearAllData 了，后面每一节都
   自己造数据。所以别以为它撑着「几十条断言」—— 实测过：整段删掉，
   红的正好就是那 4 条。

   那还留着它干嘛：这 13 条是「一张有数据的表格」的样子，一条不差地
   搬自原来的 seedDemoBookings。数量少了这几条就退化成「随便塞几条」。

   ⚠️ 改这 13 条就得同步改那 4 条数字，否则红的地方看起来和改动无关。 */

var storeMod = loadModule('utils/store.js').exports;

/* ⚠️ 出货配置是 cloudBackend，但【这一整套断言跑本地后端】。
   原因是硬的：云端后端异步 settle，而这里几百条断言是同步写的
   （靠的就是「本地后端在 .done() 注册的那一刻同步回调」）。
   不切的话，下面每个 store.* 都会去打 wx.cloud —— 而桩件里没有它。

   所以「出货用的到底是哪个后端」由末尾那条【静态断言】直接读源码盯着，
   不由这里的行为断言盯着。那两种失败模式不一样：行为断言能发现
   本地后端坏了，发现不了开关被人改回 localBackend。 */
storeMod._useBackend(storeMod._backends.localBackend);

function demoBookings() {
  var now = Date.now();                     // 测试里的 Date 是桩件，可控
  var H = function (h) { return h * 60; };

  var mk = function (dayIdx, ci, from, to, phone, name, note, status, hoursAgo) {
    var slotKeys = [];
    var total = 0;
    for (var m = from; m < to; m += CONFIG.slotMin) {
      slotKeys.push(ci + '|' + m);
      total += core.priceFor(dayIdx, ci, m);
    }
    var t = now - hoursAgo * 3600e3;
    return {
      id: 'B' + t.toString(36) + Math.random().toString(36).slice(2, 5),
      createdAt: t, updatedAt: t,
      dateKey: core.toDateKey(core.DATES[dayIdx]),
      items: [{ ci: ci, court: CONFIG.courts[ci], from: from, to: to, price: total }],
      slotKeys: slotKeys, phone: phone, name: name, note: note,
      total: total, status: status,
      reply: status === core.CONFIRMED ? '电话已确认' : '',
    };
  };

  return [
    mk(1, 1, H(19), H(20), '13700137003', '王强', '带小朋友，麻烦留矮网', core.PENDING, 0.4),
    mk(1, 3, H(20), H(21), '13600136004', '陈静', '', core.PENDING, 1.2),
    mk(2, 0, H(9),  H(10), '13500135005', '刘洋', '公司团建，8 个人', core.PENDING, 2.6),
    mk(3, 2, H(18), H(20), '13400134006', '赵敏', '', core.PENDING, 5.1),

    mk(0, 0, H(18), H(19), '13800138001', '张伟', '需要球网', core.CONFIRMED, 30),
    mk(0, 2, H(20), H(21), '13900139002', '李娜', '', core.CONFIRMED, 26),
    mk(1, 0, H(8),  H(9),  '13300133007', '孙磊', '每周固定', core.CONFIRMED, 20),
    mk(1, 2, H(15), H(17), '13200132008', '周涛', '', core.CONFIRMED, 18),
    mk(2, 1, H(17), H(18), '13100131009', '吴倩', '租两支球拍', core.CONFIRMED, 12),
    mk(2, 3, H(19), H(20), '13000130010', '郑凯', '', core.CONFIRMED, 9),
    mk(3, 0, H(10), H(11), '15900159011', '马丽', '', core.CONFIRMED, 7),
    mk(4, 2, H(21), H(22), '15800158012', '黄鹏', '晚场，别锁门', core.CONFIRMED, 4),

    mk(2, 0, H(14), H(15), '15700157013', '徐婷', '', core.CANCELLED, 8),
  ];
}

/* 装进内存：先落存储，再走一次 refresh 拉回来 ——
   和页面 onShow 走的是同一条路，不直接碰 core 的内部数组。
   （只 push 进 BOOKINGS 是不够的：下一次 refresh 会被存储里的空数据覆盖掉。） */
storeMod.replaceBookings(demoBookings());
core.refresh(function () {});

eq(core.BOOKINGS.length, 13, '演示数据 13 条');
eq(core.countByStatus(core.PENDING), 4, '待确认 4 条');
eq(core.countByStatus(core.CONFIRMED), 8, '已确认 8 条');
eq(core.countByStatus(core.CANCELLED), 1, '已取消 1 条');

core.clearAllData();
eq(core.BOOKINGS.length, 0, '清空后为 0 条');

/* ══════════════════════════════════════════════════ */
console.log('\n── store 的同步回调契约 ─────────────────────');
/* 本地后端在 .done() 注册的那一刻【同步】回调 —— 这是整套测试能全程
   同步跑下去的前提，也是页面必须把「拿到数据之后要做的事」写进 done 的
   原因（云端后端是异步回调，写到 done 外面就会「提示已提交、实际没提交」）。

   如果将来有人把本地后端改成 setTimeout 式（比如想「模拟网络延迟」），
   这条会立刻红在 exit 3 —— 而不是让下面几百条断言悄悄变成假绿。
   整个设计就靠这一条守着。 */
var syncCalled = false;
core.refresh(function () { syncCalled = true; });
ok(syncCalled, '本地后端在 done 注册时就同步回调（测试才能全程同步）');

// refresh 之后内存缓存要和存储对齐
core.clearAllData();
var bSync = sync(core.createBooking({
  dayIdx: DAY, groups: [{ ci: 0, court: '1号场', from: 1200, to: 1260 }],
  phone: '13800138000', name: '同步测试', note: '',
}));
eq(bSync.ok, true, 'createBooking 正常落单');
eq(core.BOOKINGS.length, 1, '订单进了内存工作集');
eq(core.spanStatus(DAY, 0, 1200, 1260), 'pending', '占用状态立刻生效');
core.clearAllData();

/* ══════════════════════════════════════════════════ */
console.log('\n── 客人页 booking ───────────────────────────');
var bk = loadPage('pages/booking/booking.js');
bk.onLoad();
eq(bk.data.gridRows.length, 14, '网格 14 行');
eq(bk.data.gridRows[0].courts.length, 4, '每行 4 片场地');
eq(bk.data.gridRows[0].label, '08:00', '行首是整点');
eq(bk.data.hasSelection, false, '初始无选中');

bk.onTapDate(ev({ idx: DAY }));
eq(bk.data.currentDay, DAY, '切到明天');

eq(core.spanStatus(DAY, 0, 1140, 1200), 'free', '19:00–20:00 空闲');
eq(bk.data.gridRows[11].courts[0].text, '90', '19:00–20:00 显示 ¥90（工作日晚上 90/小时）');

bk.onTapCell(ev(T19));
eq(bk.sel.size, 1, '选中 1 段');
eq(bk.data.gridRows[11].courts[0].cls, 'cell selected', '格子 class 变 selected');
eq(bk.data.footCount, 1, '底部计数 1');
eq(bk.data.footHours, 1, '底部小时数 1');
eq(bk.data.footTotal, 90, '底部件计 ¥90');
eq(bk.data.footLines[0].time, '19:00–20:00', '一段就是一小时');

bk.onTapCell(ev(T20));
eq(bk.sel.size, 2, '再选一段 → 2');
eq(bk.data.footTotal, 180, '合计 ¥180');
eq(bk.data.footLines.length, 1, '相邻两小时合并成 1 段');
eq(bk.data.footLines[0].time, '19:00–21:00', '合并区间 19:00–21:00');
eq(bk.data.footHours, 2, '底部小时数 2');

bk.onTapCell(ev(T19));
eq(bk.sel.size, 1, '再点一次取消选中');

/* 段价是「段内每一档逐个相加」，不是「某一档的价 × 档数」。
   把 19:00 单独改成 ¥99，再订 18:00–20:00 两个小时：
   应该是 90 + 99 = ¥189，而不是 99 × 2 = ¥198（也不能是 90 × 2）。 */
core.setOverride(DAY, 1, 1140, 99);
bk.sel.clear();
bk.buildGrid();                                       // 价格改了，格子得重画
bk.onTapCell(ev({ ri: 10, ci: 1, key: '1|1080' }));   // 18:00–19:00
bk.onTapCell(ev({ ri: 11, ci: 1, key: '1|1140' }));   // 19:00–20:00
eq(bk.data.gridRows[10].courts[1].text, '90', '18:00 那一格还是规则价 ¥90');
eq(bk.data.gridRows[11].courts[1].text, '99', '19:00 那一格是手改价 ¥99');
eq(bk.data.footTotal, 189, '段价逐档相加（90 + 99），不是单价×档数');
core.clearOverride(DAY, 1, 1140);

/* 提交：预约页只负责把选择交给填写页。
   填写页是独立页面而不是贴底弹层 —— 输入框在真机上「打字时看不见、
   收起键盘才出现」的根源就是「fixed 贴底弹层 + 原生输入控件」那个组合。 */
bk.sel.clear();
bk.onTapCell(ev(T19));
bk.onSubmit();
ok(!!APP.globalData.pending, '选择交给填写页了');
eq(APP.globalData.pending.keys.length, 1, '带过去 1 格');
eq(APP.globalData.pending.dayIdx, DAY, '带上的是当前这一天');
eq(APP.globalData.pending.total, 90, '带过去的合计 ¥90');
ok(log.indexOf('nav: /pages/contact/contact') >= 0, '跳转到填写页');

/* ── 填写页 contact ─────────────────────────── */
console.log('\n── 填写页 contact ──────────────────────────');
var ct = loadPage('pages/contact/contact.js');
ct.onLoad();
eq(ct.data.items.length, 1, '填写页拿到清单');
eq(ct.data.total, 90, '填写页合计 ¥90');
eq(ct.data.count, 1, '填写页 1 小时');

/* 三个框的处理方式一模一样：打字时只往实例上存，
   一个字都不进 data、一次 setData 都不发 —— 打字过程中页面完全不动。 */
ct.onInputPhone({ detail: { value: '13800138000' } });
eq(ct.phone, '13800138000', '输入写进实例');
eq(ct.data.phone, undefined, '输入【不】回写 data —— 回写就成了受控输入');
eq(ct.data.phoneLen, undefined, '打字时不数数（原来那行实时字数已去掉）');

/* 输入框里原样存着，过滤非数字挪到提交时做 ——
   在输入时过滤就得把结果写回输入框，那又变回受控输入了。 */
ct.onInputPhone({ detail: { value: '139 0013-9000' } });
eq(ct.phone, '139 0013-9000', '实例里原样保存，输入时不改写');
ct.onInputName({ detail: { value: '王先生' } });
eq(ct.name, '王先生', '称呼只用同一个写法');
ct.onInputNote({ detail: { value: '需要球网' } });
eq(ct.note, '需要球网', '备注也是');

ct.onInputPhone({ detail: { value: '13800138000' } });
ct.onInputName({ detail: { value: '' } });
ct.onInputNote({ detail: { value: '' } });
ct.onConfirm();
eq(core.BOOKINGS.length, 1, '下单成功');
eq(core.BOOKINGS[0].phone, '13800138000', '订单里存的是纯数字手机号');
eq(core.BOOKINGS[0].total, 90, '订单金额 ¥90');
eq(core.BOOKINGS[0].slotKeys.length, 1, '占 1 个计价档（一小时就是一档）');
eq(core.BOOKINGS[0].status, 'pending', '初始状态待确认');
eq(ct.data.showDone, true, '成功页显示');
ok(ct.data.doneText.indexOf('138****8000') >= 0, '成功页手机号打码：' + ct.data.doneText);
eq(APP.globalData.pending, null, '提交后清掉 pending，免得返回再进来重复提交');

/* 手机号不合法：不落单 */
APP.globalData.pending = {
  dayIdx: DAY, keys: ['0|1200'], items: [], total: 90, hours: 1, count: 1,
};
var ct2 = loadPage('pages/contact/contact.js');
ct2.onLoad();
ct2.onInputPhone({ detail: { value: '123-45' } });
ct2.onConfirm();
eq(ct2.data.phoneErr, true, '手机号不合法时报错（校验用的是去掉非数字后的值）');
eq(core.BOOKINGS.length, 1, '未创建订单');

/* 报错之后客人接着改：提示不能跟着他一跳一跳地闪，也不能要求他先点掉
   再重填 —— 就让它留着，等他改完再点一次「确认提交」时统一重判。
   （改对了确实能提交，这条由上面 ct 那条成功用例覆盖，这里不重复下单。） */
ct2.onInputPhone({ detail: { value: '123-456' } });
eq(ct2.data.phoneErr, true, '继续输入时错误提示不动');
ct2.onInputPhone({ detail: { value: '13800138000' } });
eq(ct2.data.phoneErr, true, '改对了也等下一次提交再判，打字过程中一次 setData 都不发');
eq(core.BOOKINGS.length, 1, '这两个输入过程都没有产生订单');

/* 提交前时段被人抢走：剔除、重算清单，不落单 */
APP.globalData.pending = {
  dayIdx: DAY, keys: ['0|1140', '0|1200'], items: [], total: 180, hours: 2, count: 2,
};
var ct3 = loadPage('pages/contact/contact.js');
ct3.onLoad();
ct3.onInputPhone({ detail: { value: '13800138000' } });
ct3.onConfirm();
eq(core.BOOKINGS.length, 1, '有冲突时不落单');
eq(ct3.data.count, 1, '清单里剔掉了被抢走的那段');
eq(ct3.data.total, 90, '金额跟着重算成 ¥90');
ok(log[log.length - 1].indexOf('已剔除') >= 0, '提示剔除了冲突时段：' + log[log.length - 1]);

/* 没有待提交的预约就直接进填写页 → 提示并退回，不要卡在空表单上 */
APP.globalData.pending = null;
var ct4 = loadPage('pages/contact/contact.js');
ct4.onLoad();
ok(log.indexOf('toast: 请先选择时段') >= 0, '没有待提交的预约时给提示');
flushTimers();
ok(log.indexOf('back') >= 0, '并退回上一页');

/* 从填写页返回：网格要重新拉一遍，别拿旧状态糊弄客人 */
bk.sel.clear();
bk.onShow();
eq(bk.data.gridRows[11].courts[0].text, '待', '别人订走的格子返回后显示「待」');
bk.onTapCell(ev(T19));
eq(bk.sel.size, 0, '已占的格子点不动');

/* 返回时【不清空】选择，只把约不上的挑掉 ——
   客人往往正想接着改，一刀切清空等于让他白选一遍。 */
bk.sel.add('0|1140');            // 已经被上面那单占走
bk.sel.add('0|1200');            // 还空着
bk.onShow();
eq(bk.sel.size, 1, '返回本页时只挑掉约不上的');
ok(bk.sel.has('0|1200'), '还空着的选择留着');
eq(bk.data.hasSelection, true, '底栏跟着更新');

/* ══════════════════════════════════════════════════ */
console.log('\n── 管理页 orders ────────────────────────────');
modalAnswer = false;             // 弹窗默认点「取消」
var od = loadPage('pages/orders/orders.js');
od.onShow();
eq(od.data.tabs.length, 3, '3 个分页');
eq(od.data.tabs[0].count, 1, '待确认计数 1');
eq(od.data.active, 'pending', '默认在待确认');
eq(od.data.list.length, 1, '待确认列表 1 条');
eq(od.data.list[0].badgeText, '待确认', '卡片角标');
eq(od.data.list[0].courtText, '1号场', '卡片场地');
eq(od.data.list[0].timeText, '19:00–20:00', '卡片时段是一整小时');
eq(od.data.list[0].total, 90, '卡片金额 ¥90');
eq(od.data.list[0].canConfirm, true, '可确认');
eq(od.data.list[0].canCancel, true, '可取消');
eq(od.data.list[0].canRestore, false, '不可恢复');

var bid = od.data.list[0].id;
od.onConfirm(ev({ id: bid }));
eq(core.findBooking(bid).status, 'confirmed', '确认后状态已确认');
eq(od.data.list.length, 0, '移出待确认列表');
eq(od.data.tabs[1].count, 1, '已确认计数 1');

od.onTapTab(ev({ key: 'confirmed' }));
eq(od.data.list.length, 1, '已确认列表 1 条');
eq(od.data.list[0].canCancel, true, '已确认可取消');
eq(od.data.list[0].canConfirm, false, '已确认不可再确认');

od.onCancel(ev({ id: bid }));    // modalAnswer=false，应被拦下
eq(core.findBooking(bid).status, 'confirmed', '取消弹窗点「否」不生效');

modalAnswer = true;
od.onCancel(ev({ id: bid }));
eq(core.findBooking(bid).status, 'cancelled', '取消生效');

od.onTapTab(ev({ key: 'cancelled' }));
eq(od.data.list.length, 1, '已取消列表 1 条');
eq(od.data.list[0].canRestore, true, '可恢复');

od.onRestore(ev({ id: bid }));
eq(core.findBooking(bid).status, 'pending', '恢复为待确认');

/* ── 恢复撞车：守卫在服务端，页面只管把结果摆给老板看 ────────
   这一段原来断的是「客户端自己查缓存、把恢复拦下来」。那段检查被搬进
   updateBooking 的事务里了，因为客户端手上那份列表在两台手机上可以
   同时是过期的 —— 两个管理员各拿一份过期的，可以把一单恢复到同一个
   已经被占的格子上，「一格一单」当场就没了。

   本地后端没有事务，所以【这个守卫在本地测不出来】，也不该假装测到了
   （它在真云上，见 README 的真机验收第 5 条）。本地能测、也在这里测的是
   orders.js 那一半：服务端回 slot-taken 之后，老板必须看到那个弹窗，
   订单必须弹回已取消 —— 而不是留在界面上假装恢复成功。 */
core.cancelBooking(bid);
var b2 = sync(core.createBooking({
  dayIdx: DAY, groups: [{ ci: 0, court: '1号场', from: 1140, to: 1200 }],
  phone: '13900139000', name: '后来的人', note: '',
}));
eq(b2.ok, true, '第二单创建成功（占住刚释放的 19:00）');

od.onShow();

/* 临时换一个「update 必定被服务端拒掉」的后端。形状照抄 store.js 里
   unwrapCloud 造出来的那个错：cloudReason 给 core 翻译成人话，
   cloudTaken 给页面数有几格被占。 */
var LB = storeMod._backends.localBackend;
var clashBackend = Object.create(LB);
clashBackend.update = function () {
  var t = storeMod.makeTask();
  var e = new Error('云函数返回 ok:false: slot-taken');
  e.cloudReason = 'slot-taken';
  e.cloudTaken = ['0|1140'];
  t.settle(e);
  return t;
};

log.length = 0;
storeMod._useBackend(clashBackend);
od.onRestore(ev({ id: bid }));
storeMod._useBackend(LB);

eq(core.findBooking(bid).status, 'cancelled', '服务端拒绝后订单弹回已取消（界面没骗老板）');
ok(log.indexOf('modal: 时段已被占用') >= 0, '被拒绝时弹窗说明是哪些格子被占了');
ok(log.indexOf('toast: 已恢复为待确认') < 0, '被拒绝时【不许】报恢复成功');

/* ══════════════════════════════════════════════════ */
console.log('\n── 改价页 pricing ───────────────────────────');
var pr = loadPage('pages/pricing/pricing.js');
pr.onLoad();
pr.onTapDate(ev({ idx: DAY }));   // 改价页默认停在第 0 天，先切到明天
eq(pr.data.currentDay, DAY, '改价页切到明天');
eq(pr.data.gridRows.length, 14, '改价页仍是 14 小时行');
/* 「一格一小时」是这次改动的重点：改价页和客人页粒度一致，
   老板填 90 这一小时就是 90，客人看到的也是 90。 */
eq(pr.data.gridRows[0].courts[0].key, '0|480', '一格就是一小时（08:00 那格）');
eq(pr.data.gridRows[0].courts[0].text, '60', '08:00 规则价 ¥60（工作日白天）');
eq(pr.data.hasSel, false, '初始无选中');
eq(pr.data.overrideCount, 0, '初始无手改');

// 明天 1 号场 20:00 规则价 = 90（工作日晚上）
eq(core.priceFor(DAY, 0, 1200), 90, '改价前 20:00 规则价 ¥90');

// 点整列：场地表头
pr.onTapCourtHead(ev({ ci: 0 }));
eq(pr.sel.size, 14, '点场地名选中整列 14 档');
eq(pr.data.selCount, 14, '工具条显示已选 14');
eq(pr.data.gridRows[0].courts[0].cls, 'cell selected', '整列变选中');

pr.onClearSel();
eq(pr.sel.size, 0, '清空选择');

// 点整行：时间列（20:00 → 1 格 × 4 场地 = 4）
pr.onTapRowLabel(ev({ min: 1200 }));
eq(pr.sel.size, 4, '点时间选中整行 4 格');
pr.onClearSel();

// 点整行再点一次 = 全取消
pr.onTapRowLabel(ev({ min: 1200 }));
pr.onTapRowLabel(ev({ min: 1200 }));
eq(pr.sel.size, 0, '整行再点一次全取消');

// 单格选中 + 应用价格
pr.onTapCell(ev({ key: '0|1200' }));
eq(pr.sel.size, 1, '选中 1 格');

pr.onApply();
eq(core.hasOverride(DAY, 0, 1200), false, '没填价格时不生效');

pr.onInputPrice({ detail: { value: 'ab88元' } });
eq(pr.data.priceInput, '88', '价格输入过滤非数字');

pr.onApply();
eq(core.hasOverride(DAY, 0, 1200), true, '价格已覆盖');
eq(core.priceFor(DAY, 0, 1200), 88, '这一小时变成 ¥88');
eq(pr.sel.size, 0, '应用后自动清空选择');
eq(pr.data.gridRows[12].courts[0].cls, 'cell override', '格子标记为已手改');
eq(pr.data.gridRows[12].courts[0].text, '88', '格子显示新价');
eq(pr.data.overrideCount, 1, '本日已手改 1 格');
eq(pr.data.priceInput, '', '应用后清空输入框');

// 快捷价签
pr.onTapQuick({ currentTarget: { dataset: { v: 50 } } });
eq(pr.data.priceInput, '50', '快捷价签填入 50');

// 恢复规则价
pr.onTapCell(ev({ key: '0|1200' }));
pr.onResetRule();
eq(core.hasOverride(DAY, 0, 1200), false, '已恢复规则价');
eq(core.priceFor(DAY, 0, 1200), 90, '价格回到 ¥90');
eq(pr.data.gridRows[12].courts[0].text, '90', '格子显示回规则价');

/* ══════════════════════════════════════════════════ */
console.log('\n── 端到端：老板改价 → 客人看到 ───────────────');
pr.onTapCell(ev({ key: '2|1080' }));      // 明天 3 号场 18:00 这一小时
pr.onInputPrice({ detail: { value: '99' } });
pr.onApply();
eq(core.priceFor(DAY, 2, 1080), 99, '老板把 3 号场 18:00 改成 ¥99');
eq(core.priceFor(DAY, 2, 1140), 90, '19:00 还是规则价 ¥90');

var bk2 = loadPage('pages/booking/booking.js');
bk2.onLoad();
bk2.onTapDate(ev({ idx: DAY }));
eq(bk2.data.gridRows[10].courts[2].text, '99', '客人页这一格就是 ¥99（一小时，不再拼两个半小时）');
bk2.onTapCell(ev({ ri: 10, ci: 2, key: '2|1080' }));
eq(bk2.data.footTotal, 99, '客人下单计价 ¥99');

bk2.onSubmit();
var ct5 = loadPage('pages/contact/contact.js');
ct5.onLoad();
ct5.onInputPhone({ detail: { value: '13712345678' } });
ct5.onConfirm();
var last = core.BOOKINGS[core.BOOKINGS.length - 1];
eq(last.total, 99, '订单快照价 ¥99');

// 老板事后改价，不应影响已提交订单
core.setOverride(DAY, 2, 1080, 200);
eq(core.priceFor(DAY, 2, 1080), 200, '老板改成 ¥200');
eq(core.priceFor(DAY, 2, 1140), 90, '19:00 仍是 ¥90');
eq(last.total, 99, '已提交订单仍是 ¥99（价格快照）');

/* ══════════════════════════════════════════════════ */
console.log('\n── 边界 ─────────────────────────────────────');
core.clearAllData();
var r = sync(core.createBooking({
  dayIdx: 1, groups: [{ ci: 0, court: '1号场', from: 480, to: 540 }],
  phone: '13000000000', name: '', note: '',
}));
eq(r.ok, true, '正常下单');
eq(r.skipped.length, 0, '无冲突');

/* 部分冲突：订 08:00–10:00，其中 08:00 那一小时已被 r 占了。
   一小时粒度下一段就是整数个小时，所以这里是「2 档里剔掉 1 档」。 */
var r2 = sync(core.createBooking({
  dayIdx: 1,
  groups: [{ ci: 0, court: '1号场', from: 480, to: 600 }],   // 480 已占，540 空闲
  phone: '13000000001', name: '', note: '',
}));
eq(r2.ok, true, '部分冲突仍可下单');
eq(r2.skipped.length, 1, '剔除 1 个已占档');
eq(r2.booking.slotKeys.length, 1, '只占 1 档');

var r3 = sync(core.createBooking({
  dayIdx: 1, groups: [{ ci: 0, court: '1号场', from: 480, to: 540 }],
  phone: '13000000002', name: '', note: '',
}));
eq(r3.ok, false, '全冲突时下单失败');
eq(r3.skipped.length, 1, '这一小时被剔除');

core.cancelBooking(r.booking.id);
eq(core.slotStatus(1, 0, 480), 'free', '取消后时段重新开放');

// 跨场地分组：同场地相邻小时并成一段，不同场地各算各的
var g = core.groupSlots([
  { ci: 0, min: 600 }, { ci: 1, min: 600 }, { ci: 0, min: 660 },
]);
eq(g.length, 2, '跨场地拆成 2 段');
eq(g[0].court, '1号场', '第一段 1 号场');
eq(g[0].from, 600, '第一段 10:00 起');
eq(g[0].to, 720, '第一段 10:00–12:00（同场地两小时并成一段）');
eq(g[1].court, '2号场', '第二段 2 号场');

// 一小时粒度下的合并：600 和 660 应该并成 10:00–12:00
var g2 = core.groupSlots([{ ci: 0, min: 600 }, { ci: 0, min: 660 }], CONFIG.bookMin);
eq(g2.length, 1, '按一小时粒度合并成 1 段');
eq(g2[0].from, 600, '从 10:00 起');
eq(g2[0].to, 720, '到 12:00 止');

/* ══════════════════════════════════════════════════ */
console.log('\n── 已过时段 / 晚上打开 ──────────────────────');
/* 之前这里踩过坑：过期格子给的是 #DCDCDC 画在 #FAFAFA 上，
   几乎看不见，老板真机上看到的是一屏「没有价格的空白格」，
   以为界面坏了。所以既要保证行为对，也要保证显示是对的。 */
core.clearAllData();

setClock(20, 15);
core.refreshDates();
var nb = loadPage('pages/booking/booking.js');
nb.onLoad();
nb.onShow();

eq(nb.data.currentDay, 0, '今天还有 20:00–22:00 可约，不该跳走');
eq(nb.data.dayHint, '今天 20:00 之前的时段已过，之后的都可以约',
   '提示条说明灰格子的原因');
eq(nb.data.gridRows[11].courts[0].text, '—', '19:00–20:00 显示为已过');
eq(nb.data.gridRows[11].courts[0].cls, 'cell past', '已过的样式是 cell past');
eq(nb.data.gridRows[12].courts[0].text, '90', '20:00–21:00 正常显示价格');
eq(nb.data.gridRows[12].courts[0].cls, 'cell', '20:00–21:00 可约');

nb.sel.clear();
nb.onTapCell(ev({ ri: 11, ci: 0, key: '0|1140' }));   // 19:00–20:00 已结束
eq(nb.sel.size, 0, '已结束的段点不动');
nb.onTapCell(ev({ ri: 12, ci: 0, key: '0|1200' }));   // 20:00–21:00 进行中
eq(nb.sel.size, 1, '还没结束的段点得动');

/* 老板定的规则：时段一开始就算「过了开始时间」，但整段没结束就还能卖。
   客人愿意花钱买一段已经开始的时段，我们允许。 */
eq(core.spanStatus(0, 0, 1200, 1260), 'free', '已开始但未结束的段仍可订');

var px = sync(core.createBooking({
  dayIdx: 0, groups: [{ ci: 1, court: '2号场', from: 1200, to: 1260 }],
  phone: '13111111112', name: '', note: '',
}));
eq(px.ok, true, '已经开始的段能落单（客人牺牲一点时间）');
eq(px.booking.slotKeys.length, 1, '这一小时整段占上（一小时粒度就一格）');

// 整段已经结束的，落单这层也要自己扛住，不能只靠界面拦
var py = sync(core.createBooking({
  dayIdx: 0, groups: [{ ci: 2, court: '3号场', from: 1140, to: 1200 }],
  phone: '13111111111', name: '', note: '',
}));
eq(py.ok, false, '已结束的段直接在落单层被拒');
eq(py.skipped.length, 1, '这一小时被剔除');

// 深夜打开：今天全过完了，应该自动跳到明天
setClock(22, 30);
core.refreshDates();
var lb = loadPage('pages/booking/booking.js');
lb.onLoad();
lb.onShow();
eq(lb.data.currentDay, 1, '今天已过完，自动跳到明天');
eq(lb.data.dayHint, '', '明天没有过期问题，不弹提示');
eq(lb.data.gridRows[0].courts[0].text, '60', '明天 8:00–9:00 正常显示 ¥60（一小时一格）');

// 提示文案的分支
eq(lb.buildHint(1, 0), '这天已无可约时段，换个日期看看', '未来某天全满的提示');
eq(lb.buildHint(1, 5), '', '未来某天有空时不弹提示');
eq(lb.buildHint(0, 0), '今天已无可约时段，点上面的日期换一天', '今天全满的提示');

setClock(12, 0);   // 拨回白天，别影响后面的输出

/* ══════════════════════════════════════════════════ */
console.log('\n── 手改价要扛得住重启 ───────────────────────');
/* 原来 PRICE_OVERRIDES 只是个内存对象，从来没进过存储：
   老板在改价页改完价、关掉小程序再打开，价格全回到规则价。

   「重启」= 把 core.js 重新求值一遍（模块级变量全部重建、重新读一次存储），
   而存储本身不动 —— wx 桩里的 store 对象在两次载入之间是同一份。
   reload() 会先把它从模块缓存里删掉，所以拿到的是全新实例。

   注意 store.js 本身【不需要】跟着重载：它不持有任何内存数据，
   每次调用都重新读存储 —— 这正是「store 不存状态」这条规矩的用处。 */
core.clearAllData();

var prR = loadPage('pages/pricing/pricing.js');
prR.onLoad();
prR.onTapDate(ev({ idx: DAY }));
prR.onTapCell(ev({ key: '0|1200' }));
prR.onInputPrice({ detail: { value: '88' } });
prR.onApply();
eq(core.priceFor(DAY, 0, 1200), 88, '改价后当场生效');

core = reload('utils/core.js');              // ← 重开 App
eq(core.priceFor(DAY, 0, 1200), 88, '重启后手改价还在（不再回到 ¥90）');
ok(core.hasOverride(DAY, 0, 1200), '重启后仍然是「已手改」状态');

var prR2 = loadPage('pages/pricing/pricing.js');   // 页面要跟着重载，否则握的还是旧 core
prR2.onLoad();
prR2.onTapDate(ev({ idx: DAY }));
eq(prR2.data.gridRows[12].courts[0].text, '88', '重启后改价页显示的是手改价');
eq(prR2.data.overrideCount, 1, '重启后手改计数 1');

// 「清空数据」要把持久化的手改价一起清掉，否则清完价格还是旧的
core.clearAllData();
core = reload('utils/core.js');
eq(core.priceFor(DAY, 0, 1200), 90, '「清空数据」后手改价也被清掉，回到 ¥90');

/* 批量写的两条路径也过一遍（改价页「应用到选中」一次可能 14 格） */
var prR3 = loadPage('pages/pricing/pricing.js');
prR3.onLoad();
prR3.onTapDate(ev({ idx: DAY }));
prR3.onTapCell(ev({ key: '0|1200' }));
prR3.onTapCell(ev({ key: '0|1260' }));
prR3.onInputPrice({ detail: { value: '77' } });
prR3.onApply();
eq(core.hasOverride(DAY, 0, 1200) && core.hasOverride(DAY, 0, 1260), true,
  '批量改价：一次写多个格子都生效');
prR3.onTapCell(ev({ key: '0|1200' }));
prR3.onTapCell(ev({ key: '0|1260' }));
prR3.onResetRule();
eq(core.hasOverride(DAY, 0, 1200) || core.hasOverride(DAY, 0, 1260), false,
  '批量恢复规则价：多个格子一起清掉');

core.clearAllData();

/* ══════════════════════════════════════════════════ */
console.log('\n── 落库失败要回滚（接云之后这就是日常）─────');
/* 本地后端写 storage 几乎不会失败，所以这里把 wx.setStorageSync 临时换成
   抛异常，模拟「网断了 / 云函数报错 / 数据库写不进去」。

   要验的不是「内存回滚了」本身，而是【界面上不能出现假象】：
     客人不能看到「已提交」而其实什么都没落库，
     老板不能看到卡片变成「已确认」而云端根本没改。
   所以每条都同时盯两件事：内存回滚 + 页面确实收到了 .fail 并报了错。 */
function breakWrites() {
  var real = wx.setStorageSync;
  wx.setStorageSync = function () { throw new Error('模拟落库失败'); };
  return function () { wx.setStorageSync = real; };
}

setClock(12, 0);
core.refreshDates();
core.clearAllData();

/* ① 客人下单落库失败 */
var fix1 = breakWrites();
var bkF = loadPage('pages/booking/booking.js');
bkF.onLoad();
bkF.onTapDate(ev({ idx: DAY }));
bkF.sel.clear();
bkF.onTapCell(ev(T19));
bkF.onSubmit();

var ctF = loadPage('pages/contact/contact.js');
ctF.onLoad();
ctF.onInputPhone({ detail: { value: '13800138000' } });
log.length = 0;
ctF.onConfirm();

eq(core.BOOKINGS.length, 0, '落库失败：内存里不留那条假订单（已回滚）');
eq(core.spanStatus(DAY, 0, 1140, 1200), 'free', '落库失败：时段没被占住');
eq(ctF.data.showDone, false, '落库失败：【绝不能】给客人看成功页');
ok(log.indexOf('toast: 提交失败，请检查网络后重试') >= 0, '落库失败：如实提示提交失败');
ok(!!APP.globalData.pending, '落库失败：pending 留着不消费，客人再点一次就是重试');
fix1();

/* ② 恢复写入之后，同一笔预约能正常提交（说明上面拦住的只是那一次失败） */
log.length = 0;
ctF.onConfirm();
eq(core.BOOKINGS.length, 1, '存储恢复后重试成功');
eq(ctF.data.showDone, true, '重试成功后正常显示成功页');
eq(APP.globalData.pending, null, '成功后 pending 才被清掉');

/* ③ 老板改状态落库失败 */
var odF = loadPage('pages/orders/orders.js');
odF.onShow();
var fid = core.BOOKINGS[0].id;
var fix2 = breakWrites();
log.length = 0;
odF.onConfirm(ev({ id: fid }));
eq(core.findBooking(fid).status, 'pending', '落库失败：状态回滚成待确认');
eq(odF.data.tabs[0].count, 1, '落库失败：待确认计数没被改花');
eq(odF.data.list.length, 1, '落库失败：订单仍在待确认列表里（界面没骗老板）');
ok(log.indexOf('toast: 操作失败，请检查网络后重试') >= 0, '落库失败：如实提示操作失败');
fix2();

log.length = 0;
odF.onConfirm(ev({ id: fid }));
eq(core.findBooking(fid).status, 'confirmed', '存储恢复后重试成功');
ok(log.indexOf('toast: 已确认') >= 0, '重试成功后才报「已确认」');

/* ④ 老板改价落库失败 */
var pgF = loadPage('pages/pricing/pricing.js');
pgF.onLoad();
pgF.onTapDate(ev({ idx: DAY }));
pgF.onTapCell(ev({ key: '0|1200' }));
pgF.onInputPrice({ detail: { value: '77' } });
var fix3 = breakWrites();
log.length = 0;
pgF.onApply();
eq(core.hasOverride(DAY, 0, 1200), false, '落库失败：手改价已撤回');
eq(core.priceFor(DAY, 0, 1200), 90, '落库失败：价格回到规则价 ¥90');
eq(pgF.data.gridRows[12].courts[0].text, '90', '落库失败：格子重画回真实价格');
eq(pgF.sel.size, 1, '落库失败：选择留着，老板再点一次就是重试');
ok(log.indexOf('toast: 改价失败，请检查网络后重试') >= 0, '落库失败：如实提示改价失败');
fix3();

log.length = 0;
pgF.onApply();
eq(core.priceFor(DAY, 0, 1200), 77, '存储恢复后重试成功');
eq(pgF.sel.size, 0, '重试成功后选择才清空');

/* ⑤ 清空数据是两步写（订单 + 价格），任何一步失败都要整体回滚，
      不能留下「订单清空了、价格还在」这种老板看不出来的半拉子状态 */
core.setOverride(DAY, 0, 1200, 55);
var fix4 = breakWrites();
log.length = 0;
core.clearAllData().fail(function () { log.push('clearAllData 失败了'); });
eq(core.BOOKINGS.length, 1, '清空失败：订单全回来了');
eq(core.priceFor(DAY, 0, 1200), 55, '清空失败：手改价也回来了');
ok(log.indexOf('clearAllData 失败了') >= 0, '清空失败会走到 .fail，页面才能如实报错');
fix4();

core.clearAllData();
eq(core.BOOKINGS.length, 0, '存储恢复后清空成功');

/* ⑥ 对一条已经不存在的订单点「确认」：core 返回 null 而不是 task，
      页面不能崩在 null.done 上，也不能报假的成功 */
log.length = 0;
odF.onConfirm(ev({ id: 'B不存在的单号' }));
ok(log.indexOf('toast: 已确认') < 0, '订单不存在时不报假的成功');
eq(odF.data.list.length, 0, '订单不存在时列表照常重画（没崩）');

/* ══════════════════════════════════════════════════ */
console.log('\n── 两段式：缓存先渲染，数据回来再刷新 ──────');
/* 上面的用例全都跑在同步的本地后端上，「取数前」和「取数后」是同一个瞬间，
   所以【分不出】页面有没有把该等数据的判断放进 done 里 —— 这也正是这类
   错误在本地测不出来、上云才炸的原因。

   这一节专门造一个【延迟返回】的后端（task 挂起，由测试手动 settle），
   把两段硬拆开看：
     ① 数据还没回来时，界面必须已经有内容（画的是本地缓存）
     ② 依赖最新占用情况的判断（pruneSel / dayHasFree）必须等到数据回来
        之后才发生 —— 写成 core.refresh() 的下一行就会在这里变红

   这是这一步唯一能在本地被证伪的东西，所以单独关起来测。 */

/* storeMod 在上面装 fixture 时就拿到了（loadModule 缓存 utils/ 下的模块，
   拿到的是同一个对象，所以直接改它的 fetchAll 就能影响 core）。 */
var realFetchAll = storeMod.fetchAll;

/** 把「服务器」按住不动：所有取数都挂起，直到 arrive() 手动放行 */
function holdServer() {
  var t = storeMod.makeTask();
  storeMod.fetchAll = function () { return t; };
  return {
    arrive: function (payload) {
      storeMod.fetchAll = realFetchAll;
      t.settle(null, payload);
    },
  };
}

/* 「服务器上」的样子：19:00 已经被别人订走。
   直接写一条订单字面量，不经过 core —— 这样它才是【缓存里没有】的，
   也就是客人离开这一页期间新发生的事。 */
var bookedByOther = {
  id: 'Bother', createdAt: 0, updatedAt: 0,
  dateKey: core.toDateKey(core.DATES[DAY]),
  items: [{ ci: 0, court: '1号场', from: 1140, to: 1200, price: 90 }],
  slotKeys: ['0|1140'],
  phone: '13500135000', name: '别人', note: '',
  total: 90, status: 'pending', reply: '',
};

core.clearAllData();                       // 缓存空了：19:00 在缓存里是空的
var bkS = loadPage('pages/booking/booking.js');
bkS.onLoad();
bkS.onTapDate(ev({ idx: DAY }));
bkS.sel.clear();
bkS.onTapCell(ev(T19));
eq(bkS.sel.size, 1, '客人选中了 19:00');
eq(bkS.data.gridRows[11].courts[0].cls, 'cell selected', '缓存里它是可约的、选中的');

var held = holdServer();
bkS.onShow();                              // 回到本页：先 repaint，再 refresh（被按住）

eq(bkS.data.gridRows.length, 14, '① 数据还没回来，界面已经有内容（画的是本地缓存）');
/* ② 盯的不是「有没有等数据」（那由 ③ 盯，它才是这一节的重点），
   而是【重回本页不许一刀切清空选择】—— 客人可能刚从填写页返回、正想接着改。
   实测过：把 holdServer 换成不按住，② 照样是绿的，所以它抓不到抢跑。 */
eq(bkS.sel.size, 1, '② 数据还没回来时选择原样留着（不许一刀切清空）');
eq(bkS.data.gridRows[11].courts[0].cls, 'cell selected', '② 缓存里它仍是选中的');

held.arrive({ bookings: [bookedByOther], prices: {} });   // 数据回来了

eq(bkS.sel.size, 0, '③ 数据回来后，把已被别人订走的 19:00 剔掉');
eq(bkS.data.gridRows[11].courts[0].cls, 'cell pending', '③ 格子变成「待」');
eq(bkS.data.gridRows[11].courts[0].text, '待', '③ 格子文案也更新了');
eq(bkS.data.hasSelection, false, '③ 底栏合计跟着清掉 —— repaint 里带了 updateFooter');

/* orders 页的同类问题：下拉转圈必须转到数据真回来 */
core.clearAllData();
var spins = 0;
var realStop = wx.stopPullDownRefresh;
wx.stopPullDownRefresh = function () { spins++; };

var held2 = holdServer();
var odS = loadPage('pages/orders/orders.js');
odS.onPullDownRefresh();
eq(spins, 0, '④ 数据没回来时转圈不停（立刻停的话老板会以为下拉没反应）');

held2.arrive({ bookings: [], prices: {} });
eq(spins, 1, '④ 数据回来后才停转圈');

wx.stopPullDownRefresh = realStop;
core.clearAllData();

/* ══════════════════════════════════════════════════ */
console.log('\n── 全新安装：存储是空的 ────────────────────');
/* 删掉自动灌数据之后，这一屏就是【真实的首次打开】。
   以前它被 seedDemoBookings 盖着，从来没被测过 —— 假订单挡在前面，
   就算空表格是坏的也看不出来。

   现在新装的客人第一眼看到的就是它，所以得确认它是能用的：
   全空、全可约、不报错。这是这次改动最直接的验收。 */
setClock(10, 0);                 // 拨到上午，免得「今天已过」混进来

var freshBk = loadPage('pages/booking/booking.js');
freshBk.onLoad();
freshBk.onTapDate(ev({ idx: DAY }));      // 看明天，和「今天过了多少」无关

eq(freshBk.data.gridRows.length, 14, '空存储下预约页照样有 14 行');
ok(freshBk.data.gridRows.every(function (r) {
  return r.courts.every(function (c) { return c.cls === 'cell'; });
}), '全新安装：所有格子都可约（不靠假订单撑场面）');
eq(freshBk.data.hasSelection, false, '全新安装：底栏没有选择');
eq(freshBk.data.footTotal, 0, '全新安装：合计是 0');

var freshOd = loadPage('pages/orders/orders.js');
freshOd.onShow();
eq(freshOd.data.list.length, 0, '全新安装：订单页一条都没有');
eq(freshOd.data.empty, true, '全新安装：订单页显示空状态而不是白屏');
eq(freshOd.data.tabs[0].count, 0, '全新安装：待确认页签是 0');

var freshPx = loadPage('pages/pricing/pricing.js');
freshPx.onLoad();
eq(freshPx.data.gridRows.length, 14, '全新安装：改价页照样有 14 行');
eq(freshPx.data.overrideCount, 0, '全新安装：没有一个格子是手改价');
eq(freshPx.data.gridRows[0].courts[0].text, String(core.rulePrice(core.DATES[DAY], 480)),
  '全新安装：价格全部来自规则价');

/* ══════════════════════════════════════════════════ */
console.log('\n── 输入框的静态约定 ────────────────────────');
/* 下面几条只有在真机上才看得出后果，桩件测不到，所以直接查源码文本。
   删掉它们不会让任何一条功能断言变红，只会让真机上的输入框重新变瞎。
   查之前先去掉注释 —— wxml 里那些「不要写成 value="{{x}}"」的说明本身
   就长着要找的形状。 */
function wxmlSource(rel) {
  return readFile(ROOT + rel).replace(/<!--[\s\S]*?-->/g, '');
}

/* 填写页【不许出现 <input>】。
   同一台 iOS 真机上，<input> 打进去的字根本不显示（输入中看不见，
   收起键盘也追不回来），同页的 <textarea> 全程正常。
   试过 always-embed，反而连「收键盘后显示」都没了，所以那个属性也别加。 */
(function () {
  var src = wxmlSource('pages/contact/contact.wxml');
  ok(!/<input\b/.test(src), '填写页没有 <input>（这台机器上它不显示输入内容）');
  ok(!/always-embed/.test(src), '填写页没有 always-embed（试过，更糟）');
  ok(!/value="\{\{/.test(src), '填写页没有任何 value 绑定（受控输入会吞字）');
  ok(/bindinput="onInputPhone"/.test(src), '手机号仍然靠 bindinput 取值');

  var tas = src.match(/<textarea\b[\s\S]*?>/g) || [];
  eq(tas.length, 3, '三个框都是 textarea');
  tas.forEach(function (t, i) {
    ok(/class="textarea"/.test(t),
      '第 ' + (i + 1) + ' 个 textarea 用的是同一个 class（三个框要一模一样）');
    ok(!/auto-height/.test(t),
      '第 ' + (i + 1) + ' 个 textarea 没用 auto-height（高度在 wxss 里写死）');
  });
  /* 手机号的合法性只在提交时判 —— 打字过程中页面不该有任何动静 */
  ok(/wx:if="\{\{phoneErr\}\}"/.test(src), '手机号的报错是提交后才出现的');
})();

/* ── 启动时不许自动灌演示数据 ──────────────────────
   原来 app.js 的 onLaunch 会调 core 里那个 seedDemo* 函数，往存储里塞
   13 条假订单，靠一个按【设备】的标记防重复。

   为什么必须是静态断言：smoke.js 从来不加载 app.js（它自己起了个 App 桩件），
   所以功能断言一条都够不着这行代码。接云之后那个标记不存在了，每个新客人
   第一次打开都会往大家共用的数据库里灌 13 条假订单 —— 而本地跑测试全绿。

   不剥注释、不留例外：app.js 里就不该出现这个形状（连注释里都别写，
   写了这条会红，然后你自然会去读 app.js 里那段说明）。 */
(function () {
  var src = readFile(ROOT + 'app.js');
  ok(!/seedDemoBookings\s*\(/.test(src), 'app.js 不再自动灌演示数据');
  ok(!/SEED_FLAG/.test(src), 'app.js 里没有「本机已灌过」的标记');
})();

/* ══════════════════════════════════════════════════ */
console.log('\n── 云端后端：调用名、参数、镜像回写 ────────');
/* 上面所有断言都跑在本地后端上，云端后端一行都没被执行过。
   ⚠️ 这里【验不到】云函数本身（wx-server-sdk 在本地跑不起来，jsc 里
      也没有云数据库）—— 云函数里的逻辑只能靠真机验。这一节能验的是
      【客户端这一侧】的接线：打对了函数名没有、参数传对没有、异步契约
      守没守住、镜像有没有回写。

   桩件返回一个【可控的 thenable】：.then/.catch 只把回调存起来，
   什么时候放行由测试说了算。这样「放行之前必须什么都没 settle」
   这条（云端后端之所以是云端后端）在本地是真能被断言的 —— 而不是拿
   同步假象糊过去。 */
var CB = storeMod._backends.cloudBackend;
var cloudCalls = [];
var realWxCloud = wx.cloud;

function installCloudStub() {
  cloudCalls = [];
  wx.cloud = {
    callFunction: function (o) {
      var rec = { name: o.name, data: o.data, done: null, err: null };
      cloudCalls.push(rec);
      return {
        then: function (fn) {
          rec.done = fn;
          return { catch: function (fn2) { rec.err = fn2; } };
        },
      };
    },
  };
}

/** 放行第 i 次云调用（形状照抄 wx.cloud.callFunction 的 resolve 值） */
function arriveCloud(i, result) {
  cloudCalls[i].done({ result: result, errMsg: 'cloud.callFunction:ok' });
}
/** 让第 i 次云调用失败（网络断了 / 云函数抛了） */
function failCloud(i, err) { cloudCalls[i].err(err); }

storeMod._useBackend(CB);
installCloudStub();

/* ① 打的是哪个云函数、参数对不对 */
var ct1 = CB.fetchAll({ dateKeys: ['2026-09-18', '2026-09-19'], passcode: '8888' });
eq(cloudCalls.length, 1, 'fetchAll 发起了一次云调用');
eq(cloudCalls[0].name, 'getSchedule',
  'fetchAll 打的是 getSchedule（不是 listBookings 之类）');
eq(cloudCalls[0].data.dateKeys.length, 2, '日期原样传给了云函数');
eq(cloudCalls[0].data.passcode, '8888', '口令原样传给了云函数');

/* ② 网络没回来之前，一个回调都不许触发 —— 这条就是「云端后端是异步的」 */
var ct1v = null, ct1e = null;
ct1.done(function (v) { ct1v = v; }).fail(function (e) { ct1e = e; });
eq(ct1v === null && ct1e === null, true,
  '网络还没回来，task 不许 settle（云端后端必须是异步的）');

/* ③ 放行：结果要映射成 { bookings, prices }，并且【写回本地镜像】 */
var cloudBookings = [{ dateKey: '2026-09-18', slotKeys: ['0|1140'], status: 'pending' }];
var cloudPrices = { '2026-09-18|0|1140': 88 };
arriveCloud(0, { ok: true, isAdmin: false, bookings: cloudBookings, prices: cloudPrices });
eq(ct1v !== null, true, '放行之后才 settle');
eq(ct1v && ct1v.bookings.length, 1, 'bookings 从 result 里取出来了');

var mirrored = storeMod.readCache();
eq(mirrored.bookings.length, 1, 'fetchAll 成功后把订单写回了本地镜像（冷启动第一屏靠它）');
eq(mirrored.prices['2026-09-18|0|1140'], 88, '价格也写回了镜像');
eq(mirrored.bookings[0].phone, undefined,
  '非管理员的订单里没有 phone —— 投影是云函数做的，客户端不会自己补字段');

/* ④ 云函数回 ok:false（参数不合法之类）：走 .fail，不是 .done */
installCloudStub();
var ct2 = CB.fetchAll({ dateKeys: [] });
var ct2v = null, ct2e = null;
ct2.done(function (v) { ct2v = v; }).fail(function (e) { ct2e = e; });
arriveCloud(1 - 1, { ok: false, reason: 'no-dates' });
eq(ct2v === null, true, 'ok:false 不许走 .done（那不是成功）');
ok(!!ct2e && /no-dates/.test(ct2e.message), 'ok:false 变成一次带原因的失败', ct2e && ct2e.message);

/* ④b detail（云函数给的可读原因）要跟着进错误消息。
   搭起来时最常撞的是「集合忘了建」，而那时候界面上是一片空 —— 跟
   「还没人下单」长得一模一样。detail 是唯一能把它俩分开的东西，
   它必须能一路走到 console.warn 看得见的地方。 */
installCloudStub();
var ct2b = CB.fetchAll({ dateKeys: ['2026-09-18'] });
var ct2bErr = null;
ct2b.fail(function (e) { ct2bErr = e; });
arriveCloud(0, { ok: false, reason: 'read-failed', detail: 'prices: collection not exists' });
ok(!!ct2bErr && /prices/.test(ct2bErr.message),
  '云函数的 detail 被带进了错误消息（不然只看到一句「取数失败」）', ct2bErr && ct2bErr.message);
eq(ct2bErr && ct2bErr.cloudReason, 'read-failed', 'reason 单独挂在 cloudReason 上，好判类型');
eq(ct2bErr && ct2bErr.cloudDetail, 'prices: collection not exists', 'detail 原样挂在 cloudDetail 上');

/* ⑤ 失败时【不清镜像】—— 宁可用旧数据，也别把界面清空 */
var stillThere = storeMod.readCache();
eq(stillThere.bookings.length, 1, '取数失败后本地镜像还在（没被清空）');

/* ⑥ 网络错误：也走 .fail */
installCloudStub();
var ct3 = CB.fetchAll({ dateKeys: ['2026-09-18'] });
var ct3e = null;
ct3.done(function () { ct3e = '不该走 done'; }).fail(function (e) { ct3e = e; });
failCloud(0, new Error('模拟断网'));
ok(ct3e instanceof Error && /断网/.test(ct3e.message), '网络错误走 .fail', ct3e && ct3e.message);

/* ⑦ 写方法打的是哪个云函数（名字最容易写错，各断言一次），
      以及参数【放在哪个字段上】—— 云函数是按字段名读的，
      放错了在本地一条都测不出来（本地后端根本收不到这些参数）。 */
installCloudStub();
CB.insert({ id: 'B1' }, { slotPrices: { '0|1140': 90 }, gap: 60 });
CB.update('B1', { status: 'confirmed' }, '8888');
CB.savePrices({ set: { '2026-09-18|0|1140': 99 }, del: [] }, '8888');
CB.clearAll('8888');
eq(cloudCalls.map(function (c) { return c.name; }).join(','),
  'createBooking,updateBooking,savePrices,clearAll',
  '四个写方法各自打对了云函数');

/* 订单对象【原样】进库，不掺运行时用的字段 —— 每格的价钱和时段粒度
   分成另外两个字段走，服务端靠它们重算总价。 */
eq(cloudCalls[0].data.booking.id, 'B1', 'insert 把订单包在 booking 字段里');
eq(cloudCalls[0].data.booking.slotPrices, undefined, 'insert 不往订单对象里塞运行时字段');
eq(cloudCalls[0].data.slotPrices['0|1140'], 90, 'insert 把每格价钱放在 slotPrices 上');
eq(cloudCalls[0].data.gap, 60, 'insert 把时段粒度放在 gap 上');

eq(cloudCalls[1].data.id, 'B1', 'update 把订单号放在 id 上');
eq(cloudCalls[1].data.patch.status, 'confirmed', 'update 把改动放在 patch 上');

/* ⚠️ 三个管理端方法必须带上口令。少传一个，云函数那边就是 forbidden，
   而这条在本地是【静默】的：本地后端收下 passcode 参数然后扔掉。 */
eq(cloudCalls[1].data.passcode, '8888', 'update 带上口令');
eq(cloudCalls[2].data.set['2026-09-18|0|1140'], 99, 'savePrices 发的是被改动的那几格，不是整张表');
eq(cloudCalls[2].data.passcode, '8888', 'savePrices 带上口令');
eq(cloudCalls[3].data.passcode, '8888', 'clearAll 带上口令');

/* ⑦b ⚠️ 写方法收到 ok:false，必须变成【失败】。
   —— 这是真出过的 bug：云函数回 forbidden，客户端照样当成功，
      页面弹「已改 3 个时段」，数据库里一个字都没有。老板唯一的线索
      是自己去翻数据库，而那时已经过去了半天。
   fetchAll 一直是对的（它调了 unwrapCloud），漏的是三个写方法：
   它们的调用方都是「成功就弹一句已办妥、失败才回滚」，所以
   把 ok:false 放过去 = 报假成功。 */
installCloudStub();
var w1 = CB.savePrices({ set: { '2026-09-18|0|1140': 99 }, del: [] }, '');
var w1v = null, w1e = null;
w1.done(function (v) { w1v = v; }).fail(function (e) { w1e = e; });
arriveCloud(0, { ok: false, reason: 'forbidden' });
eq(w1v === null, true, 'savePrices 收到 ok:false 不许走 done');
eq(w1e && w1e.cloudReason, 'forbidden', 'savePrices 把 ok:false 交成一次带原因的失败');

installCloudStub();
var w2 = CB.update('B1', { status: 'confirmed' }, '');
var w2v = null, w2e = null;
w2.done(function (v) { w2v = v; }).fail(function (e) { w2e = e; });
arriveCloud(0, { ok: false, reason: 'forbidden' });
eq(w2v === null, true, 'update 收到 ok:false 不许走 done');
eq(w2e && w2e.cloudReason, 'forbidden', 'update 把 ok:false 交成一次带原因的失败');

installCloudStub();
var w3 = CB.clearAll('');
var w3v = null, w3e = null;
w3.done(function (v) { w3v = v; }).fail(function (e) { w3e = e; });
arriveCloud(0, { ok: false, reason: 'forbidden' });
eq(w3v === null, true, 'clearAll 收到 ok:false 不许走 done');
eq(w3e && w3e.cloudReason, 'forbidden', 'clearAll 把 ok:false 交成一次带原因的失败');

/* 成功那条路没被这次修复挡掉 —— ok:true 的结果要原样交付，
   否则 savePrices 的 partial 明细（failed 数组）就传不下去了。 */
installCloudStub();
var w4 = CB.savePrices({ set: { '2026-09-18|0|1140': 99 }, del: [] }, '8888');
var w4v = null;
w4.done(function (v) { w4v = v; });
arriveCloud(0, { ok: true, written: 1, removed: 0 });
eq(!!(w4v && w4v.ok), true, 'ok:true 照样走 done');

/* ⑦c 从【调用方】再验一遍：老板改价失败时，必须回滚 + 报错。
   上面几条只证明 store 交了失败；这一条证明 core 真的把它当失败处理 ——
   commitPrices 的 .done 原来是 `() => out.settle(null, true)`，
   【它压根不看返回值】，那正是这个 bug 藏身的地方。 */
installCloudStub();
var H0 = core.HOURS[0];
var priceKey = '0|' + H0;
var priceBefore = core.priceFor(0, 0, H0);
var ovTask = core.setOverrides(0, [priceKey], 777);
var ovv = null, ove = null;
ovTask.done(function (v) { ovv = v; }).fail(function (e) { ove = e; });
arriveCloud(0, { ok: false, reason: 'forbidden' });
eq(ovv === null, true, '改价失败不许走 done（否则老板看到「已改 N 个时段」）');
eq(ove && ove.cloudReason, 'forbidden', '改价失败把原因交出来了');
eq(core.priceFor(0, 0, H0), priceBefore,
  '改价失败后内存回滚成原价（界面不能显示一个没存进去的价）');

/* ⑧ 切回本地后端，后面几条静态断言不依赖运行时状态 */
storeMod._useBackend(storeMod._backends.localBackend);
wx.cloud = realWxCloud;

/* ── errText：失败怎么翻成人话 ────────────────────
   orders.js / contact.js / pricing.js 的注释都写着「怎么翻由 errText
   一处决定」，而失败提示是老板和客人唯一能看到的诊断信息。翻错了的
   后果不是难看，是【让人做错事】：把「口令失效」说成「请重试」，
   他会一直点；把「被抢了」说成「检查网络」，他会一直查网线。 */
(function () {
  function reason(r) { var e = new Error('x'); e.cloudReason = r; return e; }

  eq(core.errText(reason('forbidden')),
    '管理口令已失效，请退出管理页重新进入', '口令失效 → 别让人白试');
  eq(core.errText(reason('slot-taken')),
    '时段已被其他客人订走，无法恢复', '被抢了 → 说清楚是被抢了');
  eq(core.errText(reason('busy')),
    '同时提交的人较多，请再试一次', '重试耗尽 → 这条才是真该重试的');
  eq(core.errText(reason('all-taken')),
    '抱歉，你选的时段已不可预约', '全被占 → 客人能看懂');

  /* 「状态未知」= 占用表不见了，不是网络问题。这句话要是被翻成
     「请检查网络后重试」，客人会一直重试一件永远不成的事。 */
  eq(core.errText(reason('state-unknown')),
    '系统数据异常，请稍后再试或联系管理员', '状态未知 → 不许说成「检查网络」');

  /* 改价这条路上真会回的几个。partial = 有几格没写进去（不是全废），
     让老板「再试一次」是对的；bad-price 是客户端算错了价钱，
     叫他重试是句假话。 */
  eq(core.errText(reason('partial')),
    '部分时段没存上，请再试一次', '部分失败 → 那几格可以再试一次');
  eq(core.errText(reason('not-found')),
    '这一单已经不在了，请下拉刷新', '订单没了 → 别让人对着空气重试');
  ok(!/网络/.test(core.errText(reason('bad-price'))),
    '数据格式不对【不许】说成「检查网络」', core.errText(reason('bad-price')));
  ok(!/网络/.test(core.errText(reason('too-many-cells'))),
    '越线【不许】说成「检查网络」', core.errText(reason('too-many-cells')));

  /* 认不出的原因（网络断了、云函数抛了）走 fallback——
     fallback 是调用方给的，因为它才知道自己在干什么。 */
  eq(core.errText(new Error('断网')), '操作失败，请检查网络后重试',
    '认不出的错给默认那句');
  eq(core.errText(new Error('断网'), '提交失败，请检查网络后重试'),
    '提交失败，请检查网络后重试',
    '调用方给了话就用调用方的（客人看到「提交失败」比「操作失败」清楚）');
  /* ⚠️ 反过来也要成立：认得出的原因【压过】 fallback。
     不然 contact.js 传一句「提交失败」，就会把「被抢了」盖成「网络问题」，
     客人对着一个永远不成的事一直重试。 */
  eq(core.errText(reason('slot-taken'), '提交失败，请检查网络后重试'),
    '时段已被其他客人订走，无法恢复', '认得出的原因压过调用方的 fallback');
  eq(core.errText(null), '操作失败，请检查网络后重试', '连 err 都没有也不崩');
})();

/* ── 外部数据进内存：形状在门口兜住 ────────────────
   云函数回来的东西是【外部数据】—— 控制台里手改过一条、或者哪天云函数
   改了形状，都可能塞进来一条缺胳膊少腿的记录。这一节盯的是：
   一条坏记录不能让整张列表崩掉，而它崩起来的样子是【一屏空】，
   没有任何线索能指向那一行。
   （这不是假想：手工往控制台插调试记录时，就插出过只有 _id 的空记录。） */
(function () {
  var warns = [];
  var realWarn = console.warn;
  console.warn = function (m) { warns.push(String(m)); };

  /* 格子 key 必须【现算】—— 测试里的基准日是 2026-09-14（周一），
     写死日期的话断的就是另一格，而那种错会表现为「这条断言莫名其妙
     一直是红的」。 */
  function pk(dayIdx, ci, min) {
    return core.toDateKey(core.DATES[dayIdx]) + '|' + ci + '|' + min;
  }
  var badPrices = {};
  badPrices[pk(1, 0, 1140)] = 88;
  badPrices[pk(1, 0, 1200)] = '90';
  badPrices[pk(1, 0, 1260)] = 'abc';
  badPrices[pk(1, 0, 1320)] = -5;

  storeMod._useBackend(CB);
  installCloudStub();
  core.refresh(function () {});
  arriveCloud(0, {
    ok: true, isAdmin: true,
    bookings: [
      { id: 'Bgood1111', dateKey: '2026-09-19', items: [], slotKeys: [], status: 'pending' },
      { dateKey: '2026-09-19', items: [], slotKeys: [], status: 'pending' },     // 没有 id
      { id: 'Bnodate11', items: [], slotKeys: [], status: 'pending' },           // 没有 dateKey
      { id: 'Bnumdate1', dateKey: 20260919, items: [], slotKeys: [], status: 'pending' },
      null,
    ],
    prices: (function () {
      var p = {};
      p[pk(1, 0, 1140)] = 88;
      p[pk(1, 0, 1200)] = '90';         // 字符串
      p[pk(1, 0, 1260)] = 'abc';
      p[pk(1, 0, 1320)] = -5;
      return p;
    })(),
  });

  /* ① 缺 id / 缺 dateKey 的记录用不了：取消/确认/恢复都按 id 找它，
        按天查询按 dateKey 找它，排序也要拿它比 —— 留着只会在别处炸。
        丢掉，而且必须【说出来】，不能静默丢数据。 */
  eq(core.BOOKINGS.length, 1, '4 条坏记录全被丢掉，好的那条留着');
  eq(core.BOOKINGS[0].id, 'Bgood1111', '留下的是那条完整的');
  eq(warns.length, 1, '丢掉的时候说了出来（静默丢数据是这里最不该做的事）');

  /* ② 缺 items / slotKeys 的补成空数组 —— 页面是【索引】进去取的
        （toCard 里的 b.items[0]），不补的话老板页整页崩 */
  warns.length = 0;
  storeMod._useBackend(CB);
  installCloudStub();
  core.refresh(function () {});
  arriveCloud(0, {
    ok: true, isAdmin: true, prices: {},
    bookings: [{ id: 'Bbare1111', dateKey: '2026-09-19', status: 'pending' }],
  });
  eq(Array.isArray(core.BOOKINGS[0].items), true, 'items 补成数组');
  eq(Array.isArray(core.BOOKINGS[0].slotKeys), true, 'slotKeys 补成数组');
  eq(warns.length, 0, '补字段不算丢数据，不该报警');

  /* 老板页真的画得出来 —— 上面两条断言存在的理由就是这个：不崩 */
  var odExt = loadPage('pages/orders/orders.js');
  odExt.onShow();
  eq(odExt.data.list.length, 1, '这种记录不会让老板页崩掉（卡片照常画出来）');
  eq(odExt.data.list[0].timeText, '', '时段那栏是空的，而不是编一个出来');
  odExt.onTapCard(ev({ id: 'Bbare1111' }));
  ok(true, '点开它的详情也不崩（items 为空时那一行是空字符串）');

  /* ③ 价格：只收【有限的数字】。spanPrice 是用 += 加总价的，
        混进来一个字符串就变成字符串拼接 —— 客人看到天价，而每一格
        显示得都好好的，页面上没有任何东西看起来是错的。 */
  storeMod._useBackend(CB);
  installCloudStub();
  core.refresh(function () {});
  arriveCloud(0, { ok: true, isAdmin: true, bookings: [], prices: badPrices });
  eq(core.priceFor(1, 0, 1140), 88, '正常的数字收下');
  eq(core.priceFor(1, 0, 1200) === '90', false, '字符串价格【没有】进内存');
  eq(typeof core.priceFor(1, 0, 1200), 'number', '它退回规则价那个数字');
  eq(core.priceFor(1, 0, 1320) < 0, false, '负数价格也没进内存');
  eq(core.priceFor(1, 0, 1260) === 'abc', false, '连"abc"也没进来');

  console.warn = realWarn;
  storeMod._useBackend(storeMod._backends.localBackend);
  wx.cloud = realWxCloud;
})();

/* ── 后端开关：只能靠读源码盯着 ────────────────────
   store.js 里那一行要是被谁改回 localBackend，整个项目会【静默退回单机版】：
   功能看着一切正常，只是客人的订单老板永远收不到。上面那些行为断言
   一条都发现不了 —— 它们测的是两个后端各自好不好使，不是出货用的是哪个。 */
(function () {
  var src = readFile(ROOT + 'utils/store.js');
  var m = src.match(/^[ \t]*(?:let|const)[ \t]+backend[ \t]*=[ \t]*([A-Za-z_$][\w$]*)/m);
  ok(!!m, 'store.js 里有后端开关那一行');
  eq(m && m[1], 'cloudBackend',
    '后端开关指向 cloudBackend（改回 localBackend = 静默退回单机版）');
})();

/* ── 管理身份只能由云函数自己算出来 ────────────────
   客户端传的只有口令本身。要是哪天有人图省事加一句 event.admin，
   那就等于让调用方自己宣布「我是管理员」—— 任何人反编译后都能这么宣布。
   这条断言盯着云函数源码，客户端那一侧则在 core.js 里盯着（见下）。 */
(function () {
  var src = readFile(ROOT + '../cloudfunctions/getSchedule/index.js');
  ok(!/event\.admin/.test(src), '云函数不读 event.admin（身份不能由调用方自报）');
  ok(/ADMIN_WHITELIST/.test(src), '云函数里有白名单那个数组（补权限只需填它）');
  ok(/passcode\s*===\s*ADMIN_PASSCODE/.test(src),
    '口令是在云函数里比对的，不是客户端比完告诉它');
})();

/* ── 三份「逐字相同」的管理块 ──────────────────────
   updateBooking / savePrices / clearAll 各有一份一模一样的鉴权代码
   （云函数之间没法共享代码，只能复制，三处注释里都写了这句）。
   复制的东西最怕的是【改一处漏两处】—— 而漏掉的那种漏法完全静默：
   改口令时只改了一个，另外两个还是旧口令，管理端就开始随机报
   「口令已失效」，看起来像网络问题。

   所以这三份必须逐字相等。它们各自在文件里长得一模一样，只差
   上下文，所以直接切片比对。 */
(function () {
  function adminBlock(path) {
    var src = readFile(ROOT + '../cloudfunctions/' + path);
    var i = src.indexOf('const ADMIN_PASSCODE');
    if (i < 0) return null;
    var j = src.indexOf('\n}\n', src.indexOf('function isAdmin', i));
    return j < 0 ? null : src.slice(i, j + 3);
  }

  var files = ['updateBooking/index.js', 'savePrices/index.js', 'clearAll/index.js'];
  var blocks = files.map(adminBlock);
  ok(blocks.every(function (b) { return !!b; }), '三个云函数里都找得到那块鉴权代码',
    blocks.map(function (b) { return b ? b.length : null; }));

  eq(blocks[1] === blocks[0], true, 'savePrices 那份和 updateBooking 逐字相同');
  eq(blocks[2] === blocks[0], true, 'clearAll 那份和 updateBooking 逐字相同');

  /* 白名单那一行必须是【恰好】这个样子：getSchedule 的本地台架
     （dev/get-schedule）就是靠替换这个字符串来测「白名单非空时口令失效」
     的，格式一变它就会抛「白名单那行没被替换掉 —— 源码形状变了」。 */
  ok(/\nconst ADMIN_WHITELIST = \[\];\n/.test(blocks[0] || ''),
    'ADMIN_WHITELIST 那行是空的、且格式没变（补权限只需填它）');
  ok(/ADMIN_WHITELIST\.length[\s\S]*indexOf\(openid\)/.test(blocks[0] || ''),
    '白名单优先：填了名单之后口令那条路就【完全】不走了');
})();

/* ── 云函数会回的每个 reason，errText 都得有话可说 ──────
   ⚠️ 这条是为了堵住一整类 bug，不是补一句话：认不出的 reason 会掉到
      errText 最后那句「请检查网络后重试」，而云函数的拒绝里【几乎没有
      一条跟网络有关】—— 让老板去查网络、让客人对着一个永远不成的事
      一直重试。翻错了的后果不是难看，是让人做错事。

   做法：把每个 cloudfunctions/<名字>/index.js 里的 reason 字符串全捞出来，
   逐个喂给 errText，带一个【独特的】fallback。谁掉回那个 fallback，
   就说明 errText 没有它的话。云函数那边新加 reason 而这里没跟上，
   这条会当场红 —— 而不是等到某个老板在真机上收到一句假话。 */
(function () {
  var files = ['getSchedule', 'createBooking', 'updateBooking', 'savePrices', 'clearAll'];
  var reasons = [];
  files.forEach(function (name) {
    var src = readFile(ROOT + '../cloudfunctions/' + name + '/index.js');
    var re = /reason: '([a-z-]+)'/g, m;
    while ((m = re.exec(src))) {
      if (reasons.indexOf(m[1]) < 0) reasons.push(m[1]);
    }
  });

  ok(reasons.length >= 15, '从云函数里捞到了 reason 表', reasons.length);

  var SENTINEL = '（掉到了 fallback）';
  var fell = reasons.filter(function (r) {
    var e = new Error('x');
    e.cloudReason = r;
    return core.errText(e, SENTINEL) === SENTINEL;
  });
  eq(fell.join(','), '', '云函数会回的每个 reason，errText 都有对应的一句话');

  /* 顺带钉住那条最容易搞错的分界：没带 cloudReason 的错 = 传输层失败
     （callFunction 自己 reject 了），那才是「检查网络」；
     带了 cloudReason 'error' = 云函数抛了异常，不该让人去查网络。 */
  var netErr = new Error('request:fail');
  eq(core.errText(netErr, '提交失败，请检查网络后重试'),
    '提交失败，请检查网络后重试', '断网（没有 cloudReason）才说「检查网络」');
  var threw = new Error('x');
  threw.cloudReason = 'error';
  ok(!/网络/.test(core.errText(threw, '提交失败，请检查网络后重试')),
    '云函数抛异常时【不许】说成「检查网络」', core.errText(threw));
})();

/* ── 口令只在真解锁之后才发出去 ────────────────────
   要是无脑带上 CONFIG.adminPasscode，那么每个客人的手机都会拿着口令去问，
   云函数那边「非管理员只拿投影」就永远不生效 —— 等于把所有人的手机号
   发给所有人。这个错误在界面上完全看不出来（管理员自己用着一切正常）。 */
(function () {
  var src = readFile(ROOT + 'utils/core.js');
  ok(/adminUnlocked/.test(src),
    'core 取口令时会看 adminUnlocked（没解锁就不带口令）');
  var i = src.indexOf('function adminPasscode');
  ok(i >= 0, 'core.js 里有 adminPasscode()');
  var body = i < 0 ? '' : src.slice(i, i + 400);
  ok(/adminUnlocked/.test(body), 'adminPasscode() 确实是在看那个标记');
})();

/* ══════════════════════════════════════════════════ */
console.log('\n══════════════════════════════════════════════');
console.log('  通过 ' + pass + ' / 失败 ' + fail);
console.log('══════════════════════════════════════════════');
if (fail) throw new Error(fail + ' 个断言失败');
