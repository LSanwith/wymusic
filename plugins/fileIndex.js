// 文件挂载 · KV 索引
//
// 为什么需要索引：文件本体仍然放在 Vercel Blob（大文件要直传，KV 不适合存字节），
// 但 Blob 的 list 属于 Advanced Operations（Hobby 只有 2K/月，超了整个 store 停用），
// 而「列文件 / 数公开额度 / 找过期临时文件」以前全靠 list。
// 现在这些信息全放 KV：
//
//   file:items   hash  文件名 -> { name, pathname, url, downloadUrl, size,
//                                 contentType, uploadedAt, tier }
//   file:byUrl   hash  blob url -> 文件名（兼容老页面按 url 删除）
//   file:tmp     zset  临时文件名，score = 上传时间毫秒（GC 按分数取过期）
//   file:pub     zset  公开口令文件名，score = 上传时间毫秒（ZCOUNT 数本月额度）
//
// 这样：列表 = 一次 HGETALL；额度 = 一次 ZCOUNT；GC = 一次 ZRANGEBYSCORE。
// 全部是点查，不再有 list。
//
// 文件名是唯一键：同名文件重新上传会覆盖旧条目（和 Blob 里 allowOverwrite 的行为一致）。
const { kv, kvPipeline, hasKv } = require('./kvStore.js')

const KEY_ITEMS = 'file:items'
const KEY_BY_URL = 'file:byUrl'
const KEY_TMP = 'file:tmp'
const KEY_PUB = 'file:pub'

const TIERS = ['temp', 'pub', 'vip']
const TIER_PREFIX = { temp: 'tmp/', pub: 'keep-pub/', vip: 'keep-vip/' }

/** 路径前缀 -> 档位 */
function tierOfPathname(pathname) {
  const p = String(pathname || '')
  for (const tier of TIERS) {
    if (p.startsWith(TIER_PREFIX[tier])) return tier
  }
  return null
}

/** 档位 -> 路径前缀 */
function prefixOfTier(tier) {
  return TIER_PREFIX[tier] || TIER_PREFIX.temp
}

/** 只留文件名，去掉目录与 .. / 反斜杠 */
function baseName(input) {
  const parts = String(input || '')
    .replace(/\\/g, '/')
    .split('/')
    .filter((s) => s && s !== '.' && s !== '..')
  const last = parts.pop()
  return last ? last.slice(0, 180) : ''
}

function toMs(value) {
  const t = new Date(value).getTime()
  return Number.isFinite(t) ? t : 0
}

