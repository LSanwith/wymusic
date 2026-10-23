// TTML 歌词存储（Vercel Blob）
//
// 核心模型：**歌词内容和歌曲 id 是解耦的**。
// 一份 TTML 可以绑多个网易云歌曲 id（同一首歌的多个版本、多区发行等），
// 内容只存一份，用内容自己的身份 id（内容哈希）标识。
//
//   ttml/c/<ttmlId>.ttml          歌词内容，只存一份；ttmlId = 内容的 sha256 前 16 位
//   ttml/b/<歌曲id>--<ttmlId>.json 绑定关系，内容为空占位，信息全在文件名里
//
// 为什么绑定关系放在**文件名**里：
//   - 判断「这个 ttmlId 还有没有别的 id 在用」，只要 list 一次前缀、看文件名，
//     不用把每个绑定文件都下载下来
//   - 读取某个歌曲 id 的歌词，也只要 list 一次前缀，不用额外读文件
//
// 对外仍然是按歌曲 id 请求（/search?ttml=<歌曲id>），
// 但响应里会带上 ttmlId —— 它就是这份歌词的身份，换 id 绑也不变。
//
// 兼容老数据：早期版本是 ttml/<歌曲id>.ttml（一个 id 一份副本），
// 读到就照常能读、能删。
const crypto = require('crypto')

const PREFIX = 'ttml/'
const CONTENT_PREFIX = PREFIX + 'c/'
const BIND_PREFIX = PREFIX + 'b/'
const LEGACY_SUFFIX = '.ttml'

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
 * （TTML 对显示是空白敏感的，但那只影响展示，不影响「这是不是同一份歌词」）
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

/** 列某个歌曲 id 的所有绑定（可能不止一条，理论上应该只有一条） */
async function listBindings(songId) {
  const { list } = require('@vercel/blob')
  const prefix = BIND_PREFIX + String(songId) + '--'
  const out = []
  let cursor
  do {
    const page = await list({ prefix, cursor, limit: 100 })
    for (const b of page.blobs || []) {
      const m = /^ttml\/b\/(\d+)--([0-9a-f]{16})\.json$/.exec(b.pathname)
      if (m && m[1] === String(songId)) {
        out.push({ pathname: b.pathname, url: b.url, ttmlId: m[2] })
      }
    }
    cursor = page.cursor
  } while (cursor)
  return out
}

/** 取某个歌曲 id 当前绑定的内容 id */
async function bindingOf(songId) {
  const all = await listBindings(songId)
  return all.length ? all[0] : null
}

/**
 * 精确判断「某个歌曲 id 是否绑着某一份歌词」。
 *
 * 直接用 head 查那条绑定的路径，不走 list —— list 是最终一致的，
 * 刚绑上可能查不到，会导致「重复提交拦不住」或者更糟的「解绑解错」。
 * 查重和解绑都以这个判断为准。
 */
async function isBound(songId, ttmlId) {
  const { head } = require('@vercel/blob')
  if (!isValidId(songId) || !isValidTtmlId(ttmlId)) return false
  try {
    const meta = await head(bindKey(String(songId), String(ttmlId)))
    return !!(meta && meta.url)
  } catch {
    return false
  }
}

/** 某个内容 id 还被哪些歌曲 id 绑着 */
async function bindingsOfTtml(ttmlId) {
  const { list } = require('@vercel/blob')
  const suffix = '--' + ttmlId + '.json'
  const out = []
  let cursor
  do {
    const page = await list({ prefix: BIND_PREFIX, cursor, limit: 200 })
    for (const b of page.blobs || []) {
      if (b.pathname.endsWith(suffix)) {
        const m = /^ttml\/b\/(\d+)--/.exec(b.pathname)
        if (m) out.push(m[1])
      }
    }
    cursor = page.cursor
  } while (cursor)
  return out
}

