// TTML 歌词存储（Vercel Blob）
//
// 数据结构（2026-11 改版）
//   ttml/index.json                 目录：哪份歌词绑了哪些歌曲 id —— 所有查找的唯一入口
//   ttml/c/<ttmlId>.ttml            歌词正文，按内容哈希命名，同样内容只存一份
//   ttml/b/<歌曲id>--<ttmlId>.json  绑定的「纸面存档」，只为索引万一丢了能重建，读的时候不看
//   ttml/<歌曲id>.ttml              早期格式，仍然能读、能删
//
// 为什么要这份索引：
//   Vercel Blob 把 list / copy 算成 Advanced Operations —— Hobby 计划每月只有 2K 次。
//   上一版每次读歌词都 list 一次，管理页刷新还要再 head 几十次，
//   额度几天就烧穿，store 会被 Vercel 直接封掉（403 Your store is blocked）。
//   现在查找全走索引：
//     读 = 一次 get（Simple Operation，共 10K/月，并且有内存缓存）
//     写 = put 内容 + put 存档 + put 索引
//   只有索引不存在时才会 list 一次（1 次 Advanced Operation）把它建起来。
//
// 索引的一致性：
//   - 读：进程内缓存 5 分钟；写操作会把本进程的缓存立刻更新。
//   - 写：read-modify-write，用 Blob 的 ETag 做乐观锁（ifMatch），
//         并发写撞车时自动重读重试，不会把别人的绑定覆盖掉。
//   - 索引丢了：ttml/b/ 下的存档还在，下次读的时候会自动 list 一次重建。
//
// 对外仍然是一切按歌曲 id 访问（/search?ttml=<歌曲id>），
// 响应里的 ttmlId 是内容自己的身份（内容哈希），换 id 绑也不变。
const crypto = require('crypto')

const PREFIX = 'ttml/'
const CONTENT_PREFIX = PREFIX + 'c/'
const BIND_PREFIX = PREFIX + 'b/'
const LEGACY_SUFFIX = '.ttml'
const INDEX_KEY = PREFIX + 'index.json'
const INDEX_VERSION = 1

/** 索引在进程内缓存多久。读一次只要 1 次 Simple Operation，但没必要每个请求都读 */
const INDEX_TTL_MS = 5 * 60 * 1000
/** 正文缓存上限（按份数算，一般只有几十份，留够余量） */
const CONTENT_CACHE_MAX = 300

const CONTENT_RE = /^ttml\/c\/([0-9a-f]{16})\.ttml$/
const BIND_RE = /^ttml\/b\/(\d+)--([0-9a-f]{16})\.json$/
const LEGACY_RE = /^ttml\/(\d+)\.ttml$/

let indexCache = null // { at, etag, data }
const contentCache = new Map() // ttmlId -> { ttml, size, uploadedAt, url }
const legacyCache = new Map() // songId -> { ttml, ttmlId, url, size, uploadedAt }

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

function hasToken() {
  return !!process.env.BLOB_READ_WRITE_TOKEN
}

/** 把 Blob 的返回（web stream / node stream）读成字符串 */
async function streamToText(stream) {
  if (!stream) return ''
  if (typeof stream.getReader === 'function') {
    return new Response(stream).text()
  }
  const chunks = []
  for await (const chunk of stream) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks).toString('utf8')
}

/** Blob 的错误类型都是从 BlobError 派生的，这里按 name 判断，避免 require 曲线救国 */
function isBlobErrorNamed(e, name) {
  return !!e && (e.name === name || e.constructor?.name === name)
}

function isNotFound(e) {
  return (
    isBlobErrorNamed(e, 'BlobNotFoundError') ||
    /not.?found|does not exist/i.test(String((e && e.message) || ''))
  )
}

function isPreconditionFailed(e) {
  return (
    isBlobErrorNamed(e, 'BlobPreconditionFailedError') ||
    /precondition/i.test(String((e && e.message) || ''))
  )
}

/** 索引里一条内容的形状 */
function makeEntry(ttmlId) {
  return {
    ids: [],
    size: null,
    uploadedAt: null,
    url: null,
    pathname: contentKey(ttmlId),
  }
}

/**
 * 把任意来源的索引整理成统一形状。
 * 坏数据（少字段、id 不合法、重复）全部就地修掉，调用方拿到的永远能直接用。
 */