function toInt(value) {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

/** 文件的元信息规整成统一形状 */
function normalizeItem(raw) {
  if (!raw || typeof raw !== 'object') return null
  const name = baseName(raw.name || raw.pathname)
  if (!name) return null
  const tier = TIERS.includes(raw.tier)
    ? raw.tier
    : tierOfPathname(raw.pathname)
  return {
    name,
    pathname: raw.pathname || prefixOfTier(tier) + name,
    url: raw.url || null,
    downloadUrl: raw.downloadUrl || raw.url || null,
    size: raw.size != null ? toInt(raw.size) : 0,
    contentType: raw.contentType || '',
    uploadedAt: raw.uploadedAt || new Date().toISOString(),
    tier: tier || 'temp',
  }
}

/** 读一个文件条目 */
async function get(name) {
  const key = baseName(name)
  if (!key) return null
  const raw = await kv(['HGET', KEY_ITEMS, key])
  if (!raw) return null
  try {
    return normalizeItem(JSON.parse(raw))
  } catch {
    return null
  }
}

/** 写入（或覆盖）一个文件条目 */
async function put(input) {
  const item = normalizeItem(input)
  if (!item) throw new Error('文件信息不完整')
  const old = await kv(['HGET', KEY_ITEMS, item.name])
  const commands = [['HSET', KEY_ITEMS, item.name, JSON.stringify(item)]]
  // 同名覆盖时把旧的 URL 映射清掉
  if (old) {
    try {
      const prev = JSON.parse(old)
      if (prev && prev.url) commands.push(['HDEL', KEY_BY_URL, prev.url])
    } catch {
      /* 坏数据，忽略 */
    }
  }
  commands.push(['ZREM', KEY_TMP, item.name])
  commands.push(['ZREM', KEY_PUB, item.name])
  if (item.url) commands.push(['HSET', KEY_BY_URL, item.url, item.name])
  if (item.tier === 'pub') {
    commands.push(['ZADD', KEY_PUB, String(toMs(item.uploadedAt)), item.name])
  } else if (item.tier === 'temp') {
    commands.push(['ZADD', KEY_TMP, String(toMs(item.uploadedAt)), item.name])
  }
  await kvPipeline(commands)
  return item
}

/** 删除索引条目，返回被删掉的条目（调用方拿它去删 Blob 本体） */
async function remove(nameOrUrl) {
  const name = await resolveName(nameOrUrl)
  if (!name) return null
  const item = await get(name)
  if (!item) return null
  const commands = [
    ['HDEL', KEY_ITEMS, name],
    ['HDEL', KEY_TMP, name],
    ['HDEL', KEY_PUB, name],
  ]
  if (item.url) commands.push(['HDEL', KEY_BY_URL, item.url])
  await kvPipeline(commands)
  return item
}

/** 参数既可能是文件名，也可能是老的 blob url（老页面按 url 删） */
async function resolveName(nameOrUrl) {
  const raw = String(nameOrUrl || '').trim()
  if (!raw) return null
  if (/^https?:\/\//i.test(raw)) {
    const name = await kv(['HGET', KEY_BY_URL, raw])
    return name || null
  }
  return baseName(raw)
}

/**
 * 列表：按上传时间倒序。
 * cursor 是「已经拿走了多少条」的偏移量（老的 blob list 用的是字符串游标，
 * 这里换成数字偏移，保持接口形状不变，页面不用改）。
 */
async function list(options) {
  const opts = options || {}
  const limit = Math.min(Math.max(toInt(opts.limit) || 100, 1), 500)
  const offset = Math.max(toInt(opts.cursor) || 0, 0)
  const raw = await kv(['HGETALL', KEY_ITEMS])
  const items = []
  if (Array.isArray(raw)) {
    for (const one of raw) {
      try {
        const item = normalizeItem(JSON.parse(one))
        if (item) items.push(item)
      } catch {
        /* 坏数据跳过 */
      }
    }
  } else if (raw && typeof raw === 'object') {
    for (const one of Object.values(raw)) {
      try {
        const item = normalizeItem(JSON.parse(one))
        if (item) items.push(item)
      } catch {
        /* 坏数据跳过 */
      }
    }
  }
  items.sort((a, b) => toMs(b.uploadedAt) - toMs(a.uploadedAt))
  const page = items.slice(offset, offset + limit)
  const next = offset + page.length
  return {
    items: page,
    total: items.length,
    hasMore: next < items.length,
    cursor: next < items.length ? String(next) : null,
  }
}

/** 公开口令本月已用次数（按东八区自然月；删除文件会同时减少） */
async function pubUsedThisMonth(now) {
  const date = now ? new Date(now) : new Date()
  const month = new Date(date.getTime() + 8 * 3600 * 1000)
    .toISOString()
    .slice(0, 7)
  const [y, m] = month.split('-').map(Number)
  const startMs = Date.UTC(y, m - 1, 1) - 8 * 3600 * 1000
  const used = await kv(['ZCOUNT', KEY_PUB, String(startMs), '+inf'])
  return toInt(used)
}

/** 取已过期的临时文件（不删，调用方先删 Blob 再删索引） */
async function expiredTemps(nowMs, limit) {
  const cutoff = toInt(nowMs) - 7 * 24 * 3600 * 1000
  const max = Math.min(Math.max(toInt(limit) || 300, 1), 1000)
  const names = await kv([
    'ZRANGEBYSCORE',
    KEY_TMP,
    '-inf',
    String(cutoff),
    'LIMIT',
    '0',
    String(max),
  ])
  if (!Array.isArray(names) || !names.length) return []
  const items = []
  for (const name of names) {
    const item = await get(String(name))
    if (item) items.push(item)
  }
  return items
}

/** KV 里一共记了多少个文件（排障用） */
async function count() {
  return toInt(await kv(['HLEN', KEY_ITEMS]))
}

/** 清空索引（只删 KV，不动 Blob；迁移/排障用） */
async function clear() {
  await kvPipeline([
    ['DEL', KEY_ITEMS],
    ['DEL', KEY_BY_URL],
    ['DEL', KEY_TMP],
    ['DEL', KEY_PUB],
  ])
}

/**
 * 从 Vercel Blob 扫一遍把索引补起来。
 * 每个前缀一次 list（Advanced Operation），只在迁移时跑一次。
 */
async function migrateFromBlob(options) {
  const opts = options || {}
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    throw new Error('未配置 BLOB_READ_WRITE_TOKEN，无法读取老的 Blob 数据')
  }
  const { list } = require('@vercel/blob')
  let migrated = 0
  for (const tier of TIERS) {
    let cursor
    do {
      const page = await list({
        prefix: prefixOfTier(tier),
        cursor,
        limit: 500,
      })
      for (const blob of page.blobs || []) {
        const pathname = String(blob.pathname || '')
        if (!pathname) continue
        await put({
          name: baseName(pathname),
          pathname,
          url: blob.url,
          downloadUrl: blob.downloadUrl || blob.url,
          size: blob.size,
          contentType: blob.contentType,
          uploadedAt: blob.uploadedAt,
          tier: tierOfPathname(pathname) || tier,
        })
        migrated += 1
        if (opts.verbose) console.log('文件已迁移', pathname)
      }
      cursor = page.hasMore ? page.cursor : undefined
    } while (cursor)
  }
  return { files: migrated }
}

module.exports = {
  TIERS,
  TIER_PREFIX,
  tierOfPathname,
  prefixOfTier,
  baseName,
  hasKv,
  get,
  put,
  remove,
  resolveName,
  list,
  pubUsedThisMonth,
  expiredTemps,
  count,
  clear,
  migrateFromBlob,
}
