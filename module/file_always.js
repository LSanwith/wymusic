// 文件挂载代理 · 永久保存口令预检
//
//   GET /file/always?always=<口令>
//
// 用途：上传前先问一次，好在页面上【实时】告诉用户这个口令是哪一档、
// 公开额度还剩几次。否则额度用完时 @vercel/blob/client 只会抛一句英文的
// "Failed to retrieve the client token"，用户根本不知道发生了什么。
//
// 返回 tier：
//   none     没填口令（按 7 天有效上传）
//   invalid  口令不对
//   pub      公开口令，带 limit / used / left
//   vip      私有口令，不限次数
const {
  PUB_MONTHLY_LIMIT,
  alwaysTier,
  pubUsedThisMonth,
} = require('../plugins/fileRetention.js')

module.exports = async (query) => {
  const key = String(query.always || '').trim()

  if (!key) {
    return {
      status: 200,
      body: { code: 200, tier: 'none', limit: PUB_MONTHLY_LIMIT },
    }
  }

  const tier = alwaysTier(key)
  if (!tier) {
    return {
      status: 200,
      body: { code: 200, tier: 'invalid', limit: PUB_MONTHLY_LIMIT },
    }
  }

  if (tier === 'vip') {
    return { status: 200, body: { code: 200, tier: 'vip' } }
  }

  // 公开口令：只有配置了 Blob 才数得出已用次数
  let used = null
  if (process.env.BLOB_READ_WRITE_TOKEN) {
    try {
      used = await pubUsedThisMonth()
    } catch {
      used = null
    }
  }
  return {
    status: 200,
    body: {
      code: 200,
      tier: 'pub',
      limit: PUB_MONTHLY_LIMIT,
      used,
      left: used === null ? null : Math.max(0, PUB_MONTHLY_LIMIT - used),
    },
  }
}