function normalizeIndex(raw) {
  const doc = {
    v: INDEX_VERSION,
    updatedAt: String((raw && raw.updatedAt) || ''),
    contents: {},
    legacy: {},
  }

  const contents =
    raw && raw.contents && typeof raw.contents === 'object' ? raw.contents : {}
  for (const [key, value] of Object.entries(contents)) {
    if (!isValidTtmlId(key) || !value || typeof value !== 'object') continue
    const ids = Array.isArray(value.ids)
      ? [...new Set(value.ids.map(String).filter(isValidId))]
      : []
    doc.contents[key] = {
      ids,
      size: Number.isFinite(value.size) ? value.size : null,
      uploadedAt: value.uploadedAt || null,
      url: value.url || null,
      pathname: value.pathname || contentKey(key),
    }
  }

  const legacy =
    raw && raw.legacy && typeof raw.legacy === 'object' ? raw.legacy : {}
  for (const [key, value] of Object.entries(legacy)) {
    if (!isValidId(key) || !value || typeof value !== 'object') continue
    doc.legacy[key] = {
      songId: String(key),
      pathname: value.pathname || legacyKey(key),
      url: value.url || null,
      size: Number.isFinite(value.size) ? value.size : null,
      uploadedAt: value.uploadedAt || null,
    }
  }

  return doc
}

function cloneIndex(doc) {
  return {
    v: doc.v,
    updatedAt: doc.updatedAt,
    contents: JSON.parse(JSON.stringify(doc.contents || {})),
    legacy: JSON.parse(JSON.stringify(doc.legacy || {})),
  }
}

/** 这个歌曲 id 现在绑在哪个 ttmlId 上（没有就 null） */
function ttmlIdOfSong(doc, songId) {
  const id = String(songId == null ? '' : songId)
  for (const [ttmlId, entry] of Object.entries(doc.contents)) {
    if (entry.ids.includes(id)) return ttmlId
  }
  return null
}

/** 清空进程内缓存（测试与排障用） */
function clearCaches() {
  indexCache = null
  contentCache.clear()
  legacyCache.clear()
}

/** 从 Blob 读索引本体；不存在返回 null（404 不当错误） */
async function fetchIndexRemote() {
  const { get } = require('@vercel/blob')
  let res
  try {
    res = await get(INDEX_KEY, { access: 'public', useCache: false })
  } catch (e) {
    if (isNotFound(e)) return null
    throw e
  }
  if (!res || !res.stream) {
    // 304：内容没变，直接沿用缓存（正常不会走到，防御一下）
    return res && res.statusCode === 304 && indexCache
      ? { data: indexCache.data, etag: indexCache.etag }
      : null
  }
  const text = await streamToText(res.stream)
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    // 坏掉的索引不能当成「空索引」用 —— 那会在下一次写入时把真实数据抹掉。
    // 交给上层按「索引不存在」处理：从 ttml/b/ 存档重建一份。
    return { data: null, etag: (res.blob && res.blob.etag) || null }
  }
  if (!parsed || typeof parsed !== 'object') {
    return { data: null, etag: (res.blob && res.blob.etag) || null }
  }
  return {
    data: normalizeIndex(parsed),
    etag: (res.blob && res.blob.etag) || null,
  }
}

/**
 * 从 store 里扫一遍把索引建起来。
 * 这是整个模块唯一会用到 list（Advanced Operation）的地方，只在索引不存在时跑。
 */
async function buildIndexFromStore() {
  const { list } = require('@vercel/blob')
  const doc = normalizeIndex(null)
  let cursor
  do {
    const page = await list({ prefix: PREFIX, cursor, limit: 500 })
    for (const blob of page.blobs || []) {
      const pathname = String(blob.pathname || '')
      let m
      if ((m = CONTENT_RE.exec(pathname))) {
        doc.contents[m[1]] = {
          ids: doc.contents[m[1]] ? doc.contents[m[1]].ids : [],
          size: blob.size || null,
          uploadedAt: blob.uploadedAt || null,
          url: blob.url || null,
          pathname,
        }
      } else if ((m = BIND_RE.exec(pathname))) {
        const entry = doc.contents[m[2]] || makeEntry(m[2])
        if (!entry.ids.includes(m[1])) entry.ids.push(m[1])
        doc.contents[m[2]] = entry
      } else if ((m = LEGACY_RE.exec(pathname))) {
        doc.legacy[m[1]] = {
          songId: m[1],
          pathname,
          url: blob.url || null,
          size: blob.size || null,
          uploadedAt: blob.uploadedAt || null,
        }
      }
    }
    cursor = page.hasMore ? page.cursor : undefined
  } while (cursor)
  return doc
}

