const core = require('../../utils/core.js');
const CONFIG = core.CONFIG;

Page({
  data: {
    // 从预约页带过来的清单
    items: [],
    total: 0,
    hours: 0,
    count: 0,

    phoneErr: false,      // 只在提交时判，见 onConfirm

    showDone: false,
    doneText: '',
  },

  /* 输入框的内容【故意不放进 data】。
     如果 value="{{phone}}" 绑到 data，又在 bindinput 里 setData 写回，
     就成了「受控输入」：每敲一个字都要绕一圈数据层才回到输入框，
     输入法打字一快就跟不上这个来回（吞字、光标乱跳）。
     本页每次进来输入框本来就是空的，值存在实例上、提交时读出来就够了。 */
  phone: '',
  name: '',
  note: '',

  // 待提交的预约（来自预约页）。见 booking.js 的 onSubmit。
  pending: null,

  onLoad() {
    const pending = getApp().globalData.pending;
    if (!pending) {
      // 直接打开本页（比如从开发工具的页面列表进来），没什么可填的，退回去
      wx.showToast({ title: '请先选择时段', icon: 'none' });
      setTimeout(() => wx.navigateBack(), 800);
      return;
    }
    this.pending = pending;
    this.setData({
      items: pending.items,
      total: pending.total,
      hours: pending.hours,
      count: pending.count,
    });
  },

  /* 三个框的处理方式【完全一样】：输入时只往实例上存一个字，
     不 setData、不校验、不数数。打字过程中一次 setData 都不发，
     就没有任何东西能干扰输入框自己。

     手机号的合法性等点「确认提交」时再判（见 onConfirm）——
     不合格就提示一句，客人接着改，报错不会跟着他打字一路闪。 */
  onInputPhone(e) { this.phone = e.detail.value; },
  onInputName(e) { this.name = e.detail.value; },
  onInputNote(e) { this.note = e.detail.value; },

  /** 从 pending.keys 重算清单 —— 剔除冲突的时段后要重画 */
  recap() {
    const s = core.summarize(this.pending.dayIdx, this.pending.keys);
    Object.assign(this.pending, {
      items: s.items, total: s.total, hours: s.hours, count: s.count,
    });
    this.setData({ items: s.items, total: s.total, hours: s.hours, count: s.count });
  },

  onConfirm() {
    const phone = (this.phone || '').replace(/\D/g, '');
    const name = this.name || '';
    const note = this.note || '';
    if (!/^1[3-9]\d{9}$/.test(phone)) {
      this.setData({ phoneErr: true });
      return;
    }

    const p = this.pending;

    // 提交前重新校验：从在预约页上选完到现在，选中的格子可能已被别人订走
    const taken = p.keys.filter(k => {
      const [ci, from] = k.split('|').map(Number);
      return core.spanStatus(p.dayIdx, ci, from, from + CONFIG.bookMin) !== 'free';
    });

    if (taken.length) {
      taken.forEach(k => p.keys.splice(p.keys.indexOf(k), 1));
      this.recap();
      wx.showToast({
        title: p.keys.length
          ? '部分时段已不可预约，已剔除，其余可继续提交'
          : '抱歉，你选的时段已不可预约',
        icon: 'none',
        duration: 2600,
      });
      return;
    }

    /* 落单是【异步】的（本地后端当场返回，云端要等网络）。
       所以「提交成功之后的事」全写在 done 里 —— 写在下一行的话，
       本地能跑，云端会在订单还没落地时就跳到成功页。 */
    core.createBooking({
      dayIdx: p.dayIdx,
      groups: core.groupSlots(core.parseKeys(p.keys), CONFIG.bookMin),
      phone,
      name: name.trim(),
      note: note.trim(),
    })
      .done(res => {
        if (!res.ok) {
          wx.showToast({ title: '抱歉，你选的时段已不可预约', icon: 'none', duration: 2600 });
          return;
        }
        if (res.skipped.length) {
          wx.showToast({ title: '部分时段已不可预约，已为你剔除', icon: 'none', duration: 2600 });
        }

        // 交掉了就清掉，免得返回再进来重复提交
        getApp().globalData.pending = null;

        const masked = `${phone.slice(0, 3)}****${phone.slice(-4)}`;
        this.setData({
          showDone: true,
          doneText: `预约已提交，我们会尽快致电 ${masked} 与您确认`,
        });
      })
      .fail(() => {
        /* 订单没能落库（网络断了、云函数出错）。内存里那条已经回滚，
           所以【绝不能】给客人看成功页 —— 他以为约上了，老板那头没有。
           pending 也留着不消费，客人再点一次「确认提交」就是重试。 */
        wx.showToast({ title: '提交失败，请检查网络后重试', icon: 'none', duration: 2600 });
      });
  },

  /* 再约一场：回预约页。那边 onShow 会把已约不上的选择挑掉，
     所以这里不用管。 */
  onAgain() {
    wx.navigateBack();
  },
});
