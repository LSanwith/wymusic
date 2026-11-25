// 人机验证（Cloudflare Turnstile）—— 已停用
//
//   GET /file/verify   页面启动时问一句「要不要弹验证框」
//
// 以前这里是 Turnstile：配了 TURNSTILE_SECRET_KEY 就要求上传/列表都带通行证。
// 但 Turnstile 的前端组件在 challenges.cloudflare.com 上，国内网络经常连不上，
// 组件加载失败就永远拿不到通行证 —— 表现就是文件页一进来就卡在验证框、
// 上传完全用不了（TTML 那边 2026-11 也是同一个原因去掉的）。
//
// 现在固定回 enabled:false，页面据此直接进入正常界面。
// 安全兜底仍然在：上传要带 FILE_UPLOAD_KEY 口令（若配置），
// 且文件大小/后缀由上传接口的令牌约束。
//
// 这个接口保留是为了让老页面（缓存里的 JS）问配置时能拿到干净的 200，
// 而不是一个 404。
module.exports = async () => {
  return {
    status: 200,
    body: { code: 200, enabled: false, reason: 'turnstile-disabled' },
  }
}
