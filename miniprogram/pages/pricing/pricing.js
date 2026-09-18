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

    /* 一格 = 一小时，和客人页一模一样（CONFIG.slotMin 就是 60）。
       所以这里不再有「一行两格、两格拼成一小时」那回事 ——
       一行就是每片场地各一格，填多少这一小时就多少。 */
    const gridRows = core.HOURS.map(h => {
      const courts = [];
      for (let ci = 0; ci < n; ci++) {
        const ov = core.hasOverride(day, ci, h);
        if (ov) overrides++;
        const key = `${ci}|${h}`;
        courts.push({
          ci,
          key,
          text: String(core.priceFor(day, ci, h)),
          cls: this.cellCls(ov, this.sel.has(key)),
        });
      }
      return { label: core.fmt(h), min: h, courts };
    });

    this.setData({ gridRows, overrideCount: overrides });
  },

  cellCls(ov, selected) {
    if (selected) return 'cell selected';
    return ov ? 'cell override' : 'cell';
  },

  /* ── 选择 ───────────────────────────────────────── */

  /** 点单格：选中 / 取消 */
  onTapCell(e) {
    const key = e.currentTarget.dataset.key;
    if (!key || key[0] === 'x') return;
    if (this.sel.has(key)) this.sel.delete(key); else this.sel.add(key);
    this.repaint();
  },

  /** 点场地表头：整列（该场地今天全部时段）反选 */
  onTapCourtHead(e) {
    const ci = +e.currentTarget.dataset.ci;
    this.toggleMany(core.SLOTS.map(min => `${ci}|${min}`));
  },

  /** 点时间列：整行（这一小时 × 全部场地）反选 */
  onTapRowLabel(e) {
    const h = +e.currentTarget.dataset.min;
    this.toggleMany(CONFIG.courts.map((_, ci) => `${ci}|${h}`));
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
    const n = this.sel.size;
    /* 一次选中最多 56 格（整张表）。逐格 setOverride 会把整张价格表序列化几十次，
       所以走批量版：一次写完（接云开发后这一条对应一次云函数调用）。

       落库是异步的：本地当场回来，云端要等网络。成功才清空选择并重画；
       失败时内存已经回滚，重画一次把格子弹回真实价格，选择【留着】——
       老板直接再点一次「应用」就是重试。 */
    core.setOverrides(day, [...this.sel], price)
      .done(() => {
        this.sel.clear();
        this.setData({ priceInput: '' });
        this.repaint();
        wx.showToast({ title: `已改 ${n} 个时段`, icon: 'none' });
      })
      .fail(() => {
        this.repaint();
        wx.showToast({ title: '改价失败，请检查网络后重试', icon: 'none' });
      });
  },

  /** 恢复规则价：把覆盖删掉，价格回到 CONFIG.rates 算出来的值 */
  onResetRule() {
    if (!this.sel.size) {
      wx.showToast({ title: '请先选择要恢复的时段', icon: 'none' });
      return;
    }
    const day = this.data.currentDay;
    const n = this.sel.size;
    core.clearOverrides(day, [...this.sel])    // 同样走批量版
      .done(() => {
        this.sel.clear();
        this.repaint();
        wx.showToast({ title: `已恢复 ${n} 个时段`, icon: 'none' });
      })
      .fail(() => {
        this.repaint();
        wx.showToast({ title: '恢复失败，请检查网络后重试', icon: 'none' });
      });
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
        /* 清空是两步写（订单 + 价格），两步都成了才算清干净。
           失败会把两边一起回滚，所以这里只要如实报错。 */
        core.clearAllData()
          .done(() => {
            this.sel.clear();
            this.repaint();
            wx.showToast({ title: '已清空', icon: 'none' });
          })
          .fail(() => {
            this.repaint();
            wx.showToast({ title: '清空失败，请检查网络后重试', icon: 'none' });
          });
      },
    });
  },
});
