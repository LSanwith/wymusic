// TTML 歌词存储（Vercel Blob）
//
// 路径约定：ttml/<网易云歌曲 id>.ttml
// 一份 TTML 可以对应多个 id，那就按 id 各存一份 —— 歌词只有几 KB，
// 按 id 一份换来「不需要任何索引表」，读取就是一次 head()。
//
// 依赖 BLOB_READ_WRITE_TOKEN（与文件挂载代理共用同一个 Blob store）。
const PREFIX = 'ttml/'

/** Blob 路径。id 已在入口校验过是纯数字 */
function keyOf(id) {
  return PREFIX + String(id) + '.ttml'
}

/** 网易云歌曲 id 都是纯数字 */
function isValidId(id) {
  return /^\d{1,20}$/.test(String(id == null ? '' : id).trim())
}

function hasToken() {
  return !!process.env.BLOB_READ_WRITE_TOKEN
}

/** 写入（同 id 覆盖）。返回 {url, pathname} */
async function save(id, ttml) {
  const { put } = require('@vercel/blob')
  const res = await put(keyOf(id), ttml, {
    access: 'public',
    contentType: 'application/ttml+xml; charset=utf-8',
    allowOverwrite: true,
    // 不加随机后缀：路径就是 id，覆盖语义明确，也不用索引
    addRandomSuffix: false,
  })
  return { url: res.url, pathname: res.pathname }
}

/** 读取，不存在返回 null */
async function load(id) {
  const { head } = require('@vercel/blob')
  let meta
  try {
    meta = await head(keyOf(id))
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

/** 只查元信息（不下载内容），做下载跳转时用 */
async function stat(id) {
  const { head } = require('@vercel/blob')
  let meta
  try {
    meta = await head(keyOf(id))
  } catch {
    return null
  }
  if (!meta || !meta.url) return null
  return { url: meta.url, size: meta.size, uploadedAt: meta.uploadedAt }
}

/**
 * 对外展示的下载地址：走本站域名，不把 Blob 的随机子域暴露出去。
 * 域名可用 PUBLIC_BASE_URL 覆盖，默认就是站点本身。
 */
function downloadUrl(id) {
  const base = String(
    process.env.PUBLIC_BASE_URL || 'https://www.sanwith.cc.cd',
  ).replace(/\/+$/, '')
  return `${base}/ttml/file?id=${encodeURIComponent(String(id))}`
}

module.exports = {
  PREFIX,
  keyOf,
  isValidId,
  hasToken,
  save,
  load,
  stat,
  downloadUrl,
}
