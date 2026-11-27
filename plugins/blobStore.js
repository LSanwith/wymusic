// 文件本体的存储适配层
//
// 原来是直接 require('@vercel/blob')，现在收口到这里，按环境变量选后端：
//
//   BLOB_DRIVER=vercel  （默认）走 @vercel/blob，行为与以前一致
//   BLOB_DRIVER=remote  走自建机器上的 server/storage-server.js
//                       BLOB_REMOTE_URL / BLOB_REMOTE_TOKEN
//
// 对外接口刻意和 @vercel/blob 保持一致（put / head / del / list），
// 这样调用方只改 require 那一行，业务逻辑不动。

const crypto = require('crypto')

function driver() {
  return String(process.env.BLOB_DRIVER || 'vercel').toLowerCase()
}

function remoteUrl() {
  return String(process.env.BLOB_REMOTE_URL || '')
    .trim()
    .replace(/\/+$/, '')
}

function remoteToken() {
  return String(process.env.BLOB_REMOTE_TOKEN || '').trim()
}

function isRemote() {
  return driver() === 'remote'
}

/** 能不能用（blob 还没配就别让调用方以为是空数据） */
function hasBlob() {
  if (isRemote()) return !!remoteUrl() && !!remoteToken()
  return !!process.env.BLOB_READ_WRITE_TOKEN
}

/**
 * 从 URL 或 pathname 里取出存储键。
 * - 远程驱动：<base>/blob?key=xxx
 * - Vercel：https://xxx.public.blob.vercel-storage.com/<pathname>
 */
function keyOf(input) {
  const raw = String(input || '')
  if (!raw) return ''
  if (raw.startsWith('http://') || raw.startsWith('https://')) {
    try {
      const u = new URL(raw)
      if (u.pathname === '/blob' && u.searchParams.get('key')) {
        return u.searchParams.get('key')
      }
      // Vercel Blob：路径就是 pathname
      return decodeURIComponent(u.pathname.replace(/^\/+/, ''))
    } catch {
      return ''
    }
  }
  return raw.replace(/^\/+/, '')
}

/**
 * 远程模式下「免令牌读」的签名地址。
 * 下载走 302 直接打到存储机，不经过 Vercel 函数（函数响应有 4.5MB 上限）。
 * 签名算法与 server/storage-server.js 的 signedOk 一致：HMAC(key|exp)。
 */
function signedFileUrl(key, ttlMs) {
  const exp = Date.now() + (ttlMs || 10 * 60 * 1000)
  const sig = crypto
    .createHmac('sha256', remoteToken())
    .update(`${key}|${exp}`)
    .digest('base64url')
  return `${remoteUrl()}/blob?key=${encodeURIComponent(key)}&exp=${exp}&sig=${sig}`
}

/** 远程模式下对外暴露的地址（交给 /file/get 做代理，不直接给浏览器） */
function remoteFileUrl(key) {
  return `${remoteUrl()}/blob?key=${encodeURIComponent(key)}`
}

// ---------- 远程驱动 ----------

async function remoteRequest(method, key, body) {
  const res = await fetch(remoteFileUrl(key), {
    method,
    headers: { authorization: `Bearer ${remoteToken()}` },
    body,
  })
  return res
}

// ---------- 统一接口 ----------

/**
 * 写入。远程驱动忽略 contentType 等参数（storage-server 只存字节）。
 * 返回 { url, downloadUrl, pathname, size, uploadedAt }
 */
async function put(pathname, body, opts) {
  const options = opts || {}
  if (!isRemote()) {
    const { put: vercelPut } = require('@vercel/blob')
    const r = await vercelPut(pathname, body, options)
    return {
      url: r.url,
      downloadUrl: r.downloadUrl || r.url,
      pathname: r.pathname || pathname,
      size: r.size,
      uploadedAt: r.uploadedAt || new Date().toISOString(),
    }
  }
  const key = String(pathname)
  const res = await remoteRequest('PUT', key, body)
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(
      `存储服务写入失败（${res.status}）：${detail.slice(0, 200)}`,
    )
  }
  const json = await res.json()
  const url = remoteFileUrl(key)
  return {
    url,
    downloadUrl: url,
    pathname: key,
    size: json.size,
    uploadedAt: new Date().toISOString(),
  }
}

/** 取元信息；不存在时抛错（和 @vercel/blob 的 head 一致） */
async function head(pathname) {
  const key = keyOf(pathname)
  if (!isRemote()) {
    const { head: vercelHead } = require('@vercel/blob')
    const r = await vercelHead(key)
    return {
      url: r.url,
      downloadUrl: r.downloadUrl || r.url,
      pathname: r.pathname || key,
      size: r.size,
      uploadedAt: r.uploadedAt,
      contentType: r.contentType,
    }
  }
  const res = await remoteRequest('HEAD', key)
  if (!res.ok) {
    const err = new Error(`blob not found: ${key}`)
    err.code = 'BLOB_NOT_FOUND'
    throw err
  }
  const size = Number(res.headers.get('content-length') || 0)
  const url = remoteFileUrl(key)
  return {
    url,
    downloadUrl: url,
    pathname: key,
    size,
    uploadedAt: null,
    contentType: 'application/octet-stream',
  }
}

/** 删除，接受 URL 或 pathname，可传数组 */
async function del(input) {
  const list = Array.isArray(input) ? input : [input]
  if (!isRemote()) {
    const { del: vercelDel } = require('@vercel/blob')
    return vercelDel(input)
  }
  for (const item of list) {
    const key = keyOf(item)
    if (!key) continue
    await remoteRequest('DELETE', key).catch(() => {})
  }
  return {}
}

/** 列目录。远程驱动一次拿全，用 cursor 模拟分页（保持调用方逻辑不变） */
async function list(options) {
  const opts = options || {}
  const prefix = String(opts.prefix || '')
  const limit = Number(opts.limit || 1000)
  const cursor = opts.cursor ? Number(opts.cursor) : 0
  if (!isRemote()) {
    const { list: vercelList } = require('@vercel/blob')
    return vercelList(options)
  }
  const url = `${remoteUrl()}/list?prefix=${encodeURIComponent(prefix)}`
  const res = await fetch(url, {
    headers: { authorization: `Bearer ${remoteToken()}` },
  })
  if (!res.ok) {
    throw new Error(`存储服务列目录失败（${res.status}）`)
  }
  const json = await res.json()
  const keys = Array.isArray(json.keys) ? json.keys : []
  const slice = keys.slice(cursor, cursor + limit)
  const next = cursor + limit < keys.length ? String(cursor + limit) : undefined
  return {
    blobs: slice.map((key) => ({
      pathname: key,
      url: remoteFileUrl(key),
      size: null,
      uploadedAt: null,
    })),
    cursor: next,
  }
}

/**
 * 读出字节（远程驱动用；Vercel 驱动走公开 URL 的 fetch）
 * 返回 Response，调用方自己 .text() / .stream
 */
async function get(pathname) {
  const key = keyOf(pathname)
  if (!isRemote()) {
    const { head: vercelHead } = require('@vercel/blob')
    const meta = await vercelHead(key)
    return fetch(meta.downloadUrl || meta.url)
  }
  return remoteRequest('GET', key)
}

module.exports = {
  put,
  head,
  del,
  list,
  get,
  keyOf,
  hasBlob,
  isRemote,
  remoteFileUrl,
  signedFileUrl,
  driver,
}
