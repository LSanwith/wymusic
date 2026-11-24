// TTML 歌词存储（Upstash Redis / Vercel KV）
//
// 为什么从 Vercel Blob 搬走：
//   Blob 把 list / copy 算成 Advanced Operations，Hobby 每月只有 2K 次，
//   超了会把整个 store 停用（我们的 wymusic-file 就被停到 2026-12-08）。
//   歌词是「小文本 + 按 id 随机读」的东西，本来就不该用对象存储：
//   之前为了找一份歌词要 list 整个前缀，几天就把额度烧穿。
//
// 现在数据结构（全是 KV 的点查，没有 list 这种概念）：
//   ttml:song:<歌曲id>          -> ttmlId
//   ttml:content:<ttmlId>       -> 歌词正文
//   ttml:meta:<ttmlId>          -> {"size":…,"uploadedAt":"…"}（JSON 字符串）
//   ttml:users:<ttmlId>         -> 绑在这份歌词上的歌曲 id（set）
//   ttml:ids                    -> 所有 ttmlId（set，管理页用）
//   ttml:legacy:<歌曲id>        -> 老格式 ttml/<歌曲id>.ttml 的正文
//   ttml:legacy:meta:<歌曲id>   -> {"size":…,"uploadedAt":"…"}
//   ttml:legacy:ids             -> 所有老格式歌曲 id（set）
//
// 读一份歌词 = 2 个命令（GET song + GET content），正文按内容哈希命名、内容不会变，
// 所以进程内长期缓存；元信息也用 JSON 字符串存，避免 HGETALL 在不同 REST
// 版本下「对象 / 扁平数组」两种形状带来的不确定性。
//
// 环境变量（Vercel 里连一个 Upstash for Redis、前缀选 KV 会自动注入）：
//   KV_REST_API_URL / KV_REST_API_TOKEN
// 老数据迁移：见 migrateFromBlob()（Blob store 恢复后跑一次 /ttml/migrate）
const crypto = require('crypto')

const PREFIX = 'ttml/'
const CONTENT_PREFIX = PREFIX + 'c/'
const BIND_PREFIX = PREFIX + 'b/'
const LEGACY_SUFFIX = '.ttml'

// Blob 时代的路径规则，只给「迁移老数据」和对外兼容用
const CONTENT_RE = /^ttml\/c\/([0-9a-f]{16})\.ttml$/
const BIND_RE = /^ttml\/b\/(\d+)--([0-9a-f]{16})\.json$/
const LEGACY_RE = /^ttml\/(\d+)\.ttml$/

/** 歌曲 id → ttmlId 的进程内缓存（一次往返不贵，但没必要每个请求都打） */
const SONG_TTL_MS = 30 * 1000
/** 「没有老格式歌词」这个结论也缓存，别让每个查不到的请求都花 2 个命令 */
const LEGACY_TTL_MS = 60 * 1000
const CONTENT_CACHE_MAX = 300

const songCache = new Map() // songId -> { at, ttmlId }
const contentCache = new Map() // ttmlId -> { ttml, size, uploadedAt }
const legacyCache = new Map() // songId -> { at, data }

/** 网易云歌曲 id 都是纯数字 */
function isValidId(id) {
  return /^\d{1,20}$/.test(String(id == null ? '' : id).trim())
}

/** 内容 id：16 位十六进制 */
function isValidTtmlId(id) {
  return /^[0-9a-f]{16}$/.test(String(id == null ? '' : id).trim())
}

function contentKey(ttmlId) {
  return CONTENT_PREFIX + ttmlId + LEGACY_SUFFIX
}

function bindKey(songId, ttmlId) {
  return BIND_PREFIX + songId + '--' + ttmlId + '.json'
}

/** 老版本路径：ttml/<歌曲id>.ttml */
function legacyKey(songId) {
  return PREFIX + songId + LEGACY_SUFFIX
}

/**
 * 由歌词内容算出它的身份 id。
 * 空白全部折叠成一个空格再算 —— 只是换了缩进/换行/排版不该算出两个身份，
 * 否则「内容没变，只是重新格式化」就能绕过重复检测。
 */
