const core = require('../../utils/core.js');
const CONFIG = core.CONFIG;

Page({
  data: {
    dates: [],
    currentDay: 0,
    gridRows: [],
    courtNames: CONFIG.courts,

    selCount: 0,
    hasSel: false,
    priceInput: '',
    // 快捷价签：直接取三条规则价，去重
    quick: [...new Set([CONFIG.rates.weekdayDay, CONFIG.rates.weekdayNight, CONFIG.rates.weekend])],
    overrideCount: 0,
  },

  // 选中的格子 "ci|min"，放在 data 外面，靠 class 表达选中态
  sel: null,
  // 上一次点过的格子，用于「点一下再点一下取消」
  lastTap: null,

  onLoad() {
    this.sel = new Set();
    this.renderDates();
    this.buildGrid();
  },

  onShow() {
    core.refreshDates();
    this.sel.clear();
    this.renderDates();
    this.buildGrid();
  },

  /* ── 日期条 ─────────────────────────────────────── */
  renderDates() {
    this.setData({
      dates: core.DATES.map((d, i) => ({
        idx: i,
        dow: core.dateLabel(d, i),
        num: `${d.getMonth() + 1}/${d.getDate()}`,
        active: i === this.data.currentDay,
      })),
    });
  },

  onTapDate(e) {
    const idx = +e.currentTarget.dataset.idx;
    if (idx === this.data.currentDay) return;
    this.sel.clear();
    this.setData({ currentDay: idx }, () => {
      this.renderDates();
      this.buildGrid();
      this.updateToolbar();
    });
  },

  /* ── 网格 ───────────────────────────────────────── */
  buildGrid() {
    const day = this.data.currentDay;
    const n = CONFIG.courts.length;
    let overrides = 0;

    const gridRows = core.HOURS.map(h => {
      const courts = [];
      for (let ci = 0; ci < n; ci++) {
        const halves = [];
        for (let hi = 0; hi < 2; hi++) {
          const min = h + hi * CONFIG.slotMin;
          if (min >= CONFIG.closeHour * 60) {
            halves.push({ key: `x${ci}_${min}`, text: '', cls: 'half hide' });
            continue;
          }
          const ov = core.hasOverride(day, ci, min);
          if (ov) overrides++;
          const key = `${ci}|${min}`;
          halves.push({
            key,
            text: String(core.priceFor(day, ci, min)),
            cls: this.halfCls(ov, this.sel.has(key)),
          });
        }
        courts.push({ ci, halves });
      }
      return { label: core.fmt(h), min: h, courts };
    });

    this.setData({ gridRows, overrideCount: overrides });
  },

  halfCls(ov, selected) {
    if (selected) return 'half selected';
    return ov ? 'half override' : 'half';
  },

  /* ── 选择 ───────────────────────────────────────── */

  /** 点单格：选中 / 取消 */
  onTapHalf(e) {
    const key = e.currentTarget.dataset.key;
    if (!key || key[0] === 'x') return;
    if (this.sel.has(key)) this.sel.delete(key); else this.sel.add(key);
    this.repaint();
  },

  /** 点场地表头：整列（该场地今天全部时段）反选 */
  onTapCourtHead(e) {
    const ci = +e.currentTarget.dataset.ci;
    const keys = [];
    core.SLOTS.forEach(min => {
      if (min < CONFIG.closeHour * 60) keys.push(`${ci}|${min}`);
    });
    this.toggleMany(keys);
  },

  /** 点时间列：整行（该小时两格 × 全部场地）反选 */
  onTapRowLabel(e) {
    const h = +e.currentTarget.dataset.min;
    const keys = [];
    CONFIG.courts.forEach((_, ci) => {
      for (let hi = 0; hi < 2; hi++) {
        const min = h + hi * CONFIG.slotMin;
        if (min < CONFIG.closeHour * 60) keys.push(`${ci}|${min}`);
      }
    });
    this.toggleMany(keys);
  },

  /** 整批：只要有一个没选中，就全部选中；否则全部取消 */
  toggleMany(keys) {
    const allOn = keys.every(k => this.sel.has(k));
    keys.forEach(k => allOn ? this.sel.delete(k) : this.sel.add(k));
    this.repaint();
  },

  onClearSel() {
    this.sel.clear();
    this.repaint();
  },

  /** 重画整表 + 工具条。格子多但只在点击后跑一次，够用。 */
  repaint() {
    this.buildGrid();
    this.updateToolbar();
  },

  updateToolbar() {
    this.setData({ selCount: this.sel.size, hasSel: this.sel.size > 0 });
  },

  /* ── 改价 ───────────────────────────────────────── */
  onInputPrice(e) {
    this.setData({ priceInput: e.detail.value.replace(/\D/g, '') });
  },

  onTapQuick(e) {
    this.setData({ priceInput: String(e.currentTarget.dataset.v) });
  },

  onApply() {
    const price = parseInt(this.data.priceInput, 10);
    if (!price || price <= 0) {
      wx.showToast({ title: '请先填一个有效价格', icon: 'none' });
      return;
    }
    if (!this.sel.size) {
      wx.showToast({ title: '请先选择要改的时段', icon: 'none' });
      return;
    }

    const day = this.data.currentDay;
    this.sel.forEach(k => {
      const [ci, min] = k.split('|').map(Number);
      core.setOverride(day, ci, min, price);
    });

    const n = this.sel.size;
    this.sel.clear();
    this.setData({ priceInput: '' });
    this.repaint();
    wx.showToast({ title: `已改 ${n} 个时段`, icon: 'none' });
  },

  /** 恢复规则价：把覆盖删掉，价格回到 CONFIG.rates 算出来的值 */
  onResetRule() {
    if (!this.sel.size) {
      wx.showToast({ title: '请先选择要恢复的时段', icon: 'none' });
      return;
    }
    const day = this.data.currentDay;
    this.sel.forEach(k => {
      const [ci, min] = k.split('|').map(Number);
      core.clearOverride(day, ci, min);
    });

    const n = this.sel.size;
    this.sel.clear();
    this.repaint();
    wx.showToast({ title: `已恢复 ${n} 个时段`, icon: 'none' });
  },

  /* ── 危险操作 ───────────────────────────────────── */
  onResetAll() {
    wx.showModal({
      title: '清空全部数据？',
      content: '所有预约记录和管理员手改的价格都会被清除，回到初始演示数据。此操作不可撤销。',
      confirmText: '确认清空',
      confirmColor: '#FA5151',
      success: r => {
        if (!r.confirm) return;
        core.clearAllData();
        this.sel.clear();
        this.repaint();
        wx.showToast({ title: '已清空', icon: 'none' });
      },
    });
  },
});