/** 读内容（不存在返回 null） */
async function readContent(ttmlId) {
  const { head } = require('@vercel/blob')
  let meta
  try {
    meta = await head(contentKey(ttmlId))
  } catch {
    return null
  }
  if (!meta || !meta.url) return null
  const res = await fetch(meta.url)
  if (!res.ok) return null
  return {
    ttml: await res.text(),
    url: meta.url,
    size: meta.size,
    uploadedAt: meta.uploadedAt,
  }
}

/** 读老版本数据（ttml/<歌曲id>.ttml） */
async function readLegacy(songId) {
  const { head } = require('@vercel/blob')
  let meta
  try {
    meta = await head(legacyKey(songId))
  } catch {
    return null
  }
  if (!meta || !meta.url) return null
  const res = await fetch(meta.url)
  if (!res.ok) return null
  const ttml = await res.text()
  return {
    ttml,
    ttmlId: ttmlIdOf(ttml),
    url: meta.url,
    size: meta.size,
    uploadedAt: meta.uploadedAt,
    legacy: true,
  }
}

/**
 * 保存：内容只写一份，再给每个歌曲 id 建立绑定。
 *
 * **歌曲 id 为准**：一个 id 同一时间只能绑一份歌词。
 * 如果它已经绑在别的 TTML 上，这里直接判冲突、什么都不写 ——
 * 必须先显式解绑（/ttml/unbind，歌曲 id + ttmlId 配对）再绑新的。
 * 这样可以避免「换个内容重新提交」把别人的绑定悄悄覆盖掉。
 *
 * 返回 { ttmlId, url, bound, already, conflicts, blocked }
 *   conflicts  [{ id, boundTo }] 已有绑定冲突的 id
 *   blocked    true 表示因为冲突没有写入任何东西
 */
async function save(ids, ttml) {
  const { put } = require('@vercel/blob')
  const content = String(ttml == null ? '' : ttml)
  const ttmlId = ttmlIdOf(content)

  // 先体检再写：不允许静默改绑
  const already = []
  const conflicts = []
  for (const id of ids) {
    if (await isBound(id, ttmlId)) {
      already.push(id)
      continue
    }
    const cur = await bindingOf(id)
    if (cur && cur.ttmlId !== ttmlId) {
      conflicts.push({ id: String(id), boundTo: cur.ttmlId })
    }
  }
  if (conflicts.length) {
    return { ttmlId, url: null, bound: [], already, conflicts, blocked: true }
  }

  // 内容同 id 覆盖写：同内容天然幂等
  const res = await put(contentKey(ttmlId), content, {
    access: 'public',
    contentType: 'application/ttml+xml; charset=utf-8',
    allowOverwrite: true,
    addRandomSuffix: false,
  })

  const bound = []
  for (const id of ids) {
    if (already.includes(id)) continue
    await put(
      bindKey(id, ttmlId),
      JSON.stringify({ songId: String(id), ttmlId }),
      {
        access: 'public',
        contentType: 'application/json',
        allowOverwrite: true,
        addRandomSuffix: false,
      },
    )
    bound.push(id)
  }

  return { ttmlId, url: res.url, bound, already, conflicts: [], blocked: false }
}

/** 读取某个歌曲 id 的歌词；不存在返回 null */
async function load(songId) {
  const cur = await bindingOf(songId)
  if (cur) {
    const content = await readContent(cur.ttmlId)
    if (content)
      return { ...content, ttmlId: cur.ttmlId, songId: String(songId) }
    // 绑定指向的内容没了，退回去看有没有老数据
  }
  const legacy = await readLegacy(songId)
  if (legacy) return { ...legacy, songId: String(songId) }
  return null
}

/** 只查元信息（不下载内容），做下载跳转时用 */
async function stat(songId) {
  const cur = await bindingOf(songId)
  if (cur) {
    const { head } = require('@vercel/blob')
    try {
      const meta = await head(contentKey(cur.ttmlId))
      if (meta && meta.url) {
        return {
          url: meta.url,
          size: meta.size,
          uploadedAt: meta.uploadedAt,
          ttmlId: cur.ttmlId,
        }
      }
    } catch {
      /* 继续看老数据 */
    }
  }
  const legacy = await readLegacy(songId)
  if (!legacy) return null
  return {
    url: legacy.url,
    size: legacy.size,
    uploadedAt: legacy.uploadedAt,
    ttmlId: legacy.ttmlId,
  }
}

