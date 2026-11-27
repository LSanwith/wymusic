#!/usr/bin/env node
// 存储服务：把一台机器的磁盘暴露成 HTTP 接口，给 Vercel 上的 Serverless 函数用
//
//   node server/storage-server.js
//
// 环境变量：
//   STORAGE_PORT    监听端口，默认 8787
//   STORAGE_DIR     数据目录，默认 <cwd>/data
//   STORAGE_TOKEN   访问令牌（必填，客户端用 Bearer 传）
//
// 接口（全部需要 Authorization: Bearer <token>）：
//   POST   /kv           body={"command":["GET","k"]}      → {"result": ...}
//   PUT    /blob?key=x   body=任意字节                       → {"key","size","url"}
//   GET    /blob?key=x                                      → 原始字节
//   HEAD   /blob?key=x                                      → 头里带 size
//   DELETE /blob?key=x                                      → 删除
//   GET    /list?prefix=x                                   → {"keys":[...]}
//   GET    /health                                          → {"ok":true}
//
// KV 部分和 plugins/kvStore.js 的本地驱动共用同一套落盘格式，
// 所以既能在 VPS 上直接跑 API，也能只当存储用。
//
// 只依赖 Node 内置模块，内存占用很小（几十 MB）。

const http = require('http')
const fs = require('fs')
const fsp = fs.promises
const path = require('path')
const crypto = require('crypto')
const { URL } = require('url')

const PORT = Number(process.env.STORAGE_PORT || 8787)
const DIR = path.resolve(
  process.env.STORAGE_DIR || path.join(process.cwd(), 'data'),
)
const TOKEN = String(process.env.STORAGE_TOKEN || '').trim()

if (!TOKEN) {
  console.error('缺少 STORAGE_TOKEN，拒绝启动（不能开一个无鉴权的存储服务）')
  process.exit(1)
}

const KV_DIR = path.join(DIR, 'kv')
const BLOB_DIR = path.join(DIR, 'blobs')

