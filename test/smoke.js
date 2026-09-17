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
var console = { log: function () { print(Array.prototype.slice.call(arguments).join(' ')); } };

/* ── 可控时钟 ────────────────────────────────────────
   core.js 用 new Date() 判断「是否已过」。要测「晚上才打开」
   「跨天」这类场景，就得能把表拨到指定时刻。
   ──────────────────────────────────────────────────── */
var RealDate = Date;
var clockOffset = 0;
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

/** 把表拨到「今天 h:m」 */
function setClock(h, m) {
  var t = new RealDate();
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
var wx = {
  getStorageSync: function (k) { return store[k]; },
  setStorageSync: function (k, v) { store[k] = v; },
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

var coreMod = null;
function req(p) {
  if (/core\.js$/.test(p)) return coreMod.exports;
  throw new Error('未预期的 require: ' + p);
}

function loadModule(rel) {
  var mod = { exports: {} };
  var fn = new Function('module', 'exports', 'require', 'wx', 'Page', 'App', 'getApp', readFile(ROOT + rel));
  fn(mod, mod.exports, req, wx, Page, App, getApp);
  return mod;
}

function loadPage(rel) {
  pageDefs = [];
  var mod = { exports: {} };
  var fn = new Function('module', 'exports', 'require', 'wx', 'Page', 'App', 'getApp', readFile(ROOT + rel));
  fn(mod, mod.exports, req, wx, Page, App, getApp);
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

/* ══════════════════════════════════════════════════ */
console.log('\n── 载入 core ────────────────────────────────');
coreMod = loadModule('utils/core.js');
var core = coreMod.exports;
var CONFIG = core.CONFIG;

eq(CONFIG.courts.length, 4, '4 片场地');
eq(CONFIG.slotMin, 30, '计价粒度 30 分钟（价格可以每半小时不同）');
eq(CONFIG.bookMin, 60, '预定粒度 60 分钟（客人最少订一小时）');
eq(core.SLOTS.length, 28, '每天 28 个计价档 (8:00–22:00)');
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
console.log('\n── 客人页 booking ───────────────────────────');
var DAY = 1;
var bk = loadPage('pages/booking/booking.js');
bk.onLoad();
eq(bk.data.gridRows.length, 14, '网格 14 行');
eq(bk.data.gridRows[0].courts.length, 4, '每行 4 片场地');
eq(bk.data.gridRows[0].label, '08:00', '行首是整点');
eq(bk.data.hasSelection, false, '初始无选中');

bk.onTapDate(ev({ idx: DAY }));
eq(bk.data.currentDay, DAY, '切到明天');

eq(core.spanStatus(DAY, 0, 1140, 1200), 'free', '19:00–20:00 空闲');
eq(bk.data.gridRows[11].courts[0].text, '90', '19:00–20:00 显示 ¥90（45+45）');

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

/* 半小时粒度还在：管理员把 18:30 单独改成 ¥99，
   18:00–19:00 这一段就应该是 45 + 99 = ¥144 */
core.setOverride(DAY, 1, 1110, 99);
bk.sel.clear();
bk.buildGrid();                                       // 价格改了，格子得重画
bk.onTapCell(ev({ ri: 10, ci: 1, key: '1|1080' }));   // 18:00–19:00
eq(bk.data.gridRows[10].courts[1].text, '144', '段价是两个半小时价的和，不是单价×2');
eq(bk.data.footTotal, 144, '合计 ¥144（45 + 99）');
core.clearOverride(DAY, 1, 1110);

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
eq(core.BOOKINGS[0].slotKeys.length, 2, '占 2 个计价档（一小时的上下半）');
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
var b2 = core.createBooking({
  dayIdx: DAY, groups: [{ ci: 0, court: '1号场', from: 1140, to: 1200 }],
  phone: '13900139000', name: '后来的人', note: '',
});
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
eq(pr.data.gridRows[0].courts[0].halves.length, 2, '改价页保留半小时格（管理员按半小时改价）');
eq(pr.data.hasSel, false, '初始无选中');
eq(pr.data.overrideCount, 0, '初始无手改');

// 明天 1 号场 20:00 规则价 = 45
eq(core.priceFor(DAY, 0, 1200), 45, '改价前 20:00 规则价 ¥45');

// 点整列：场地表头
pr.onTapCourtHead(ev({ ci: 0 }));
eq(pr.sel.size, 28, '点场地名选中整列 28 档');
eq(pr.data.selCount, 28, '工具条显示已选 28');
eq(pr.data.gridRows[0].courts[0].halves[0].cls, 'half selected', '整列变选中');

pr.onClearSel();
eq(pr.sel.size, 0, '清空选择');

// 点整行：时间列（20:00 → 2 格 × 4 场地 = 8）
pr.onTapRowLabel(ev({ min: 1200 }));
eq(pr.sel.size, 8, '点时间选中整行 8 档');
pr.onClearSel();

// 点整行再点一次 = 全取消
pr.onTapRowLabel(ev({ min: 1200 }));
pr.onTapRowLabel(ev({ min: 1200 }));
eq(pr.sel.size, 0, '整行再点一次全取消');

// 单格选中 + 应用价格
pr.onTapHalf(ev({ key: '0|1200' }));
eq(pr.sel.size, 1, '选中 1 格');

pr.onApply();
eq(core.hasOverride(DAY, 0, 1200), false, '没填价格时不生效');

pr.onInputPrice({ detail: { value: 'ab88元' } });
eq(pr.data.priceInput, '88', '价格输入过滤非数字');

pr.onApply();
eq(core.hasOverride(DAY, 0, 1200), true, '价格已覆盖');
eq(core.priceFor(DAY, 0, 1200), 88, '价格变成 ¥88');
eq(pr.sel.size, 0, '应用后自动清空选择');
eq(pr.data.gridRows[12].courts[0].halves[0].cls, 'half override', '格子标记为已手改');
eq(pr.data.gridRows[12].courts[0].halves[0].text, '88', '格子显示新价');
eq(pr.data.overrideCount, 1, '本日已手改 1 格');
eq(pr.data.priceInput, '', '应用后清空输入框');

// 快捷价签
pr.onTapQuick({ currentTarget: { dataset: { v: 50 } } });
eq(pr.data.priceInput, '50', '快捷价签填入 50');

// 恢复规则价
pr.onTapHalf(ev({ key: '0|1200' }));
pr.onResetRule();
eq(core.hasOverride(DAY, 0, 1200), false, '已恢复规则价');
eq(core.priceFor(DAY, 0, 1200), 45, '价格回到 ¥45');
eq(pr.data.gridRows[12].courts[0].halves[0].text, '45', '格子显示回规则价');

/* ══════════════════════════════════════════════════ */
console.log('\n── 端到端：老板改价 → 客人看到 ───────────────');
pr.onTapHalf(ev({ key: '2|1080' }));      // 明天 3 号场 18:00
pr.onInputPrice({ detail: { value: '99' } });
pr.onApply();
eq(core.priceFor(DAY, 2, 1080), 99, '老板把 3 号场 18:00 改成 ¥99');
eq(core.priceFor(DAY, 2, 1110), 45, '18:30 还是规则价 ¥45');

var bk2 = loadPage('pages/booking/booking.js');
bk2.onLoad();
bk2.onTapDate(ev({ idx: DAY }));
eq(bk2.data.gridRows[10].courts[2].text, '144', '客人页显示 18:00–19:00 合计 ¥144（99+45）');
bk2.onTapCell(ev({ ri: 10, ci: 2, key: '2|1080' }));
eq(bk2.data.footTotal, 144, '客人下单计价 ¥144');

bk2.onSubmit();
var ct5 = loadPage('pages/contact/contact.js');
ct5.onLoad();
ct5.onInputPhone({ detail: { value: '13712345678' } });
ct5.onConfirm();
var last = core.BOOKINGS[core.BOOKINGS.length - 1];
eq(last.total, 144, '订单快照价 ¥144');

// 老板事后改价，不应影响已提交订单
core.setOverride(DAY, 2, 1080, 200);
eq(core.priceFor(DAY, 2, 1080), 200, '老板改成 ¥200');
eq(core.priceFor(DAY, 2, 1110), 45, '18:30 仍是 ¥45');
eq(last.total, 144, '已提交订单仍是 ¥144（价格快照）');

/* ══════════════════════════════════════════════════ */
console.log('\n── 边界 ─────────────────────────────────────');
core.clearAllData();
var r = core.createBooking({
  dayIdx: 1, groups: [{ ci: 0, court: '1号场', from: 480, to: 540 }],
  phone: '13000000000', name: '', note: '',
});
eq(r.ok, true, '正常下单');
eq(r.skipped.length, 0, '无冲突');

var r2 = core.createBooking({
  dayIdx: 1,
  groups: [{ ci: 0, court: '1号场', from: 510, to: 570 }],   // 510 已占，540 空闲
  phone: '13000000001', name: '', note: '',
});
eq(r2.ok, true, '部分冲突仍可下单');
eq(r2.skipped.length, 1, '剔除 1 个已占档');
eq(r2.booking.slotKeys.length, 1, '只占 1 档');

var r3 = core.createBooking({
  dayIdx: 1, groups: [{ ci: 0, court: '1号场', from: 480, to: 540 }],
  phone: '13000000002', name: '', note: '',
});
eq(r3.ok, false, '全冲突时下单失败');
eq(r3.skipped.length, 2, '全部被剔除');

core.cancelBooking(r.booking.id);
eq(core.slotStatus(1, 0, 480), 'free', '取消后时段重新开放');

// 跨场地分组
var g = core.groupSlots([
  { ci: 0, min: 600 }, { ci: 1, min: 600 }, { ci: 0, min: 630 },
]);
eq(g.length, 2, '跨场地拆成 2 段');
eq(g[0].court, '1号场', '第一段 1 号场');
eq(g[0].from, 600, '第一段 10:00 起');
eq(g[0].to, 660, '第一段到 11:00');
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

var px = core.createBooking({
  dayIdx: 0, groups: [{ ci: 1, court: '2号场', from: 1200, to: 1260 }],
  phone: '13111111112', name: '', note: '',
});
eq(px.ok, true, '已经开始的段能落单（客人牺牲一点时间）');
eq(px.booking.slotKeys.length, 2, '整段两个计价档都占上');

// 整段已经结束的，落单这层也要自己扛住，不能只靠界面拦
var py = core.createBooking({
  dayIdx: 0, groups: [{ ci: 2, court: '3号场', from: 1140, to: 1200 }],
  phone: '13111111111', name: '', note: '',
});
eq(py.ok, false, '已结束的段直接在落单层被拒');
eq(py.skipped.length, 2, '两个计价档都被剔除');

// 深夜打开：今天全过完了，应该自动跳到明天
setClock(22, 30);
core.refreshDates();
var lb = loadPage('pages/booking/booking.js');
lb.onLoad();
lb.onShow();
eq(lb.data.currentDay, 1, '今天已过完，自动跳到明天');
eq(lb.data.dayHint, '', '明天没有过期问题，不弹提示');
eq(lb.data.gridRows[0].courts[0].text, '60', '明天 8:00–9:00 正常显示 ¥60（30+30）');

// 提示文案的分支
eq(lb.buildHint(1, 0), '这天已无可约时段，换个日期看看', '未来某天全满的提示');
eq(lb.buildHint(1, 5), '', '未来某天有空时不弹提示');
eq(lb.buildHint(0, 0), '今天已无可约时段，点上面的日期换一天', '今天全满的提示');

setClock(12, 0);   // 拨回白天，别影响后面的输出

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
