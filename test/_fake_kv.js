// 测试用的假 KV（Upstash REST）与假 Blob
//
// 不是测试用例本身：文件名以 _ 开头，`server.test.js` 会 require 它但不会跑任何断言。
// 提供的内容：
//   makeFakeKv()   —— 内存版的 Upstash REST（支持本项目用到的那几条命令）
//   makeFakeBlob() —— 内存版的 @vercel/blob（list / get / head / del）
//
// 用法见 test/ttml_store.test.js 与 test/file_index.test.js。
const http = require('http')
const crypto = require('crypto')

/** 假 KV：POST / 跑一条命令，POST /pipeline 跑一批 */
function makeFakeKv() {
  const strings = new Map()
  const sets = new Map()
  const hashes = new Map()
  const zsets = new Map() // key -> Map(member -> score)
  const stats = { commands: 0, requests: 0 }

  const hashOf = (key) => {
    if (!hashes.has(key)) hashes.set(key, new Map())
    return hashes.get(key)
  }
  const zsetOf = (key) => {
    if (!zsets.has(key)) zsets.set(key, new Map())
    return zsets.get(key)
  }
  const bound = (raw, fallback) => {
    if (raw === '-inf') return fallback(-Infinity)
    if (raw === '+inf') return fallback(Infinity)
    const n = Number(raw)
    return Number.isFinite(n) ? n : fallback(0)
  }

  const run = (command) => {
    stats.commands += 1
    const [name, ...args] = command.map((x) => String(x))
    const op = name.toUpperCase()

    if (op === 'GET') return strings.has(args[0]) ? strings.get(args[0]) : null
    if (op === 'SET') {
      strings.set(args[0], args[1])
      return 'OK'
    }
    if (op === 'DEL') {
      let n = 0
      for (const key of args) {
        for (const store of [strings, sets, hashes, zsets]) {
          if (store.delete(key)) n += 1
        }
      }
      return n
    }
    if (op === 'EXISTS') {
      return args.filter(
        (k) => strings.has(k) || sets.has(k) || hashes.has(k) || zsets.has(k),
      ).length
    }
    if (op === 'SADD') {
      const set = sets.get(args[0]) || new Set()
      let added = 0
      for (const member of args.slice(1)) {
        if (!set.has(member)) {
          set.add(member)
          added += 1
        }
      }
      sets.set(args[0], set)
      return added
    }
    if (op === 'SREM') {
      const set = sets.get(args[0])
      if (!set) return 0
      let removed = 0
      for (const member of args.slice(1)) {
        if (set.delete(member)) removed += 1
      }
      return removed
    }
    if (op === 'SMEMBERS') return [...(sets.get(args[0]) || new Set())]
    if (op === 'SCARD') return (sets.get(args[0]) || new Set()).size

    if (op === 'HSET') {
      const hash = hashOf(args[0])
      let added = 0
      for (let i = 1; i + 1 < args.length; i += 2) {
        if (!hash.has(args[i])) added += 1
        hash.set(args[i], args[i + 1])
      }
      return added
    }
    if (op === 'HGET') {
      const hash = hashes.get(args[0])
      return hash && hash.has(args[1]) ? hash.get(args[1]) : null
    }
    if (op === 'HDEL') {
      const hash = hashes.get(args[0])
      if (!hash) return 0
      let removed = 0
      for (const field of args.slice(1)) {
        if (hash.delete(field)) removed += 1
      }
      return removed
    }
    if (op === 'HGETALL') {
      const hash = hashes.get(args[0])
      return hash ? Object.fromEntries(hash) : {}
    }
    if (op === 'HLEN') {
      const hash = hashes.get(args[0])
      return hash ? hash.size : 0
    }

    if (op === 'ZADD') {
      const set = zsetOf(args[0])
      let added = 0
      for (let i = 1; i + 1 < args.length; i += 2) {
        const score = Number(args[i])
        const member = args[i + 1]
        if (!set.has(member)) added += 1
        set.set(member, score)
      }
      return added
    }
    if (op === 'ZREM') {
      const set = zsets.get(args[0])
      if (!set) return 0
      let removed = 0
      for (const member of args.slice(1)) {
        if (set.delete(member)) removed += 1
      }
      return removed
    }
    if (op === 'ZCARD') return (zsets.get(args[0]) || new Map()).size
    if (op === 'ZCOUNT') {
      const set = zsets.get(args[0]) || new Map()
      const min = bound(args[1], (v) => v)
      const max = bound(args[2], (v) => v)
      let n = 0
      for (const score of set.values()) {
        if (score >= min && score <= max) n += 1
      }
      return n
    }
    if (op === 'ZRANGEBYSCORE') {
      const set = zsets.get(args[0]) || new Map()
      const min = bound(args[1], (v) => v)
      const max = bound(args[2], (v) => v)
      let limit = Infinity
      let offset = 0
      for (let i = 3; i < args.length; i++) {
        if (String(args[i]).toUpperCase() === 'LIMIT') {
          offset = Number(args[i + 1])
          limit = Number(args[i + 2])
        }
      }
      const hits = [...set.entries()]
        .filter(([, score]) => score >= min && score <= max)
        .sort((a, b) => a[1] - b[1])
        .map(([member]) => member)
        .slice(offset, offset + limit)
      return hits
    }

    throw new Error('假 KV 不认识这个命令：' + name)
  }

  const server = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      stats.requests += 1
      let body
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '[]')
      } catch {
        res.statusCode = 400
        return res.end(JSON.stringify({ error: 'bad json' }))
      }
      try {
        const result = String(req.url).startsWith('/pipeline')
          ? body.map((cmd) => ({ result: run(cmd) }))
          : { result: run(body) }
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify(result))
      } catch (e) {
        res.statusCode = 500
        res.end(JSON.stringify({ error: e.message }))
      }
    })
  })

  return { server, strings, sets, hashes, zsets, stats }
}