/** 写索引。etag 有值就用条件写（乐观锁），撞车会抛 BlobPreconditionFailedError */
async function writeIndex(doc, etag) {
  const { put } = require('@vercel/blob')
  const next = { ...doc, v: INDEX_VERSION, updatedAt: new Date().toISOString() }
  const body = JSON.stringify(next)
  const options = {
    access: 'public',
    contentType: 'application/json; charset=utf-8',
    addRandomSuffix: false,
    allowOverwrite: true,
    // 索引会被频繁覆盖，别让 CDN 缓存太久；读取本来也是绕过缓存读的
    cacheControlMaxAge: 60,
  }
  if (etag) options.ifMatch = etag
  const res = await put(INDEX_KEY, body, options)
  // 存一份克隆：调用方拿到的 draft 之后不会再被改，但缓存和它共用对象迟早出岔子
  indexCache = {
    at: Date.now(),
    etag: res.etag || null,
    data: cloneIndex(next),
  }
  return next
}

/** 读索引（带进程内缓存）。fresh=true 时强制重读 */
async function readIndex(options) {
  const fresh = !!(options && options.fresh)
  if (!fresh && indexCache && Date.now() - indexCache.at < INDEX_TTL_MS) {
    return indexCache
  }

  const remote = await fetchIndexRemote()
  if (remote && remote.data) {
    indexCache = { at: Date.now(), etag: remote.etag, data: remote.data }
    return indexCache
  }

  // 索引不存在（第一次部署 / 被手动删了）：扫一遍重建
  const built = await buildIndexFromStore()
  await writeIndex(built, null)
  return indexCache
}

/**
 * 对索引做一次「读 → 改 → 写」，撞车就重试。
 * mutator 返回 { abort: ... } 表示这次不该写（比如发现冲突）。
 */
async function mutateIndex(mutator) {
  let lastError = null
  for (let attempt = 0; attempt < 5; attempt++) {
    const current = await readIndex({ fresh: attempt > 0 })
    const draft = cloneIndex(current.data)
    const outcome = await mutator(draft)
    if (outcome && outcome.abort) {
      return { ok: false, abort: outcome.abort }
    }
    try {
      const saved = await writeIndex(draft, current.etag)
      return { ok: true, index: saved, outcome }
    } catch (e) {
      if (!isPreconditionFailed(e)) throw e
      // 别的实例刚改过索引：等一小下再重读重试
      lastError = e
      await new Promise((r) => setTimeout(r, 40 + attempt * 60))
    }
  }
  throw lastError || new Error('索引更新冲突，请重试')
}

/** 带缓存的正文读取：先走 CDN 地址，读不到再回源（都只要 0～1 次 Simple Operation） */
async function readContent(ttmlId, entry) {
  const cached = contentCache.get(ttmlId)
  if (cached) return cached

  let text = null
  let url = (entry && entry.url) || null
  if (url) {
    try {
      const res = await fetch(url)
      if (res.ok) text = await res.text()
    } catch {
      /* 地址失效就回源 */
    }
  }
  if (text == null) {
    const { get } = require('@vercel/blob')
    let res = null
    try {
      res = await get(contentKey(ttmlId), { access: 'public', useCache: false })
    } catch (e) {
      if (!isNotFound(e)) throw e
    }
    if (!res || !res.stream) return null
    text = await streamToText(res.stream)
    if (res.blob && res.blob.url) url = res.blob.url
  }

  const data = {
    ttml: text,
    size: Buffer.byteLength(text, 'utf8'),
    uploadedAt: (entry && entry.uploadedAt) || null,
    url: url || null,
  }
  if (contentCache.size >= CONTENT_CACHE_MAX) {
    const oldest = contentCache.keys().next().value
    if (oldest) contentCache.delete(oldest)
  }
  contentCache.set(ttmlId, data)
  return data
}

