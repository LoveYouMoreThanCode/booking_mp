const core = require('./utils/core.js');

App({
  globalData: {
    // 管理端入口由长按标题触发，这里记录本次启动是否已通过口令校验。
    // 注意：这只是「防误触」，不是安全边界 —— 口令写在客户端代码里，
    // 任何人都能看到。正式版必须改成 openid 白名单 + 云函数校验。
    adminUnlocked: false,

    /* 预约页 → 填写页之间传的选择。
       选中的格子可能有几十个，塞 URL 不现实，所以放这儿过一手。
       填写页提交成功后清空，免得返回再进去重复提交。 */
    pending: null,
  },

  onLaunch() {
    // 首次启动灌一批演示预约，方便真机上直接看到效果。
    // 正式接云开发后，这一步会换成从数据库拉取。
    core.seedDemoBookings();
  },
});