const encodeName = (s) =>
  encodeURIComponent(String(s)).replace(
    /[!'()*]/g,
    (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase(),
  )

const stringPath = (key) => path.join(KV_DIR, 's', encodeName(key))
const setPath = (key) => path.join(KV_DIR, 'S', encodeName(key))
const hashPath = (key) => path.join(KV_DIR, 'h', encodeName(key))
const zsetPath = (key) => path.join(KV_DIR, 'z', encodeName(key))

/** blob 键可能带目录（tmp/xxx），逐段编码，禁止 .. 穿越 */
function blobPath(key) {
  const parts = String(key).split('/').filter(Boolean)
  if (!parts.length) throw new Error('key 为空')
  for (const p of parts)
    if (p === '.' || p === '..') throw new Error('非法 key')
  return path.join(BLOB_DIR, ...parts.map(encodeName))
}

const safeKey = (raw) => {
  const s = String(raw || '')
  if (!s || s.length > 512) throw new Error('key 非法')
  return s
}

async function writeAtomic(file, data) {
  await fsp.mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  await fsp.writeFile(tmp, data)
  await fsp.rename(tmp, file)
}

async function listDir(dir) {
  try {
    return await fsp.readdir(dir)
  } catch {
    return []
  }
}

function scoreBound(raw, fallback) {
  const s = String(raw).trim()
  if (s === '+' || s === '+inf') return Infinity
  if (s === '-' || s === '-inf') return -Infinity
  const n = Number(s)
  return Number.isFinite(n) ? n : fallback
}

// ---------- KV 命令（与 plugins/kvStore.js 本地驱动保持一致）----------

async function runCommand(command) {
  const name = String(command[0] || '').toUpperCase()
  switch (name) {
    case 'GET':
      try {
        return await fsp.readFile(stringPath(command[1]), 'utf8')
      } catch {
        return null
      }
    case 'SET':
      await writeAtomic(
        stringPath(command[1]),
        String(command[2] == null ? '' : command[2]),
      )
      return 'OK'
    case 'EXISTS': {
      let n = 0
      for (const key of command.slice(1)) {
        try {
          await fsp.access(stringPath(key))
          n++
        } catch {
          /* 不存在 */
        }
      }
      return n
    }
    case 'DEL': {
      let n = 0
      for (const key of command.slice(1)) {
        try {
          await fsp.unlink(stringPath(key))
          n++
        } catch {
          /* 不存在 */
        }
        await fsp
          .rm(setPath(key), { recursive: true, force: true })
          .catch(() => {})
        await fsp
          .rm(hashPath(key), { recursive: true, force: true })
          .catch(() => {})
        await fsp
          .rm(zsetPath(key), { recursive: true, force: true })
          .catch(() => {})
      }
      return n
    }
    case 'SADD': {
      const dir = setPath(command[1])
      await fsp.mkdir(dir, { recursive: true })
      let n = 0
      for (const member of command.slice(2)) {
        const file = path.join(dir, encodeName(member))
        try {
          await fsp.access(file)
        } catch {
          await fsp.writeFile(file, '')
          n++
        }
      }
      return n
    }
    case 'SREM': {
      const dir = setPath(command[1])
      let n = 0
      for (const member of command.slice(2)) {
        try {
          await fsp.unlink(path.join(dir, encodeName(member)))
          n++
        } catch {
          /* 不存在 */
        }
      }
      return n
    }
    case 'SMEMBERS': {
      const names = await listDir(setPath(command[1]))
      return names.map((x) => decodeURIComponent(x))
    }
    case 'SCARD':
      return (await listDir(setPath(command[1]))).length
    case 'HGET':
      try {
        return await fsp.readFile(
          path.join(hashPath(command[1]), encodeName(command[2])),
          'utf8',
        )
      } catch {
        return null
      }
    case 'HSET': {
      const dir = hashPath(command[1])
      await fsp.mkdir(dir, { recursive: true })
      const file = path.join(dir, encodeName(command[2]))
      let isNew = false
      try {
        await fsp.access(file)
      } catch {
        isNew = true
      }
      await writeAtomic(file, String(command[3] == null ? '' : command[3]))
      return isNew ? 1 : 0
    }
    case 'HDEL': {
      let n = 0
      for (const field of command.slice(2)) {
        try {
          await fsp.unlink(path.join(hashPath(command[1]), encodeName(field)))
          n++
        } catch {
          /* 不存在 */
        }
      }
      return n
    }
    case 'HGETALL': {
      const dir = hashPath(command[1])
      const names = await listDir(dir)
      const out = []
      for (const name of names) {
        try {
          out.push(
            decodeURIComponent(name),
            await fsp.readFile(path.join(dir, name), 'utf8'),
          )
        } catch {
          /* 跳过 */
        }
      }
      return out
    }
    case 'HLEN':
      return (await listDir(hashPath(command[1]))).length
    case 'ZADD': {
      const dir = zsetPath(command[1])
      await fsp.mkdir(dir, { recursive: true })
      const file = path.join(dir, encodeName(command[3]))
      let isNew = false
      try {
        await fsp.access(file)
      } catch {
        isNew = true
      }
      await writeAtomic(file, String(command[2]))
      return isNew ? 1 : 0
    }
    case 'ZREM': {
      let n = 0
      for (const member of command.slice(2)) {
        try {
          await fsp.unlink(path.join(zsetPath(command[1]), encodeName(member)))
          n++
        } catch {
          /* 不存在 */
        }
      }
      return n
    }
    case 'ZCOUNT': {
      const dir = zsetPath(command[1])
      const min = scoreBound(command[2], -Infinity)
      const max = scoreBound(command[3], Infinity)
      let n = 0
      for (const name of await listDir(dir)) {
        try {
          const score = Number(await fsp.readFile(path.join(dir, name), 'utf8'))
          if (Number.isFinite(score) && score >= min && score <= max) n++
        } catch {
          /* 跳过 */
        }
      }
      return n
    }
    case 'ZRANGEBYSCORE': {
      const dir = zsetPath(command[1])
      const min = scoreBound(command[2], -Infinity)
      const max = scoreBound(command[3], Infinity)
      let offset = 0
      let limit = Infinity
      for (let i = 4; i < command.length; i++) {
        if (String(command[i]).toUpperCase() === 'LIMIT') {
          offset = Number(command[i + 1]) || 0
          limit = Number(command[i + 2])
          if (!Number.isFinite(limit)) limit = Infinity
        }
      }
      const rows = []
      for (const name of await listDir(dir)) {
        try {
          const score = Number(await fsp.readFile(path.join(dir, name), 'utf8'))
          if (Number.isFinite(score) && score >= min && score <= max) {
            rows.push([decodeURIComponent(name), score])
          }
        } catch {
          /* 跳过 */
        }
      }
      rows.sort((a, b) => a[1] - b[1])
      return rows.slice(offset, offset + limit).map((r) => r[0])
    }
    default:
      throw new Error('不支持的命令：' + name)
  }
}

// ---------- HTTP ----------

function send(res, code, body, headers) {
  const h = Object.assign({}, CORS, headers)
  res.writeHead(code, h)
  res.end(body)
}

function json(res, code, obj) {
  const text = JSON.stringify(obj)
  send(res, code, text, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
  })
}

function authorized(req) {
  const h = String(req.headers.authorization || '')
  const got = h.startsWith('Bearer ') ? h.slice(7).trim() : ''
  if (!got || got.length !== TOKEN.length) return false
  try {
    return crypto.timingSafeEqual(Buffer.from(got), Buffer.from(TOKEN))
  } catch {
    return false
  }
}

/** 给浏览器直传用的短期签名：sig = HMAC(key|exp) */
function signKey(key, exp) {
  return crypto
    .createHmac('sha256', TOKEN)
    .update(`${key}|${exp}`)
    .digest('base64url')
}

/** 校验 ?exp=&sig=，允许在有效期内免 Bearer 写入 */
function signedOk(url, key) {
  const exp = Number(url.searchParams.get('exp') || 0)
  const sig = String(url.searchParams.get('sig') || '')
  if (!exp || Date.now() > exp || !sig) return false
  const want = signKey(key, exp)
  if (sig.length !== want.length) return false
  try {
    return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want))
  } catch {
    return false
  }
}

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,PUT,POST,HEAD,DELETE,OPTIONS',
  'access-control-allow-headers': 'authorization,content-type',
  'access-control-max-age': '86400',
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (c) => {
      size += c.length
      if (size > limit) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

const MAX_BODY = Number(process.env.STORAGE_MAX_BODY || 210 * 1024 * 1024)

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost')
  try {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, CORS)
      return res.end()
    }
    if (url.pathname === '/health') return json(res, 200, { ok: true })

    // 签名地址：PUT（浏览器直传）与 GET/HEAD（下载 302 过来）都免 Bearer
    const signedRequest =
      ['PUT', 'GET', 'HEAD'].includes(req.method) &&
      url.pathname === '/blob' &&
      signedOk(url, String(url.searchParams.get('key') || ''))

    if (!authorized(req) && !signedRequest) {
      return json(res, 401, { error: 'unauthorized' })
    }

    if (url.pathname === '/kv' && req.method === 'POST') {
      const raw = await readBody(req, 8 * 1024 * 1024)
      let payload
      try {
        payload = JSON.parse(raw.toString('utf8'))
      } catch {
        return json(res, 400, { error: 'body 不是 JSON' })
      }
      const command = payload && payload.command
      if (!Array.isArray(command))
        return json(res, 400, { error: '缺少 command' })
      try {
        return json(res, 200, { result: await runCommand(command) })
      } catch (e) {
        return json(res, 400, { error: String(e.message || e) })
      }
    }

    if (url.pathname === '/blob') {
      const key = safeKey(url.searchParams.get('key'))
      const file = blobPath(key)

      if (req.method === 'PUT') {
        const declared = Number(req.headers['content-length'] || 0)
        if (declared && declared > MAX_BODY) {
          return json(res, 413, { error: `文件超过上限（${MAX_BODY} 字节）` })
        }
        await fsp.mkdir(path.dirname(file), { recursive: true })
        const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
        let size = 0
        try {
          await new Promise((resolve, reject) => {
            const out = fs.createWriteStream(tmp)
            req.on('data', (chunk) => {
              size += chunk.length
              if (size > MAX_BODY) {
                reject(new Error('文件超过上限'))
                req.destroy()
              }
            })
            req.pipe(out)
            out.on('finish', resolve)
            out.on('error', reject)
            req.on('error', reject)
          })
          await fsp.rename(tmp, file)
        } catch (e) {
          await fsp.unlink(tmp).catch(() => {})
          return json(res, e.message === '文件超过上限' ? 413 : 500, {
            error: String(e.message || e),
          })
        }
        return json(res, 200, {
          key,
          size,
          url: `/blob?key=${encodeURIComponent(key)}`,
        })
      }
      if (req.method === 'GET') {
        try {
          const stat = await fsp.stat(file)
          res.writeHead(200, {
            'content-type': 'application/octet-stream',
            'content-length': stat.size,
          })
          fs.createReadStream(file).pipe(res)
        } catch {
          json(res, 404, { error: 'not found' })
        }
        return
      }
      if (req.method === 'HEAD') {
        try {
          const stat = await fsp.stat(file)
          res.writeHead(200, { 'content-length': stat.size })
          res.end()
        } catch {
          res.writeHead(404)
          res.end()
        }
        return
      }
      if (req.method === 'DELETE') {
        try {
          await fsp.unlink(file)
          return json(res, 200, { deleted: true })
        } catch {
          return json(res, 404, { error: 'not found' })
        }
      }
      return json(res, 405, { error: 'method not allowed' })
    }

    if (url.pathname === '/list' && req.method === 'GET') {
      const prefix = String(url.searchParams.get('prefix') || '')
      const keys = []
      async function walk(dir, rel) {
        let entries
        try {
          entries = await fsp.readdir(dir, { withFileTypes: true })
        } catch {
          return
        }
        for (const e of entries) {
          const next = rel
            ? `${rel}/${decodeURIComponent(e.name)}`
            : decodeURIComponent(e.name)
          if (e.isDirectory()) await walk(path.join(dir, e.name), next)
          else if (!prefix || next.startsWith(prefix)) keys.push(next)
        }
      }
      await walk(BLOB_DIR, '')
      keys.sort()
      return json(res, 200, { keys })
    }

    return json(res, 404, { error: 'not found' })
  } catch (e) {
    return json(res, 500, { error: String(e.message || e) })
  }
})

server.listen(PORT, () => {
  console.log(`storage-server 监听 :${PORT}`)
  console.log(`数据目录: ${DIR}`)
  console.log(`KV: ${KV_DIR}`)
  console.log(`Blob: ${BLOB_DIR}`)
})
