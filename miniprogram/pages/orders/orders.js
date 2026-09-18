const core = require('../../utils/core.js');

Page({
  data: {
    tabs: [],
    active: core.PENDING,
    list: [],
    empty: false,
  },

  onShow() {
    this.repaint();      // 本地镜像先上屏，老板一眼就看到单子
    this.refresh();      // 再去拉权威数据（别的店员可能刚改过）
  },

  onPullDownRefresh() {
    /* 转圈要转到数据真回来为止。立刻 stopPullDownRefresh 的话，
       云端的转圈会在列表刷新之前就消失 —— 老板看到的是「下拉了、没反应」。 */
    this.repaint();
    this.refresh(() => wx.stopPullDownRefresh());
  },

  /* ── 两段式：repaint 只画缓存，refresh 取数后再画 ──────
     分法和 booking.js 一样。本页的渲染全部只读内存缓存，
     没有任何「依赖最新数据」的判断，所以 refresh 的 done 里
     除了重画没别的事。 */
  repaint() {
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

  refresh(cb) {
    core.refresh(() => {
      this.repaint();
      if (cb) cb();
    });
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
    this.setData({ active: key }, () => this.repaint());
  },

  /* 四个改状态的入口（卡片里的确认 / 列表上的确认 / 取消 / 恢复）
     共用一套收尾。改状态是异步的：本地当场回来，云端要等网络。
     成功就重画 + 报成功；失败也重画 —— 内存里已经回滚成原状态了，
     重画才能把那张卡片从「已确认」弹回「待确认」，否则界面在骗老板。 */
  commit(t, okText, icon) {
    /* 订单可能已经不在内存里了（列表刷过一轮、数据被清空过）。
       这时 core 返回 null 而不是 task —— 什么都不做、重画一次就好：
       界面会显示真实情况，不该报一个假的成功，也不该崩在这一行。 */
    if (!t) { this.repaint(); return; }

    t.done(() => {
      this.repaint();
      wx.showToast({ title: okText, icon: icon || 'success' });
    }).fail(() => {
      this.repaint();
      wx.showToast({ title: '操作失败，请检查网络后重试', icon: 'none' });
    });
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
          this.commit(core.confirmBooking(id, '电话已确认'), '已确认');
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
    this.commit(core.confirmBooking(id, '电话已确认'), '已确认');
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
        this.commit(core.cancelBooking(id), '已取消', 'none');
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
        content: `${clash.length} 个小时已经被其他客人订走，无法恢复。`,
        showCancel: false,
      });
      return;
    }

    this.commit(core.setBookingStatus(id, core.PENDING), '已恢复为待确认', 'none');
  },

  goPricing() {
    wx.navigateTo({ url: '/pages/pricing/pricing' });
  },
});
