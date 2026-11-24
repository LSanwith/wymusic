// 管理密码校验（/ttml/destroy 与 /ttml/migrate 共用）
//
// 密码来自环境变量 TTML_ADMIN_PASS；没配就比代码里的 scrypt 哈希。
// 放在 plugins/ 下是因为它只是个工具，不该被当成接口路由。
const crypto = require('crypto')

// 管理密码的 scrypt 哈希（**不是密码本身**）：
//   scrypt$<salt hex>$<hash hex>，N=16384 r=8 p=1，64 字节
// 放在代码里是为了不依赖环境变量也能用；它不可逆，
// 但这是公开仓库，理论上可以被离线暴力破解（scrypt 让成本很高）。
// 想要更稳就把密码配到环境变量 TTML_ADMIN_PASS —— 配了就以它为准。
const BUILTIN_HASH =
  'scrypt$58e7af784b1ef1d3f4fc531f0408d257$ac2e06ce65213e5b72c2efaa8d8a748e1a90b9bfb5cf9de9f979081cb5e38fcb9e08bec62430fdb06193eb63f2aeca851faecd2480af08be4f8dea5eec5c1fa9'
const SCRYPT_OPT = { N: 16384, r: 8, p: 1 }

/** 环境变量里的管理密码；没配就是空串 */
function envPass() {
  return String(process.env.TTML_ADMIN_PASS || '')
}

/** 校验内置哈希 */
function checkBuiltin(got) {
  const parts = BUILTIN_HASH.split('$')
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false
  const salt = Buffer.from(parts[1], 'hex')
  const want = Buffer.from(parts[2], 'hex')
  if (!salt.length || !want.length) return false
  let calc
  try {
    calc = crypto.scryptSync(got, salt, want.length, SCRYPT_OPT)
  } catch {
    return false
  }
  return calc.length === want.length && crypto.timingSafeEqual(calc, want)
}

/**
 * 校验管理密码：环境变量优先，没配就比内置哈希。
 * 两条路径都是定长比较，不泄露「长度」或「第几位开始不一样」。
 */
function checkPassword(input) {
  const got = String(input == null ? '' : input)
  if (!got) return { ok: false, reason: 'missing' }
  const want = envPass()
  if (want) {
    const a = crypto.createHash('sha256').update(got, 'utf8').digest()
    const b = crypto.createHash('sha256').update(want, 'utf8').digest()
    return { ok: crypto.timingSafeEqual(a, b), reason: 'mismatch' }
  }
  return { ok: checkBuiltin(got), reason: 'mismatch' }
}

/** 密码不对时统一拖慢一点，抬高暴力尝试成本 */
async function slowDown(ms) {
  await new Promise((r) => setTimeout(r, ms == null ? 600 : ms))
}

module.exports = { checkPassword, slowDown }