/** 假 Blob：只实现本仓库用到的 list / get / head / del */
function makeFakeBlob() {
  const files = new Map() // pathname -> { text, contentType, uploadedAt }
  let seq = 0
  const etag = (text) => {
    seq += 1
    return `"${crypto.createHash('sha1').update(text).digest('hex')}-${seq}"`
  }
  const urlOf = (pathname) => 'https://blob.invalid/' + pathname
  const toPath = (input) =>
    String(input)
      .replace(/^https?:\/\/[^/]+\//, '')
      .replace(/^\/blob\//, '')

  const api = {
    async list(options = {}) {
      const prefix = options.prefix || ''
      const keys = [...files.keys()].filter((k) => k.startsWith(prefix)).sort()
      return {
        blobs: keys.map((k) => {
          const rec = files.get(k)
          return {
            pathname: k,
            url: urlOf(k),
            downloadUrl: urlOf(k) + '?download=1',
            size: Buffer.byteLength(rec.text),
            uploadedAt: rec.uploadedAt,
            contentType: rec.contentType,
            etag: etag(rec.text),
          }
        }),
        cursor: null,
        hasMore: false,
      }
    },
    async get(pathname) {
      const rec = files.get(toPath(pathname))
      if (!rec) return null
      return {
        statusCode: 200,
        stream: new Response(rec.text).body,
        blob: { url: urlOf(toPath(pathname)), etag: etag(rec.text) },
      }
    },
    async head(pathname) {
      const key = toPath(pathname)
      const rec = files.get(key)
      if (!rec) {
        const e = new Error('not found: ' + key)
        e.name = 'BlobNotFoundError'
        throw e
      }
      return {
        url: urlOf(key),
        downloadUrl: urlOf(key) + '?download=1',
        pathname: key,
        size: Buffer.byteLength(rec.text),
        uploadedAt: rec.uploadedAt,
        contentType: rec.contentType,
        etag: etag(rec.text),
      }
    },
    async put(pathname, body, options = {}) {
      const key = toPath(pathname)
      const text =
        typeof body === 'string' ? body : Buffer.from(body).toString('utf8')
      const uploadedAt = new Date().toISOString()
      files.set(key, {
        text,
        contentType: options.contentType || 'text/plain',
        uploadedAt,
      })
      return {
        url: urlOf(key),
        downloadUrl: urlOf(key) + '?download=1',
        pathname: key,
        size: Buffer.byteLength(text),
        uploadedAt,
        contentType: options.contentType || 'text/plain',
      }
    },
    async del(input) {
      const list = Array.isArray(input) ? input : [input]
      for (const one of list) files.delete(toPath(one))
    },
  }

  return { files, api }
}

module.exports = { makeFakeKv, makeFakeBlob }