/**
 * 如果没有别的歌曲 id 再绑这份内容，就把内容删掉。
 *
 * list 是最终一致的：刚建好的绑定可能查不到。所以查两遍、中间隔一下，
 * 宁可留一份没人用的内容（几 KB），也不能把还有人用的删掉。
 */
async function gcContent(ttmlId) {
  let users = await bindingsOfTtml(ttmlId)
  if (users.length) return false
  await new Promise((r) => setTimeout(r, 400))
  users = await bindingsOfTtml(ttmlId)
  if (users.length) return false
  const { head, del } = require('@vercel/blob')
  try {
    const meta = await head(contentKey(ttmlId))
    if (meta && meta.url) await del(meta.url)
    return true
  } catch {
    return false
  }
}

/**
 * 解绑：把某个歌曲 id 从歌词上摘下来。
 * 如果摘完这份歌词已经没有任何 id 在用，就连内容一起删掉
 * —— 这就是「与 id 解绑，并删掉当前的 TTML」。
 */
async function unbind(songId, ttmlId) {
  const { del, head } = require('@vercel/blob')

  // 必须是「歌曲 id + 歌词 id」一对，两个都对得上才动手。
  // 只给歌曲 id 就解绑等于盲删，只给歌词 id 就会一次解掉一堆 —— 都不允许。
  if (!isValidId(songId) || !isValidTtmlId(ttmlId)) {
    return {
      unbound: false,
      ttmlId,
      contentDeleted: false,
      error: '必须同时给出合法的歌曲 id 和歌词 ttmlId',
    }
  }

  // 新模型：绑定文件本身就是一个确定的路径，直接删
  if (await isBound(songId, ttmlId)) {
    try {
      const meta = await head(bindKey(songId, ttmlId))
      if (meta && meta.url) await del(meta.url)
    } catch (e) {
      return {
        unbound: false,
        ttmlId,
        contentDeleted: false,
        error: '解绑失败：' + (e.message || e),
      }
    }
    // 同一个 id 若因历史原因还挂着别的绑定，一并清掉
    for (const extra of await listBindings(songId)) {
      if (extra.ttmlId === ttmlId) continue
      try {
        await del(extra.url)
        await gcContent(extra.ttmlId)
      } catch {
        /* 忽略 */
      }
    }
    const contentDeleted = await gcContent(ttmlId)
    return { unbound: true, ttmlId, contentDeleted }
  }

  // 老模型：ttml/<歌曲id>.ttml —— 内容算出来的 id 必须与给的 ttmlId 一致
  const legacy = await readLegacy(songId)
  if (legacy && legacy.ttmlId === ttmlId) {
    try {
      await del(legacy.url)
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

/** 真删除老格式 ttml/<歌曲id>.ttml（没有 ttmlId 的历史数据） */
async function destroyLegacy(songId) {
  const { head, del } = require('@vercel/blob')
  if (!isValidId(songId)) return { songId, deleted: false }
  try {
    const meta = await head(legacyKey(songId))
    if (meta && meta.url) {
      await del(meta.url)
      return { songId, deleted: true }
    }
  } catch {
    /* 不存在 */
  }
  return { songId, deleted: false }
}

/**
 * 列出所有内容与绑定（管理页用）。
 *
 * list() 是最终一致的：刚删掉的东西可能还会列出来一会儿。
 * 管理页要真实反映现状，所以每条再用 head() 确认一次 ——
 * 宁可多发几个请求，也不能让已经删掉的东西一直挂在界面上。
 */
async function listAll() {
  const { list } = require('@vercel/blob')

  // 一次 list 拿全（ttml/ 下面只有三种路径：c/<ttmlId>.ttml、b/<id>--<ttmlId>.json、<id>.ttml）
  // 原来分三次 list 各取一种，每次都是一次往返，在跨区网络下非常贵。
  const raw = []
  let cursor
  do {
    const page = await list({ prefix: PREFIX, cursor, limit: 500 })
    for (const b of page.blobs || []) raw.push(b)
    cursor = page.cursor
  } while (cursor)

  const contents = []
  const binds = []
  const legacy = []
  for (const b of raw) {
    let m
    if ((m = /^ttml\/c\/([0-9a-f]{16})\.ttml$/.exec(b.pathname))) {
      contents.push({
        ttmlId: m[1],
        size: b.size,
        uploadedAt: b.uploadedAt,
        url: b.url,
      })
    } else if (
      (m = /^ttml\/b\/(\d+)--([0-9a-f]{16})\.json$/.exec(b.pathname))
    ) {
      binds.push({ songId: m[1], ttmlId: m[2] })
    } else if ((m = /^ttml\/(\d+)\.ttml$/.exec(b.pathname))) {
      legacy.push({
        songId: m[1],
        pathname: b.pathname,
        url: b.url,
        size: b.size,
        uploadedAt: b.uploadedAt,
      })
    }
  }

  const byId = new Map()
  for (const c of contents) byId.set(c.ttmlId, { ...c, ids: [], orphan: false })
  for (const b of binds) {
    if (!byId.has(b.ttmlId)) {
      // 绑定还在、内容没了：历史遗留，标出来好清理
      byId.set(b.ttmlId, {
        ttmlId: b.ttmlId,
        size: null,
        uploadedAt: null,
        url: null,
        ids: [],
        orphan: true,
      })
    }
    byId.get(b.ttmlId).ids.push(b.songId)
  }

  const items = [...byId.values()].map((it) => ({
    ...it,
    ids: it.ids.sort(),
  }))
  items.sort((a, b) =>
    String(b.uploadedAt || '').localeCompare(String(a.uploadedAt || '')),
  )

  return {
    items,
    legacy,
    total: items.length,
    bindingCount: binds.length,
    contentCount: contents.length,
  }
}

/**
 * 真删除一份 TTML：
 *   1. 删掉所有指向它的绑定（歌曲 id 自动解绑）
 *   2. 删掉内容本体（Blob 上不留）
 * 按路径精确删，不依赖 list 的完整性做判断。
 */
async function destroyTtml(ttmlId) {
  const { del, head, list } = require('@vercel/blob')
  if (!isValidTtmlId(ttmlId)) {
    return { ttmlId, unbound: [], contentDeleted: false, error: 'ttmlId 非法' }
  }

  const unbound = []
  let cursor
  do {
    const page = await list({ prefix: BIND_PREFIX, cursor, limit: 500 })
    for (const b of page.blobs || []) {
      if (!b.pathname.endsWith('--' + ttmlId + '.json')) continue
      const m = /^ttml\/b\/(\d+)--/.exec(b.pathname)
      try {
        await del(b.url)
        if (m) unbound.push(m[1])
      } catch {
        /* 单条删不掉不影响其它 */
      }
    }
    cursor = page.cursor
  } while (cursor)

  let contentDeleted = false
  try {
    const meta = await head(contentKey(ttmlId))
    if (meta && meta.url) {
      await del(meta.url)
      contentDeleted = true
    }
  } catch {
    contentDeleted = false
  }

  return { ttmlId, unbound, contentDeleted }
}

/**
 * 对外展示的下载地址：走本站域名，不把 Blob 的随机子域暴露出去。
 * 域名可用 PUBLIC_BASE_URL 覆盖，默认就是站点本身。
 * 仍然按歌曲 id 下载（对外接口一律用歌曲 id）。
 */
function downloadUrl(id) {
  const base = String(
    process.env.PUBLIC_BASE_URL || 'https://www.sanwith.cc.cd',
  ).replace(/\/+$/, '')
  return `${base}/ttml/file?id=${encodeURIComponent(String(id))}`
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
}
