// 文件挂载代理 · 保存期与口令策略
// 被 module/file_*.js require，本身不是路由（plugins/ 不会被扫描成接口）。
//
// 保存期直接编码在 Blob 的路径前缀里，不需要额外的数据库或计数器：
//   tmp/        默认，上传后 7 天由 GC 删除
//   keep-pub/   用公开口令 FileAlways 永久保存（全站每月共享 5 次）
//   keep-vip/   用私有口令永久保存（不限次数）
//
// 私有口令在公开仓库里只保存 SHA-256 哈希，无法反推原文。
// 需要更换时设置环境变量 FILE_ALWAYS_PRIVATE_KEY（明文，优先于内置哈希）。
const crypto = require('crypto')

const PREFIX = {
  temp: 'tmp/',
  pub: 'keep-pub/',
  vip: 'keep-vip/',
}

const TEMP_DAYS = 7
const PUB_MONTHLY_LIMIT = 5

const PUBLIC_KEY = 'FileAlways'
const PRIVATE_KEY_HASH =
  'a26b66607bcaefab5c90d041cfddf52646b757c37268957917f509904ad322a0'

function sha256(s) {
  return crypto.createHash('sha256').update(String(s)).digest('hex')
}

/** 按东八区算自然月，中文站用这个更符合直觉 */
function monthKey(date) {
  return new Date(date.getTime() + 8 * 3600 * 1000).toISOString().slice(0, 7)
}

/** 校验永久保存口令：返回 'vip' | 'pub' | null */
function alwaysTier(input) {
  const s = String(input || '')
  if (!s) return null
  const priv = process.env.FILE_ALWAYS_PRIVATE_KEY
  if (priv ? s === priv : sha256(s) === PRIVATE_KEY_HASH) return 'vip'
  if (s === PUBLIC_KEY) return 'pub'
  return null
}

/** 由路径前缀与上传时间推出该文件的保存期信息 */
function retentionOf(pathname, uploadedAt) {
  const name = String(pathname || '')
  if (name.startsWith(PREFIX.vip)) {
    return { kind: 'vip', label: '永久保存' }
  }
  if (name.startsWith(PREFIX.pub)) {
    return { kind: 'pub', label: '永久保存' }
  }
  const ms = TEMP_DAYS * 24 * 3600 * 1000
  const expires = new Date(new Date(uploadedAt).getTime() + ms)
  const left = Math.max(
    0,
    Math.ceil((expires.getTime() - Date.now()) / (24 * 3600 * 1000)),
  )
  return {
    kind: 'temp',
    label: left > 0 ? `${TEMP_DAYS} 天有效（剩 ${left} 天）` : '即将清理',
    expiresAt: expires.toISOString(),
  }
}

/** 本月公开口令已用次数 = keep-pub/ 下本月上传的文件数（删除后会释放名额） */
async function pubUsedThisMonth() {
  const { list } = require('@vercel/blob')
  const now = monthKey(new Date())
  let cursor
  let used = 0
  do {
    const r = await list({ prefix: PREFIX.pub, limit: 100, cursor })
    for (const b of r.blobs || []) {
      if (monthKey(new Date(b.uploadedAt)) === now) used++
    }
    cursor = r.hasMore ? r.cursor : undefined
  } while (cursor)
  return used
}

/** 删除已过期的临时文件，返回删除条数 */
async function gcExpired(limit = 300) {
  const { list, del } = require('@vercel/blob')
  const now = Date.now()
  const ms = TEMP_DAYS * 24 * 3600 * 1000
  const doomed = []
  let cursor
  do {
    const r = await list({ prefix: PREFIX.temp, limit: 100, cursor })
    for (const b of r.blobs || []) {
      if (now - new Date(b.uploadedAt).getTime() >= ms) doomed.push(b.url)
    }
    cursor = r.hasMore ? r.cursor : undefined
  } while (cursor && doomed.length < limit)
  const batch = doomed.slice(0, limit)
  if (batch.length) await del(batch)
  return batch.length
}

module.exports = {
  PREFIX,
  TEMP_DAYS,
  PUB_MONTHLY_LIMIT,
  PUBLIC_KEY,
  sha256,
  monthKey,
  alwaysTier,
  retentionOf,
  pubUsedThisMonth,
  gcExpired,
}
