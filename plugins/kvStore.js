// Upstash Redis（Vercel KV）的极简 REST 客户端
//
// 为什么不用 SDK：项目里只要几条命令（GET/SET/SADD/...），
// 直接打 REST 接口既不用加依赖，也不会在 Serverless 里多一层连接管理。
//
// 环境变量（Vercel 里连 Upstash for Redis、前缀选 KV 会自动注入）：
//   KV_REST_API_URL / KV_REST_API_TOKEN
// 需要单独配别的实例时可以用 TTML_KV_URL / TTML_KV_TOKEN 覆盖。
//
// 也可以用本地磁盘（VPS 自建场景，不依赖任何外部服务）：
//   KV_DRIVER=local
//   KV_LOCAL_DIR=<数据目录，默认 <cwd>/data/kv>
// 命令集就 7 个（GET/SET/EXISTS/DEL/SADD/SREM/SMEMBERS），本地实现完全够用。
//
// 约定：命令参数就是 Redis 命令的参数数组，例如 ['SET', 'k', 'v']；
// 出错一律抛 Error（调用方决定 500 还是 501）。

const fs = require('fs')
const fsp = fs.promises
const path = require('path')

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

/** 是否走本地磁盘驱动 */
function isLocal() {
  return String(process.env.KV_DRIVER || '').toLowerCase() === 'local'
}

/**
 * 是否走远程存储服务（Vercel 部署 + 自建机器当数据中心）
 * 需要 server/storage-server.js 在那台机器上跑着。
 */
function isRemote() {
  return String(process.env.KV_DRIVER || '').toLowerCase() === 'remote'
}

function remoteUrl() {
  return String(process.env.KV_REMOTE_URL || '')
    .trim()
    .replace(/\/+$/, '')
}

function remoteToken() {
  return String(process.env.KV_REMOTE_TOKEN || '').trim()
}

/** 本地数据目录 */
function kvLocalDir() {
  const custom = String(process.env.KV_LOCAL_DIR || '').trim()
  return custom || path.join(process.cwd(), 'data', 'kv')
}

/** 配了 KV（或显式开了本地/远程驱动）才算能用 */
function hasKv() {
  if (isLocal()) return true
  if (isRemote()) return !!remoteUrl() && !!remoteToken()
  return !!kvUrl() && !!kvToken()
}

// ---------- 本地磁盘驱动 ----------
// 键名直接当文件名会踩到 : / 等字符，统一编码一次。
//   字符串：<dir>/s/<key>
//   集合：  <dir>/S/<key>/<member>（空文件当标记）
// 只用 7 条命令，没有并发写场景（单进程部署），所以不需要锁。

