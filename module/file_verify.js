// 人机验证（Cloudflare Turnstile）
//
//   GET /file/verify              页面启动时问一句：开没开？站点公钥是啥？
//   GET /file/verify?token=xxx    拿 Turnstile 的令牌去官方校验，通过则签发通行证
//
// 说明：Turnstile 与 Cloudflare 的 CDN/WAF 无关，域名不接入 CF 也能用，
// 只要在 CF 面板建一个 widget，hostname 填本站域名即可。
const { enabled, issue } = require('../plugins/filePass.js')

const SITEVERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify'

module.exports = async (query) => {
  // 没配密钥就是不启用，页面照常工作（不把功能锁死）
  if (!enabled()) {
    return { status: 200, body: { code: 200, enabled: false } }
  }

  const token = String(query.token || '').trim()

  // 不带 token：只回配置，页面据此决定要不要弹验证框
  if (!token) {
    return {
      status: 200,
      body: {
        code: 200,
        enabled: true,
        siteKey: process.env.TURNSTILE_SITE_KEY || '',
      },
    }
  }

  try {
    const res = await fetch(SITEVERIFY, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        secret: process.env.TURNSTILE_SECRET_KEY,
        response: token,
      }),
    })
    const data = await res.json()
    if (!data.success) {
      return {
        status: 403,
        body: {
          code: 403,
          msg: '人机验证未通过，请重试',
          // error-codes 是 CF 的诊断码（如 timeout-or-duplicate），
          // 便于排查，不含敏感信息
          detail: (data['error-codes'] || []).join(','),
        },
      }
    }
    return { status: 200, body: { code: 200, pass: issue() } }
  } catch (e) {
    return {
      status: 502,
      body: { code: 502, msg: '校验服务暂时不可用：' + (e.message || e) },
    }
  }
}
