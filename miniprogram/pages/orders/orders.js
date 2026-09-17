const core = require('../../utils/core.js');

Page({
  data: {
    tabs: [],
    active: core.PENDING,
    list: [],
    empty: false,
  },

  onShow() {
    core.refreshDates();
    this.render();
  },

  onPullDownRefresh() {
    this.render();
    wx.stopPullDownRefresh();
  },

  /* ── 渲染 ───────────────────────────────────────── */
  render() {
    const active = this.data.active;

    const tabs = [core.PENDING, core.CONFIRMED, core.CANCELLED].map(k => ({
      key: k,
      text: core.STATUS_TEXT[k],
      count: core.countByStatus(k),
      on: k === active,
    }));

    const list = core.bookingsByStatus(active).map(b => this.toCard(b));

    this.setData({ tabs, list, empty: list.length === 0 });
  },

  /** 订单 → 卡片视图模型。把格式化逻辑集中在这里，WXML 里只做取值。 */
  toCard(b) {
    const first = b.items[0] || { court: '', from: 0, to: 0 };
    const multiCourt = b.items.some(it => it.ci !== first.ci);

    // 同一片场地：合成一行 "1号场 19:00–20:30"
    // 跨场地：主行给第一段，副行提示"等 N 段"
    const courtText = multiCourt
      ? `${first.court} 等 ${b.items.length} 段`
      : first.court;
    const timeText = multiCourt
      ? `${core.fmt(first.from)}–${core.fmt(first.to)}`
      : b.items.map(it => `${core.fmt(it.from)}–${core.fmt(it.to)}`).join('、');

    const statusKey = b.status;
    const badge = {
      pending:   { cls: 'badge pending',   text: '待确认' },
      confirmed: { cls: 'badge confirmed', text: '已确认' },
      cancelled: { cls: 'badge cancelled', text: '已取消' },
    }[statusKey] || { cls: 'badge', text: statusKey };

    return {
      id: b.id,
      badgeCls: badge.cls,
      badgeText: badge.text,
      total: b.total,
      dateText: core.prettyDateKey(b.dateKey) + (core.isToday(b.dateKey) ? ' · 今天' : ''),
      urgent: core.isToday(b.dateKey) && statusKey === core.PENDING,
      courtText,
      timeText,
      phone: b.phone,
      name: b.name || '（未留称呼）',
      note: b.note,
      createdText: core.timeAgo(b.createdAt),
      canConfirm: statusKey === core.PENDING,
      canCancel: statusKey !== core.CANCELLED,
      canRestore: statusKey === core.CANCELLED,
    };
  },

  onTapTab(e) {
    const key = e.currentTarget.dataset.key;
    if (key === this.data.active) return;
    this.setData({ active: key }, () => this.render());
  },

  /* ── 操作 ───────────────────────────────────────── */
  onTapCard(e) {
    const id = e.currentTarget.dataset.id;
    const b = core.findBooking(id);
    if (!b) return;

    const segs = b.items
      .map(it => `${it.court} ${core.fmt(it.from)}–${core.fmt(it.to)} ¥${it.price}`)
      .join('\n');

    wx.showModal({
      title: `${core.prettyDateKey(b.dateKey)}  ¥${b.total}`,
      content: `${segs}\n\n${b.name || '（未留称呼）'}  ${b.phone}` +
               (b.note ? `\n备注：${b.note}` : ''),
      confirmText: b.status === core.PENDING ? '标记已确认' : '知道了',
      cancelText: '关闭',
      showCancel: b.status === core.PENDING,
      success: r => {
        if (r.confirm && b.status === core.PENDING) {
          core.confirmBooking(id, '电话已确认');
          this.render();
          wx.showToast({ title: '已确认', icon: 'success' });
        }
      },
    });
  },

  onCall(e) {
    const phone = e.currentTarget.dataset.phone;
    if (!phone) return;
    wx.makePhoneCall({ phoneNumber: phone, fail: () => {} });
  },

  onConfirm(e) {
    const id = e.currentTarget.dataset.id;
    core.confirmBooking(id, '电话已确认');
    this.render();
    wx.showToast({ title: '已确认', icon: 'success' });
  },

  onCancel(e) {
    const id = e.currentTarget.dataset.id;
    wx.showModal({
      title: '取消这笔预约？',
      content: '取消后时段会重新开放给其他客人。',
      confirmText: '确认取消',
      confirmColor: '#FA5151',
      success: r => {
        if (!r.confirm) return;
        core.cancelBooking(id);
        this.render();
        wx.showToast({ title: '已取消', icon: 'none' });
      },
    });
  },

  onRestore(e) {
    const id = e.currentTarget.dataset.id;
    const b = core.findBooking(id);
    if (!b) return;

    // 恢复前查一下时段有没有被重新订走，否则会造出重复占用
    const clash = b.slotKeys.filter(k => {
      const [ci, min] = k.split('|').map(Number);
      const other = core.bookingAt(b.dateKey, ci, min);
      return other && other.id !== b.id;
    });

    if (clash.length) {
      wx.showModal({
        title: '时段已被占用',
        content: `${clash.length} 个半小时档已经被其他客人订走了，无法恢复。`,
        showCancel: false,
      });
      return;
    }

    core.setBookingStatus(id, core.PENDING);
    this.render();
    wx.showToast({ title: '已恢复为待确认', icon: 'none' });
  },

  goPricing() {
    wx.navigateTo({ url: '/pages/pricing/pricing' });
  },
});