function ttmlIdOf(ttml) {
  const canon = String(ttml == null ? '' : ttml)
    .replace(/\s+/g, ' ')
    .trim()
  return crypto
    .createHash('sha256')
    .update(canon, 'utf8')
    .digest('hex')
    .slice(0, 16)
}

// ---------------------------------------------------------------------------
// KV 传输层：直接打 Upstash 的 REST 接口，不额外引依赖
// ---------------------------------------------------------------------------

function kvUrl() {
  const raw = String(
    process.env.KV_REST_API_URL || process.env.TTML_KV_URL || '',
  ).trim()
  return raw.replace(/\/+$/, '')
}

function kvToken() {
  return String(
    process.env.KV_REST_API_TOKEN || process.env.TTML_KV_TOKEN || '',
  ).trim()
}

/** 配了 KV 才算能用（没配时接口回 501，不是崩） */
function hasToken() {
  return !!kvUrl() && !!kvToken()
}

async function kvRequest(path, payload) {
  const url = kvUrl()
  if (!url) throw new Error('未配置 KV（缺少 KV_REST_API_URL）')
  const res = await fetch(url + path, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${kvToken()}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(payload),
  })
  const text = await res.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    json = null
  }
  if (!res.ok) {
    const detail = (json && json.error) || text.slice(0, 200)
    throw new Error(`KV 请求失败（${res.status}）：${detail}`)
  }
  if (!json) throw new Error('KV 返回不是 JSON：' + text.slice(0, 200))
  if (!Array.isArray(json) && json.error) throw new Error('KV：' + json.error)
  return json
}

/** 单条命令，返回 result */
async function kv(command) {
  const json = await kvRequest('', command)
  return json ? json.result : null
}

/** 一次往返跑多条命令，按顺序返回 result 数组 */
async function kvPipeline(commands) {
  if (!commands.length) return []
  const results = await kvRequest('/pipeline', commands)
  if (!Array.isArray(results)) throw new Error('KV pipeline 返回异常')
  for (const item of results) {
    if (item && item.error) throw new Error('KV：' + item.error)
  }
  return results.map((item) => (item ? item.result : null))
}

// ---------------------------------------------------------------------------
// 键
// ---------------------------------------------------------------------------

const keySong = (songId) => `ttml:song:${songId}`
const keyContent = (ttmlId) => `ttml:content:${ttmlId}`
const keyMeta = (ttmlId) => `ttml:meta:${ttmlId}`
const keyUsers = (ttmlId) => `ttml:users:${ttmlId}`
const keyIds = () => 'ttml:ids'
const keyLegacy = (songId) => `ttml:legacy:${songId}`
const keyLegacyMeta = (songId) => `ttml:legacy:meta:${songId}`
const keyLegacyIds = () => 'ttml:legacy:ids'