/** 读老格式（ttml/<歌曲id>.ttml）。索引里没这条记录就直接当没有，不再 head 探一次 */
async function readLegacy(songId, entry) {
  const id = String(songId)
  const cached = legacyCache.get(id)
  if (cached) return cached

  // 索引建立时扫过整个 ttml/ 前缀，有老格式文件就一定在 legacy 里。
  // 所以「索引没记录」= 没有，不必为每个「查不到歌词」的请求再付一次 head。
  if (!entry) return null

  let url = entry.url || null
  if (!url) {
    const { head } = require('@vercel/blob')
    try {
      const meta = await head(legacyKey(id))
      if (!meta || !meta.url) return null
      url = meta.url
    } catch {
      return null
    }
  }

  let text = null
  try {
    const res = await fetch(url)
    if (res.ok) text = await res.text()
  } catch {
    /* fallthrough */
  }
  if (text == null) {
    const { get } = require('@vercel/blob')
    try {
      const res = await get(legacyKey(id), {
        access: 'public',
        useCache: false,
      })
      if (!res || !res.stream) return null
      text = await streamToText(res.stream)
    } catch {
      return null
    }
  }

  const data = {
    ttml: text,
    ttmlId: ttmlIdOf(text),
    url,
    size: Buffer.byteLength(text, 'utf8'),
    uploadedAt: (entry && entry.uploadedAt) || null,
    legacy: true,
  }
  legacyCache.set(id, data)
  return data
}

/** 在索引里找某个歌曲 id 绑的内容 */
function contentOfSong(doc, songId) {
  const id = String(songId)
  for (const [ttmlId, entry] of Object.entries(doc.contents)) {
    if (entry.ids.includes(id)) return { ttmlId, entry }
  }
  return null
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

  // 1) 体检：已经绑在这份上的算 already，绑在别人身上的直接拒
  const snapshot = await readIndex()
  const already = []
  const conflicts = []
  for (const id of wantIds) {
    const current = ttmlIdOfSong(snapshot.data, id)
    if (!current) continue
    if (current === ttmlId) already.push(id)
    else conflicts.push({ id, boundTo: current })
  }
  if (conflicts.length) {
    return { ttmlId, url: null, bound: [], already, conflicts, blocked: true }
  }

  const fresh = wantIds.filter((id) => !already.includes(id))
  const { put } = require('@vercel/blob')

  // 2) 正文：按内容 id 命名，同内容重复写天然幂等
  const stored = await put(contentKey(ttmlId), content, {
    access: 'public',
    contentType: 'application/ttml+xml; charset=utf-8',
    allowOverwrite: true,
    addRandomSuffix: false,
  })

  // 3) 索引：并发写会被 ifMatch 挡住并重试，冲突在 mutator 里再查一遍
  const written = await mutateIndex((draft) => {
    const bad = []
    for (const id of wantIds) {
      const current = ttmlIdOfSong(draft, id)
      if (current && current !== ttmlId) bad.push({ id, boundTo: current })
    }
    if (bad.length) return { abort: { conflicts: bad } }

    const entry = draft.contents[ttmlId] || makeEntry(ttmlId)
    entry.ids = [...new Set([...(entry.ids || []), ...wantIds])]
    entry.size = Buffer.byteLength(content, 'utf8')
    entry.uploadedAt = entry.uploadedAt || new Date().toISOString()
    entry.url = stored.url || entry.url || null
    entry.pathname = contentKey(ttmlId)
    draft.contents[ttmlId] = entry
    return null
  })

  if (!written.ok) {
    return {
      ttmlId,
      url: null,
      bound: [],
      already,
      conflicts: (written.abort && written.abort.conflicts) || [],
      blocked: true,
    }
  }

  // 4) 纸面存档：绑定文件。索引已经写成功了才写它 ——
  //    它只是「索引丢了还能重建」的保险，写失败不该让提交失败。
  try {
    for (const id of fresh) {
      await put(bindKey(id, ttmlId), JSON.stringify({ songId: id, ttmlId }), {
        access: 'public',
        contentType: 'application/json',
        allowOverwrite: true,
        addRandomSuffix: false,
      })
    }
  } catch {
    /* 存档失败不影响这次提交，下次重建索引时会少这一条，内容仍在 */
  }

  contentCache.set(ttmlId, {
    ttml: content,
    size: Buffer.byteLength(content, 'utf8'),
    uploadedAt: written.index.contents[ttmlId]
      ? written.index.contents[ttmlId].uploadedAt
      : null,
    url: stored.url,
  })

  return {
    ttmlId,
    url: stored.url,
    bound: fresh,
    already,
    conflicts: [],
    blocked: false,
  }
}

/** 读取某个歌曲 id 的歌词；不存在返回 null */
async function load(songId) {
  const index = await readIndex()
  const hit = contentOfSong(index.data, String(songId))
  if (hit) {
    const content = await readContent(hit.ttmlId, hit.entry)
    if (content) {
      return { ...content, ttmlId: hit.ttmlId, songId: String(songId) }
    }
  }
  // 绑定指向的内容没了，退回去看有没有老数据
  const legacy = await readLegacy(songId, index.data.legacy[String(songId)])
  if (legacy) return { ...legacy, songId: String(songId) }
  return null
}

