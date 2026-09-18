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

core.seedDemoBookings();
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

// 恢复时撞车应被拦下：先释放 19:00，让第二单占住，再试着恢复第一单
core.cancelBooking(bid);
var b2 = sync(core.createBooking({
  dayIdx: DAY, groups: [{ ci: 0, court: '1号场', from: 1140, to: 1200 }],
  phone: '13900139000', name: '后来的人', note: '',
}));
eq(b2.ok, true, '第二单创建成功');
od.onShow();
od.onRestore(ev({ id: bid }));
eq(core.findBooking(bid).status, 'cancelled', '时段被占时恢复被拦下');

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

var storeMod = loadModule('utils/store.js').exports;
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

/* ══════════════════════════════════════════════════ */
console.log('\n══════════════════════════════════════════════');
console.log('  通过 ' + pass + ' / 失败 ' + fail);
console.log('══════════════════════════════════════════════');
if (fail) throw new Error(fail + ' 个断言失败');