function toInt(value) {
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

/** 元信息是 JSON 字符串，坏数据就当成空 */
function parseMeta(raw) {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

function metaJson(size, uploadedAt) {
  return JSON.stringify({ size, uploadedAt: uploadedAt || null })
}

/** 清空进程内缓存（写入/删除后调用，测试与排障也用） */
function clearCaches() {
  songCache.clear()
  contentCache.clear()
  legacyCache.clear()
}

/** 歌曲 id 现在绑的 ttmlId（30 秒缓存） */
async function songTtmlId(songId) {
  const id = String(songId)
  const hit = songCache.get(id)
  if (hit && Date.now() - hit.at < SONG_TTL_MS) return hit.ttmlId
  const ttmlId = await kv(['GET', keySong(id)])
  songCache.set(id, { at: Date.now(), ttmlId: ttmlId || null })
  return ttmlId || null
}

/** 正文（内容按哈希命名，不会变，缓存到进程结束） */
async function readContent(ttmlId) {
  const cached = contentCache.get(ttmlId)
  if (cached) return cached
  const [text, rawMeta] = await kvPipeline([
    ['GET', keyContent(ttmlId)],
    ['GET', keyMeta(ttmlId)],
  ])
  if (text == null) return null
  const meta = parseMeta(rawMeta)
  const data = {
    ttml: String(text),
    size: meta && meta.size != null ? toInt(meta.size) : null,
    uploadedAt: (meta && meta.uploadedAt) || null,
    url: null,
  }
  if (contentCache.size >= CONTENT_CACHE_MAX) {
    const oldest = contentCache.keys().next().value
    if (oldest) contentCache.delete(oldest)
  }
  contentCache.set(ttmlId, data)
  return data
}

/** 读老格式（KV 里的 ttml:legacy:<歌曲id>） */
async function readLegacy(songId) {
  const id = String(songId)
  const hit = legacyCache.get(id)
  if (hit && Date.now() - hit.at < LEGACY_TTL_MS) return hit.data
  const [text, rawMeta] = await kvPipeline([
    ['GET', keyLegacy(id)],
    ['GET', keyLegacyMeta(id)],
  ])
  if (text == null) {
    legacyCache.set(id, { at: Date.now(), data: null })
    return null
  }
  const meta = parseMeta(rawMeta)
  const data = {
    ttml: String(text),
    ttmlId: ttmlIdOf(text),
    url: null,
    size: meta && meta.size != null ? toInt(meta.size) : null,
    uploadedAt: (meta && meta.uploadedAt) || null,
    legacy: true,
  }
  legacyCache.set(id, { at: Date.now(), data })
  return data
}

/**
 * 保存：内容只写一份，再给每个歌曲 id 建绑定。
 *
 * **歌曲 id 为准**：一个 id 同一时间只能绑一份歌词。
 * 如果它已经绑在别的 TTML 上，这里直接判冲突、什么都不写 ——
 * 必须先显式解绑（/ttml/unbind，歌曲 id + ttmlId 配对）再绑新的。
 *
 * 返回 { ttmlId, url, bound, already, conflicts, blocked }
 */
async function save(ids, ttml) {
  const content = String(ttml == null ? '' : ttml)
  const ttmlId = ttmlIdOf(content)
  const wantIds = [...new Set(ids.map(String))]

  // 1) 体检：这些 id 现在绑在谁身上；顺手看看这份内容是第几次写（保留上传时间）
  const probe = await kvPipeline([
    ...wantIds.map((id) => ['GET', keySong(id)]),
    ['GET', keyMeta(ttmlId)],
  ])
  const current = probe.slice(0, wantIds.length)
  const existedMeta = parseMeta(probe[probe.length - 1])

  const already = []
  const conflicts = []
  wantIds.forEach((id, i) => {
    const cur = current[i]
    if (!cur) return
    if (cur === ttmlId) already.push(id)
    else conflicts.push({ id, boundTo: cur })
  })
  if (conflicts.length) {
    return { ttmlId, url: null, bound: [], already, conflicts, blocked: true }
  }

  const fresh = wantIds.filter((id) => !already.includes(id))
  const size = Buffer.byteLength(content, 'utf8')
  const uploadedAt =
    (existedMeta && existedMeta.uploadedAt) || new Date().toISOString()

  // 2) 一条 pipeline 写完：正文 + 元信息 + 目录 + 每个 id 的绑定
  const commands = [
    ['SET', keyContent(ttmlId), content],
    ['SET', keyMeta(ttmlId), metaJson(size, uploadedAt)],
    ['SADD', keyIds(), ttmlId],
  ]
  for (const id of wantIds) {
    commands.push(['SET', keySong(id), ttmlId])
    commands.push(['SADD', keyUsers(ttmlId), id])
  }
  await kvPipeline(commands)

  contentCache.delete(ttmlId)
  for (const id of wantIds) songCache.set(id, { at: Date.now(), ttmlId })

  return {
    ttmlId,
    url: null,
    bound: fresh,
    already,
    conflicts: [],
    blocked: false,
  }
}

/** 读取某个歌曲 id 的歌词；不存在返回 null */
async function load(songId) {
  const id = String(songId)
  const ttmlId = await songTtmlId(id)
  if (ttmlId) {
    const content = await readContent(ttmlId)
    if (content) {
      return { ...content, ttmlId, songId: id }
    }
    // 绑定指向的正文没了（历史遗留）：退回去看有没有老格式
  }
  const legacy = await readLegacy(id)
  if (legacy) return { ...legacy, songId: id }
  return null
}

/** 只查元信息（不下载正文） */
async function stat(songId) {
  const id = String(songId)
  const ttmlId = await songTtmlId(id)
  if (ttmlId) {
    const meta = parseMeta(await kv(['GET', keyMeta(ttmlId)]))
    if (meta) {
      return {
        url: downloadUrl(id),
        size: meta.size != null ? toInt(meta.size) : null,
        uploadedAt: meta.uploadedAt || null,
        ttmlId,
      }
    }
  }
  const legacy = await readLegacy(id)
  if (!legacy) return null
  return {
    url: downloadUrl(id),
    size: legacy.size,
    uploadedAt: legacy.uploadedAt,
    ttmlId: legacy.ttmlId,
  }
}

/** 这个歌曲 id 是否绑着这份歌词 */
async function isBound(songId, ttmlId) {
  if (!isValidId(songId) || !isValidTtmlId(ttmlId)) return false
  return (await songTtmlId(songId)) === ttmlId
}

/**
 * 解绑：把某个歌曲 id 从歌词上摘下来。
 * 如果摘完这份歌词已经没有任何 id 在用，就连正文一起删掉。
 */
async function unbind(songId, ttmlId) {
  const id = String(songId)
  if (!isValidId(id) || !isValidTtmlId(ttmlId)) {
    return {
      unbound: false,
      ttmlId,
      contentDeleted: false,
      error: '必须同时给出合法的歌曲 id 和歌词 ttmlId',
    }
  }

  // 这里必须读最新的：缓存里可能是 30 秒前的绑定关系
  const cur = await kv(['GET', keySong(id)])
  if (cur === ttmlId) {
    await kvPipeline([
      ['SREM', keyUsers(ttmlId), id],
      ['DEL', keySong(id)],
    ])
    songCache.set(id, { at: Date.now(), ttmlId: null })

    const remaining = toInt(await kv(['SCARD', keyUsers(ttmlId)])) || 0
    if (remaining > 0) {
      return { unbound: true, ttmlId, contentDeleted: false }
    }

    // 没人用了：正文一起回收
    await kvPipeline([
      ['DEL', keyContent(ttmlId)],
      ['DEL', keyMeta(ttmlId)],
      ['DEL', keyUsers(ttmlId)],
      ['SREM', keyIds(), ttmlId],
    ])
    contentCache.delete(ttmlId)
    return { unbound: true, ttmlId, contentDeleted: true }
  }

  // 新模型里没有：可能是老格式
  const legacy = await readLegacy(id)
  if (legacy && legacy.ttmlId === ttmlId) {
    legacyCache.delete(id)
    await kvPipeline([
      ['DEL', keyLegacy(id)],
      ['DEL', keyLegacyMeta(id)],
      ['SREM', keyLegacyIds(), id],
    ])
    return { unbound: true, ttmlId, contentDeleted: true, legacy: true }
  }

  return {
    unbound: false,
    ttmlId,
    contentDeleted: false,
    error: '这个歌曲 id 并没有绑在这份 TTML 上（ttmlId 对不上）',
  }
}

/** 如果没有别的歌曲 id 再绑这份正文，就把正文删掉 */
async function gcContent(ttmlId) {
  if (!isValidTtmlId(ttmlId)) return false
  const users = toInt(await kv(['SCARD', keyUsers(ttmlId)])) || 0
  if (users > 0) return false
  await kvPipeline([
    ['DEL', keyContent(ttmlId)],
    ['DEL', keyMeta(ttmlId)],
    ['DEL', keyUsers(ttmlId)],
    ['SREM', keyIds(), ttmlId],
  ])
  contentCache.delete(ttmlId)
  return true
}

/** 列某个歌曲 id 的绑定（新模型里最多一条，保留这个接口是为了兼容老调用方） */
async function listBindings(songId) {
  const id = String(songId)
  const ttmlId = await songTtmlId(id)
  if (!ttmlId) return []
  return [{ pathname: bindKey(id, ttmlId), url: null, ttmlId }]
}

/** 某个内容 id 还被哪些歌曲 id 绑着 */
async function bindingsOfTtml(ttmlId) {
  if (!isValidTtmlId(ttmlId)) return []
  const ids = await kv(['SMEMBERS', keyUsers(ttmlId)])
  return Array.isArray(ids) ? ids.map(String).sort() : []
}

/**
 * 列出所有内容与绑定（管理页用）。KV 是强一致的，读到的就是最新结果；
 * options.fresh 只为兼容老调用方保留。
 */
async function listAll(options) {
  void options
  const [ttmlIds, legacyIds] = await kvPipeline([
    ['SMEMBERS', keyIds()],
    ['SMEMBERS', keyLegacyIds()],
  ])
  const ids = Array.isArray(ttmlIds) ? ttmlIds.map(String) : []
  const legacySongIds = Array.isArray(legacyIds) ? legacyIds.map(String) : []

  const commands = []
  for (const ttmlId of ids) {
    commands.push(['GET', keyMeta(ttmlId)])
    commands.push(['SMEMBERS', keyUsers(ttmlId)])
  }
  for (const songId of legacySongIds)
    commands.push(['GET', keyLegacyMeta(songId)])
  const results = await kvPipeline(commands)

  const items = []
  let cursor = 0
  for (const ttmlId of ids) {
    const meta = parseMeta(results[cursor++])
    const users = results[cursor++] || []
    items.push({
      ttmlId,
      ids: Array.isArray(users) ? users.map(String).sort() : [],
      size: meta && meta.size != null ? toInt(meta.size) : null,
      uploadedAt: (meta && meta.uploadedAt) || null,
      url: null,
      orphan: !meta,
    })
  }
  items.sort((a, b) =>
    String(b.uploadedAt || '').localeCompare(String(a.uploadedAt || '')),
  )

  const legacy = legacySongIds
    .map((songId, i) => {
      const meta = parseMeta(results[cursor + i])
      return {
        songId,
        pathname: legacyKey(songId),
        url: null,
        size: meta && meta.size != null ? toInt(meta.size) : null,
        uploadedAt: (meta && meta.uploadedAt) || null,
      }
    })
    .sort((a, b) =>
      String(b.uploadedAt || '').localeCompare(String(a.uploadedAt || '')),
    )

  const updatedAt = items.reduce(
    (latest, it) =>
      it.uploadedAt && it.uploadedAt > latest ? it.uploadedAt : latest,
    '',
  )

  return {
    items,
    legacy,
    total: items.length,
    bindingCount: items.reduce((n, it) => n + it.ids.length, 0),
    contentCount: items.filter((it) => !it.orphan).length,
    updatedAt,
  }
}

/**
 * 真删除一份 TTML：
 *   1. 它绑的所有歌曲 id 自动解绑
 *   2. 正文一起删掉
 */
async function destroyTtml(ttmlId) {
  if (!isValidTtmlId(ttmlId)) {
    return { ttmlId, unbound: [], contentDeleted: false, error: 'ttmlId 非法' }
  }

  const users = await kv(['SMEMBERS', keyUsers(ttmlId)])
  const unbound = Array.isArray(users) ? users.map(String).sort() : []
  const existed = (toInt(await kv(['EXISTS', keyContent(ttmlId)])) || 0) > 0

  const commands = [
    ['DEL', keyContent(ttmlId)],
    ['DEL', keyMeta(ttmlId)],
    ['DEL', keyUsers(ttmlId)],
    ['SREM', keyIds(), ttmlId],
  ]
  for (const id of unbound) {
    commands.push(['DEL', keySong(id)])
    songCache.set(id, { at: Date.now(), ttmlId: null })
  }
  await kvPipeline(commands)
  contentCache.delete(ttmlId)

  return { ttmlId, unbound, contentDeleted: existed }
}

/** 真删除老格式的歌词 */
async function destroyLegacy(songId) {
  if (!isValidId(songId)) return { songId, deleted: false }
  const id = String(songId)
  legacyCache.delete(id)
  const [existed] = await kvPipeline([
    ['EXISTS', keyLegacy(id)],
    ['DEL', keyLegacy(id)],
    ['DEL', keyLegacyMeta(id)],
    ['SREM', keyLegacyIds(), id],
  ])
  return { songId: id, deleted: (toInt(existed) || 0) > 0 }
}

/**
 * 对外展示的下载地址：走本站域名，不把存储侧的信息暴露出去。
 * 域名可用 PUBLIC_BASE_URL 覆盖，默认就是站点本身。
 */
function downloadUrl(id) {
  const base = String(
    process.env.PUBLIC_BASE_URL || 'https://sanwith.de5.net',
  ).replace(/\/+$/, '')
  return `${base}/ttml/file?id=${encodeURIComponent(String(id))}`
}

// ---------------------------------------------------------------------------
// 一次性迁移：把 Blob 时代的歌词搬进 KV
// ---------------------------------------------------------------------------

/**
 * 从 Vercel Blob 搬数据（需要 BLOB_READ_WRITE_TOKEN，且 store 没被停用）。
 *
 * 幂等：重复跑只是把同样的内容再 SET 一遍。
 * 只搬 ttml/ 下面三种路径：c/<ttmlId>.ttml、b/<歌曲id>--<ttmlId>.json、<歌曲id>.ttml。
 */
async function migrateFromBlob(options) {
  const opts = options || {}
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    throw new Error('未配置 BLOB_READ_WRITE_TOKEN，无法读取老的 Blob 数据')
  }
  const { list, get } = require('@vercel/blob')
  const contents = new Map() // ttmlId -> { size, uploadedAt }
  const binds = []
  const legacy = new Map() // songId -> { size, uploadedAt }

  let cursor
  do {
    const page = await list({ prefix: PREFIX, cursor, limit: 500 })
    for (const blob of page.blobs || []) {
      const pathname = String(blob.pathname || '')
      let m
      if ((m = CONTENT_RE.exec(pathname))) {
        contents.set(m[1], {
          size: blob.size || null,
          uploadedAt: blob.uploadedAt || null,
        })
      } else if ((m = BIND_RE.exec(pathname))) {
        binds.push({ songId: m[1], ttmlId: m[2] })
      } else if ((m = LEGACY_RE.exec(pathname))) {
        legacy.set(m[1], {
          size: blob.size || null,
          uploadedAt: blob.uploadedAt || null,
        })
      }
    }
    cursor = page.hasMore ? page.cursor : undefined
  } while (cursor)

  // 正文要真的读下来：get 绕过 CDN 缓存拿 origin 上的原文
  const readText = async (pathname) => {
    const res = await get(pathname, { access: 'public', useCache: false })
    if (!res || !res.stream) return null
    return new Response(res.stream).text()
  }

  let contentCount = 0
  for (const [ttmlId, meta] of contents) {
    const text = await readText(contentKey(ttmlId))
    if (text == null) continue
    await kvPipeline([
      ['SET', keyContent(ttmlId), text],
      [
        'SET',
        keyMeta(ttmlId),
        metaJson(Buffer.byteLength(text, 'utf8'), meta.uploadedAt),
      ],
      ['SADD', keyIds(), ttmlId],
    ])
    contentCount += 1
    if (opts.verbose) console.log('内容已迁移', ttmlId)
  }

  for (const { songId, ttmlId } of binds) {
    await kvPipeline([
      ['SET', keySong(songId), ttmlId],
      ['SADD', keyUsers(ttmlId), songId],
    ])
  }

  let legacyCount = 0
  for (const [songId, meta] of legacy) {
    const text = await readText(legacyKey(songId))
    if (text == null) continue
    await kvPipeline([
      ['SET', keyLegacy(songId), text],
      [
        'SET',
        keyLegacyMeta(songId),
        metaJson(Buffer.byteLength(text, 'utf8'), meta.uploadedAt),
      ],
      ['SADD', keyLegacyIds(), songId],
    ])
    legacyCount += 1
  }

  clearCaches()
  return { contents: contentCount, bindings: binds.length, legacy: legacyCount }
}

module.exports = {
  PREFIX,
  CONTENT_PREFIX,
  BIND_PREFIX,
  isValidId,
  isValidTtmlId,
  ttmlIdOf,
  contentKey,
  bindKey,
  legacyKey,
  hasToken,
  save,
  load,
  stat,
  unbind,
  isBound,
  gcContent,
  listBindings,
  bindingsOfTtml,
  listAll,
  destroyTtml,
  destroyLegacy,
  downloadUrl,
  clearCaches,
  migrateFromBlob,
}
