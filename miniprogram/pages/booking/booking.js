const core = require('../../utils/core.js');
const CONFIG = core.CONFIG;

Page({
  data: {
    dates: [],
    currentDay: 0,
    gridRows: [],
    courtNames: CONFIG.courts,
    dayHint: '',

    // 底部结算栏
    footLines: [],
    footCount: 0,
    footTotal: 0,
    hasSelection: false,
  },

  // 选中的格子 key（"ci|min"）。不放进 data —— 渲染靠 class 表达，
  // 放进 data 会让每次点击都触发一次无谓的全量 diff。
  sel: null,

  onLoad() {
    this.sel = new Set();
    this.renderDates();
    this.buildGrid();
  },

  onShow() {
    // 回到本页时重新算日期（可能跨天了），并刷新网格
    // （管理端可能刚改过价格或确认过预约）
    core.refreshDates();

    // 今天可能已经过完了（比如晚上才打开），或者跨天了。
    // 这时别让客人对着一屏灰格子发愣，直接挪到最近一个还能约的日期。
    if (!this.dayHasFree(this.data.currentDay)) {
      this.sel.clear();                 // 换了日期，选中的格子作废
      this.setData({ currentDay: this.firstFreeDay() });
    }

    /* 不清空选择 —— 客人可能刚从填写页返回，正想接着改。
       但中间可能有人把时段订走了，所以把不再可约的挑掉，
       而不是一刀切清空。 */
    this.pruneSel();

    this.renderDates();
    this.buildGrid();
  },

  /* ── 可用性探测 ─────────────────────────────────── */

  /** 这一天还有没有任何一个可订的段 */
  dayHasFree(day) {
    for (let ci = 0; ci < CONFIG.courts.length; ci++) {
      for (let i = 0; i < core.BOOKS.length; i++) {
        const from = core.BOOKS[i];
        if (core.spanStatus(day, ci, from, from + CONFIG.bookMin) === 'free') return true;
      }
    }
    return false;
  },

  /** 最近一个有空的日期。七天全满就退回今天。 */
  firstFreeDay() {
    for (let d = 0; d < core.DATES.length; d++) {
      if (this.dayHasFree(d)) return d;
    }
    return this.data.currentDay;
  },

  /* ── 日期条 ─────────────────────────────────────── */
  renderDates() {
    const dates = core.DATES.map((d, i) => ({
      idx: i,
      dow: core.dateLabel(d, i),
      num: `${d.getMonth() + 1}/${d.getDate()}`,
      active: i === this.data.currentDay,
    }));
    this.setData({ dates });
  },

  onTapDate(e) {
    const idx = +e.currentTarget.dataset.idx;
    if (idx === this.data.currentDay) return;
    this.sel.clear();          // 一次预约只针对一天
    this.setData({ currentDay: idx }, () => {
      this.renderDates();
      this.buildGrid();
      this.updateFooter();
    });
  },

  /* ── 网格 ───────────────────────────────────────── */
  buildGrid() {
    const day = this.data.currentDay;
    const n = CONFIG.courts.length;
    const span = CONFIG.bookMin;
    let freeCount = 0;

    const gridRows = core.BOOKS.map(from => {
      const to = from + span;
      const courts = [];
      for (let ci = 0; ci < n; ci++) {
        const key = `${ci}|${from}`;
        const st = core.spanStatus(day, ci, from, to);
        if (st === 'free') freeCount++;
        courts.push({
          ci,
          key,
          text: this.cellText(st, day, ci, from, to),
          cls: this.cellClass(st, this.sel.has(key)),
        });
      }
      return { label: core.fmt(from), from, courts };
    });

    this.setData({ gridRows, dayHint: this.buildHint(day, freeCount) });
  },

  /** 灰格子为什么灰 —— 给一句话解释，不然客人以为界面坏了 */
  buildHint(day, freeCount) {
    if (day !== 0) {
      return freeCount ? '' : '这天已无可约时段，换个日期看看';
    }
    if (!freeCount) return '今天已无可约时段，点上面的日期换一天';

    for (let i = 0; i < core.BOOKS.length; i++) {
      const from = core.BOOKS[i];
      if (!core.isPastSpan(0, from, from + CONFIG.bookMin)) {
        return `今天 ${core.fmt(from)} 之前的时段已过，之后的都可以约`;
      }
    }
    return '';
  },

  /** 一格 = 一小时。显示的就是这一小时的价格。 */
  cellText(st, day, ci, from, to) {
    if (st === 'past') return '—';
    if (st === 'confirmed') return '满';
    if (st === 'pending') return '待';
    return String(core.spanPrice(day, ci, from, to));
  },

  cellClass(st, selected) {
    if (st === 'past') return 'cell past';
    if (st === 'confirmed') return 'cell confirmed';
    if (st === 'pending') return 'cell pending';
    return selected ? 'cell selected' : 'cell';
  },

  onTapCell(e) {
    const d = e.currentTarget.dataset;
    const { ri, ci, key } = d;
    const day = this.data.currentDay;
    const from = +String(key).split('|')[1];
    const to = from + CONFIG.bookMin;

    const st = core.spanStatus(day, ci, from, to);
    if (st !== 'free') return;                    // 已占 / 已过，不可点

    const selected = !this.sel.has(key);
    if (selected) this.sel.add(key); else this.sel.delete(key);

    // 只更新这一格，避免整表重排
    this.setData({
      [`gridRows[${ri}].courts[${ci}].cls`]: this.cellClass(st, selected),
    });
    this.updateFooter();
  },

  /* ── 底部结算 ───────────────────────────────────── */
  buildSummary() {
    return core.summarize(this.data.currentDay, [...this.sel]);
  },

  updateFooter() {
    const s = this.buildSummary();
    this.setData({
      footLines: s.items,
      footCount: s.count,
      footHours: s.hours,
      footTotal: s.total,
      hasSelection: s.count > 0,
    });
  },

  /* 把已经约不上的选择挑掉：可能被别人订走了，也可能刚跨天。
     不清空 —— 从填写页返回时客人往往正想接着改。 */
  pruneSel() {
    const day = this.data.currentDay;
    [...this.sel].forEach(k => {
      const [ci, from] = k.split('|').map(Number);
      if (core.spanStatus(day, ci, from, from + CONFIG.bookMin) !== 'free') this.sel.delete(k);
    });
  },

  /* ── 去填写联系方式 ────────────────────────────────
     填写页是独立页面，不是贴底弹层。这不是为了好看：
     输入框在真机上「打字时看不见、收起键盘才出现」的毛病，
     根源就是「fixed 贴底弹层 + 原生输入控件」这个组合 ——
     输入框被当成原生控件单独渲染，而那一层在键盘弹起期间不重绘。

     换成普通页面后输入框回到正常文档流，键盘避让交回系统默认的
     adjust-position（那条路是绝大多数小程序在走的）。
     所以本页不再需要任何键盘高度监听。 */
  onSubmit() {
    const s = this.buildSummary();
    if (!s.count) return;

    // 选择放在 globalData 里过页：格子可能几十个，塞 URL 不现实
    getApp().globalData.pending = {
      dayIdx: this.data.currentDay,
      keys: [...this.sel],
      items: s.items,
      total: s.total,
      hours: s.hours,
      count: s.count,
    };
    wx.navigateTo({ url: '/pages/contact/contact' });
  },

  /* ── 管理入口（长按标题）─────────────────────────────
     ⚠️ 口令写在客户端代码里，这不是安全边界，只是防误触。
        正式版必须改成 openid 白名单 + 云函数校验。 */
  onLongPressTitle() {
    const app = getApp();
    if (app.globalData.adminUnlocked) return this.goAdmin();

    wx.showModal({
      title: '管理入口',
      editable: true,
      placeholderText: '请输入管理口令',
      success: res => {
        if (!res.confirm) return;
        if (res.content === CONFIG.adminPasscode) {
          app.globalData.adminUnlocked = true;
          this.goAdmin();
        } else {
          wx.showToast({ title: '口令不正确', icon: 'none' });
        }
      },
    });
  },

  goAdmin() {
    wx.navigateTo({ url: '/pages/orders/orders' });
  },
});