const encodeName = (s) =>
  encodeURIComponent(String(s)).replace(
    /[!'()*]/g,
    (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase(),
  )

const stringPath = (key) => path.join(kvLocalDir(), 's', encodeName(key))
const setPath = (key) => path.join(kvLocalDir(), 'S', encodeName(key))
const hashPath = (key) => path.join(kvLocalDir(), 'h', encodeName(key))
const zsetPath = (key) => path.join(kvLocalDir(), 'z', encodeName(key))

/** ZCOUNT 的边界值：支持 +inf / -inf */
function scoreBound(raw, fallback) {
  const s = String(raw).trim()
  if (s === '+' || s === '+inf') return Infinity
  if (s === '-' || s === '-inf') return -Infinity
  const n = Number(s)
  return Number.isFinite(n) ? n : fallback
}

/** 列目录，不存在就返回空数组 */
async function listDir(dir) {
  try {
    return await fsp.readdir(dir)
  } catch {
    return []
  }
}

/** 先写临时文件再改名，避免读到写了一半的内容 */
async function writeAtomic(file, text) {
  await fsp.mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  await fsp.writeFile(tmp, text, 'utf8')
  await fsp.rename(tmp, file)
}

async function localCommand(command) {
  const name = String(command[0] || '').toUpperCase()
  switch (name) {
    case 'GET': {
      try {
        return await fsp.readFile(stringPath(command[1]), 'utf8')
      } catch {
        return null
      }
    }
    case 'SET': {
      await writeAtomic(
        stringPath(command[1]),
        String(command[2] == null ? '' : command[2]),
      )
      return 'OK'
    }
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
        try {
          await fsp.rm(setPath(key), { recursive: true, force: true })
        } catch {
          /* 不存在 */
        }
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
      try {
        const names = await fsp.readdir(setPath(command[1]))
        return names.map((x) => decodeURIComponent(x))
      } catch {
        return []
      }
    }
    case 'SCARD': {
      const names = await listDir(setPath(command[1]))
      return names.length
    }
    // ---------- 哈希（文件索引层在用）----------
    case 'HGET': {
      try {
        return await fsp.readFile(
          path.join(hashPath(command[1]), encodeName(command[2])),
          'utf8',
        )
      } catch {
        return null
      }
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
          const value = await fsp.readFile(path.join(dir, name), 'utf8')
          out.push(decodeURIComponent(name), value)
        } catch {
          /* 读不到就跳过 */
        }
      }
      return out
    }
    case 'HLEN': {
      const names = await listDir(hashPath(command[1]))
      return names.length
    }
    // ---------- 有序集合（保存期配额/GC 在用）----------
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
      const names = await listDir(dir)
      let n = 0
      for (const name of names) {
        try {
          const score = Number(await fsp.readFile(path.join(dir, name), 'utf8'))
          if (Number.isFinite(score) && score >= min && score <= max) n++
        } catch {
          /* 读不到就跳过 */
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
          /* 读不到就跳过 */
        }
      }
      rows.sort((a, b) => a[1] - b[1])
      return rows.slice(offset, offset + limit).map((r) => r[0])
    }
    default:
      throw new Error(`本地 KV 驱动不支持命令：${name}`)
  }
}

// ---------- Upstash REST ----------

async function kvRequest(pathname, payload) {
  const url = kvUrl()
  if (!url) throw new Error('未配置 KV（缺少 KV_REST_API_URL）')
  const res = await fetch(url + pathname, {
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

/** 远程存储服务：把整条命令发给 server/storage-server.js */
async function remoteCommand(command) {
  const base = remoteUrl()
  if (!base) throw new Error('未配置远程存储（缺少 KV_REMOTE_URL）')
  const res = await fetch(base + '/kv', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${remoteToken()}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ command }),
  })
  let json = null
  try {
    json = await res.json()
  } catch {
    json = null
  }
  if (!res.ok || !json) {
    throw new Error(
      `存储服务请求失败（${res.status}）：${(json && json.error) || '无响应体'}`,
    )
  }
  if (json.error) throw new Error('存储服务：' + json.error)
  return json.result
}

/** 单条命令，返回 result */
async function kv(command) {
  if (isLocal()) return localCommand(command)
  if (isRemote()) return remoteCommand(command)
  const json = await kvRequest('', command)
  return json ? json.result : null
}

/** 一次往返跑多条命令，按顺序返回 result 数组 */
async function kvPipeline(commands) {
  if (!commands.length) return []
  if (isLocal()) {
    const out = []
    for (const command of commands) out.push(await localCommand(command))
    return out
  }
  if (isRemote()) {
    // 存储服务目前只接受单条命令，这里顺序执行。
    // 一次 pipeline 的命令数很少（几条），多几次往返可以接受。
    const out = []
    for (const command of commands) out.push(await remoteCommand(command))
    return out
  }
  const results = await kvRequest('/pipeline', commands)
  if (!Array.isArray(results)) throw new Error('KV pipeline 返回异常')
  for (const item of results) {
    if (item && item.error) throw new Error('KV：' + item.error)
  }
  return results.map((item) => (item ? item.result : null))
}

module.exports = {
  kvUrl,
  kvToken,
  hasKv,
  kv,
  kvPipeline,
  isLocal,
  kvLocalDir,
  isRemote,
  remoteUrl,
}
