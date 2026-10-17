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
 * 返回 { ttmlId, bound, already, rebound, prevTtmlId }：
 *   bound   这次新建的绑定
 *   already 本来就已经绑到同一份内容的（不用重复处理）
 *   rebound 原来绑着别的歌词，这次改绑到这份
 *   prevTtmlId  Map 语义的旧绑定，供上层提示「从哪份改绑过来的」
 */
async function save(ids, ttml) {
  const { put } = require('@vercel/blob')
  const content = String(ttml == null ? '' : ttml)
  const ttmlId = ttmlIdOf(content)

  // 内容同 id 覆盖写：同内容天然幂等
  const res = await put(contentKey(ttmlId), content, {
    access: 'public',
    contentType: 'application/ttml+xml; charset=utf-8',
    allowOverwrite: true,
    addRandomSuffix: false,
  })

  const bound = []
  const already = []
  const rebound = []
  const prev = {}
  for (const id of ids) {
    // 精确判断：不依赖 list，避免刚绑上查不到
    if (await isBound(id, ttmlId)) {
      already.push(id)
      continue
    }
    const cur = await bindingOf(id)
    if (cur && cur.ttmlId !== ttmlId) {
      prev[id] = cur.ttmlId
      rebound.push(id)
    }
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
    // 旧绑定点删掉；旧内容没人用就回收
    if (cur && cur.ttmlId !== ttmlId) {
      const { del } = require('@vercel/blob')
      try {
        await del(cur.url)
      } catch {
        /* 旧的删不掉不影响这次绑定 */
      }
      await gcContent(cur.ttmlId)
    }
    bound.push(id)
  }

  return { ttmlId, url: res.url, bound, already, rebound, prev }
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
  downloadUrl,
}