/** 只查元信息（不下载内容），做下载跳转时用 */
async function stat(songId) {
  const index = await readIndex()
  const hit = contentOfSong(index.data, String(songId))
  if (hit) {
    if (hit.entry.url) {
      return {
        url: hit.entry.url,
        size: hit.entry.size,
        uploadedAt: hit.entry.uploadedAt,
        ttmlId: hit.ttmlId,
      }
    }
    // 索引里没有地址（从存档重建的）：补一次 head，只有 1 次 Simple Operation
    const { head } = require('@vercel/blob')
    try {
      const meta = await head(contentKey(hit.ttmlId))
      if (meta && meta.url) {
        return {
          url: meta.url,
          size: meta.size,
          uploadedAt: meta.uploadedAt,
          ttmlId: hit.ttmlId,
        }
      }
    } catch {
      /* 继续看老数据 */
    }
  }
  const legacy = await readLegacy(songId, index.data.legacy[String(songId)])
  if (!legacy) return null
  return {
    url: legacy.url,
    size: legacy.size,
    uploadedAt: legacy.uploadedAt,
    ttmlId: legacy.ttmlId,
  }
}

/** 这个歌曲 id 是否绑着这份歌词 */
async function isBound(songId, ttmlId) {
  if (!isValidId(songId) || !isValidTtmlId(ttmlId)) return false
  const index = await readIndex()
  return ttmlIdOfSong(index.data, songId) === ttmlId
}

/**
 * 解绑：把某个歌曲 id 从歌词上摘下来。
 * 如果摘完这份歌词已经没有任何 id 在用，就连内容一起删掉。
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

  let removedLast = false
  const written = await mutateIndex((draft) => {
    const entry = draft.contents[ttmlId]
    if (!entry || !entry.ids.includes(id))
      return { abort: { reason: 'missing' } }
    entry.ids = entry.ids.filter((x) => x !== id)
    if (entry.ids.length) {
      draft.contents[ttmlId] = entry
      return null
    }
    delete draft.contents[ttmlId]
    removedLast = true
    return null
  })

  if (!written.ok) {
    // 新模型里没有这条绑定：可能是老格式（ttml/<歌曲id>.ttml）
    const snapshot = await readIndex()
    const legacy = await readLegacy(id, snapshot.data.legacy[id])
    if (legacy && legacy.ttmlId === ttmlId) {
      try {
        const { del } = require('@vercel/blob')
        await del(legacyKey(id))
        await mutateIndex((draft) => {
          delete draft.legacy[id]
          return null
        })
        legacyCache.delete(id)
        return { unbound: true, ttmlId, contentDeleted: true, legacy: true }
      } catch (e) {
        return {
          unbound: false,
          ttmlId,
          contentDeleted: false,
          error: '解绑失败：' + (e.message || e),
        }
      }
    }
    return {
      unbound: false,
      ttmlId,
      contentDeleted: false,
      error: '这个歌曲 id 并没有绑在这份 TTML 上（ttmlId 对不上）',
    }
  }

  // 索引已经先让步了，再删文件：删失败只会留个孤儿，不影响读
  const { del } = require('@vercel/blob')
  const doomed = [bindKey(id, ttmlId)]
  if (removedLast) doomed.push(contentKey(ttmlId))
  try {
    await del(doomed)
  } catch {
    /* 删不掉就留着，下次 GC 会处理 */
  }
  if (removedLast) contentCache.delete(ttmlId)

  return { unbound: true, ttmlId, contentDeleted: removedLast }
}

/**
 * 如果没有别的歌曲 id 再绑这份内容，就把内容删掉。
 * 索引就是权威记录，不再需要「等几秒再 list 一次」那种最终一致的兜底。
 */
async function gcContent(ttmlId) {
  if (!isValidTtmlId(ttmlId)) return false
  let removed = false
  await mutateIndex((draft) => {
    const entry = draft.contents[ttmlId]
    if (entry && entry.ids.length) return { abort: { reason: 'in-use' } }
    if (entry) delete draft.contents[ttmlId]
    removed = true
    return null
  })
  if (!removed) return false
  try {
    const { del } = require('@vercel/blob')
    await del(contentKey(ttmlId))
  } catch {
    return false
  }
  contentCache.delete(ttmlId)
  return true
}

