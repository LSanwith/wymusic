// 人机验证（Cloudflare Turnstile）通过后签发的「通行证」
//
// 为什么要这么设计：module/* 的签名是 (query, request)，拿不到 res，
// 既写不了 Cookie 也设不了响应头，而 Vercel 函数又是无状态的。
// 所以通行证做成「自包含的签名串」：
//   服务端用 HMAC 签一个带过期时间的 token 发给页面，
//   页面存 localStorage，之后每个管理类请求都带 &pass=...
//   服务端只需重算一次 HMAC 即可校验，无需任何存储。
const crypto = require('crypto')

/** 通行证有效期：12 小时 */
const TTL_MS = 12 * 60 * 60 * 1000

/** 是否开启人机验证：配了 Turnstile 的 Secret Key 就开 */
function enabled() {
  return !!process.env.TURNSTILE_SECRET_KEY
}

/** 签名密钥。优先用专用变量，没配则退回 Turnstile 的 Secret Key */
function secret() {
  return process.env.FILE_PASS_SECRET || process.env.TURNSTILE_SECRET_KEY || ''
}

function sign(data) {
  return crypto.createHmac('sha256', secret()).update(data).digest('base64url')
}

/** 签发通行证：<过期时间戳>.<签名> */
function issue(now = Date.now()) {
  const exp = String(now + TTL_MS)
  return `${exp}.${sign(exp)}`
}

/** 校验通行证：签名正确且未过期 */
function verify(pass) {
  if (!pass) return false
  const parts = String(pass).split('.')
  if (parts.length !== 2) return false
  const [exp, sig] = parts
  if (!/^\d+$/.test(exp)) return false
  const want = sign(exp)
  // 长度不等时 timingSafeEqual 会抛错，先挡掉；
  // 定长比较是为了避免按字节比较带来的计时侧信道
  if (sig.length !== want.length) return false
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want))) return false
  return Number(exp) > Date.now()
}

/**
 * 需要通行证却没带 / 无效时，返回该回给客户端的响应；通过则返回 null。
 * 附带 needVerify 标记，页面据此清掉本地通行证并弹出验证框。
 */
function guard(query) {
  if (!enabled()) return null
  if (verify(query && query.pass)) return null
  return {
    status: 403,
    body: { code: 403, needVerify: true, msg: '请先完成人机验证' },
  }
}

module.exports = { enabled, issue, verify, guard, TTL_MS }