/** 列某个歌曲 id 的绑定（新模型里最多一条，保留这个接口是为了兼容老调用方） */
async function listBindings(songId) {
  const id = String(songId)
  const index = await readIndex()
  const hit = contentOfSong(index.data, id)
  if (!hit) return []
  return [
    {
      pathname: bindKey(id, hit.ttmlId),
      url: hit.entry.url || null,
      ttmlId: hit.ttmlId,
    },
  ]
}

/** 某个内容 id 还被哪些歌曲 id 绑着 */
async function bindingsOfTtml(ttmlId) {
  const index = await readIndex()
  const entry = index.data.contents[String(ttmlId)]
  return entry ? entry.ids.slice() : []
}

/**
 * 列出所有内容与绑定（管理页用）。
 * 现在这份数据直接来自索引，不再 list、也不再逐条 head —— 刷新一次 0～1 次操作。
 * fresh=true 时绕过 5 分钟缓存，页面点刷新就能看到最新结果。
 */
async function listAll(options) {
  const index = await readIndex({ fresh: !!(options && options.fresh) })
  const doc = index.data

  const items = Object.entries(doc.contents).map(([ttmlId, entry]) => ({
    ttmlId,
    ids: entry.ids.slice().sort(),
    size: entry.size,
    uploadedAt: entry.uploadedAt,
    url: entry.url,
    // 内容地址都不知道（常见于「绑定还在、内容没了」的历史遗留）
    orphan: !entry.url,
  }))
  items.sort((a, b) =>
    String(b.uploadedAt || '').localeCompare(String(a.uploadedAt || '')),
  )

  const legacy = Object.values(doc.legacy)
    .map((l) => ({ ...l }))
    .sort((a, b) =>
      String(b.uploadedAt || '').localeCompare(String(a.uploadedAt || '')),
    )

  return {
    items,
    legacy,
    total: items.length,
    bindingCount: items.reduce((n, it) => n + it.ids.length, 0),
    contentCount: items.filter((it) => !it.orphan).length,
    updatedAt: doc.updatedAt,
  }
}

/**
 * 真删除一份 TTML：
 *   1. 删掉所有指向它的绑定（歌曲 id 自动解绑）
 *   2. 删掉内容本体（Blob 上不留）
 * 全程按路径删，索引里就有全部路径，不需要 list。
 */
async function destroyTtml(ttmlId) {
  if (!isValidTtmlId(ttmlId)) {
    return { ttmlId, unbound: [], contentDeleted: false, error: 'ttmlId 非法' }
  }

  const snapshot = await readIndex()
  const known = snapshot.data.contents[ttmlId] || null
  const ids = known ? known.ids.slice() : []
  if (known) {
    await mutateIndex((draft) => {
      delete draft.contents[ttmlId]
      return null
    })
  }

  const paths = [contentKey(ttmlId), ...ids.map((id) => bindKey(id, ttmlId))]
  let deleted = false
  let existed = false
  try {
    const { head, del } = require('@vercel/blob')
    try {
      await head(contentKey(ttmlId))
      existed = true
    } catch {
      existed = false
    }
    await del(paths)
    deleted = existed
  } catch {
    deleted = false
  }

  contentCache.delete(ttmlId)
  return { ttmlId, unbound: ids, contentDeleted: deleted }
}

/** 真删除老格式 ttml/<歌曲id>.ttml */
async function destroyLegacy(songId) {
  if (!isValidId(songId)) return { songId, deleted: false }
  const id = String(songId)
  const index = await readIndex()
  const known = index.data.legacy[id] || null

  let deleted = false
  try {
    const { head, del } = require('@vercel/blob')
    const target = known && known.url ? known.url : legacyKey(id)
    try {
      await head(target)
      deleted = true
    } catch {
      deleted = false
    }
    if (deleted) await del(target)
  } catch {
    deleted = false
  }

  if (known) {
    await mutateIndex((draft) => {
      delete draft.legacy[id]
      return null
    })
  }
  legacyCache.delete(id)
  return { songId: id, deleted }
}

/**
 * 对外展示的下载地址：走本站域名，不把 Blob 的随机子域暴露出去。
 * 域名可用 PUBLIC_BASE_URL 覆盖，默认就是站点本身。
 */
function downloadUrl(id) {
  const base = String(
    process.env.PUBLIC_BASE_URL || 'https://sanwith.de5.net',
  ).replace(/\/+$/, '')
  return `${base}/ttml/file?id=${encodeURIComponent(String(id))}`
}

module.exports = {
  PREFIX,
  CONTENT_PREFIX,
  BIND_PREFIX,
  INDEX_KEY,
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
}
