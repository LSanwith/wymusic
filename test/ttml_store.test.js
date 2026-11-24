// ttmlStore 的离线单测：把 @vercel/blob 换成内存里的假实现，
// 重点验证「读歌词不再 list」这件事 —— 那是 Hobby 额度被烧穿的根因。
//
// 这个文件不联网、不需要 BLOB_READ_WRITE_TOKEN，`pnpm test` 时会一起跑。
const assert = require('assert')
const http = require('http')
const Module = require('module')
const path = require('path')

const TTML_A =
  '<?xml version="1.0"?><tt xmlns="http://www.w3.org/ns/ttml"><body><div>' +
  '<p begin="00:00:01.000" end="00:00:03.000">a</p></div></body></tt>'
const TTML_B = TTML_A.replace('>a<', '>b<')

function makeFakeBlob() {
  const stats = { list: 0, get: 0, put: 0, head: 0, del: 0 }
  const blobs = new Map()
  let seq = 0
  let port = 0

  const urlOf = (pathname) => `http://127.0.0.1:${port}/blob/${pathname}`
  const toPathname = (input) => {
    const s = String(input)
    const m = /^\/blob\/(.+)$/.exec(s.replace(/^https?:\/\/[^/]+/, ''))
    return m ? m[1] : s
  }
  const etagOf = (body) => {
    seq += 1
    const hash = require('crypto').createHash('sha1').update(body).digest('hex')
    return `"${hash}-${seq}"`
  }
  const setRaw = (pathname, body, contentType, uploadedAt) => {
    blobs.set(pathname, {
      body,
      contentType: contentType || 'text/plain',
      etag: etagOf(body),
      uploadedAt: uploadedAt || new Date().toISOString(),
    })
  }

  const server = http.createServer((req, res) => {
    const target = decodeURIComponent(String(req.url).split('?')[0])
    const m = /^\/blob\/(.+)$/.exec(target)
    const rec = m && blobs.get(m[1])
    if (!rec) {
      res.statusCode = 404
      res.end('missing')
      return
    }
    res.setHeader('content-type', rec.contentType)
    res.end(rec.body)
  })

  const notFound = (name) => {
    const e = new Error('The requested blob does not exist: ' + name)
    e.name = 'BlobNotFoundError'
    return e
  }

  const api = {
    async put(pathname, body, options = {}) {
      stats.put += 1
      const prev = blobs.get(pathname)
      if (prev && !options.allowOverwrite && !options.ifMatch) {
        const e = new Error('blob already exists')
        e.name = 'BlobError'
        throw e
      }
      if (options.ifMatch && (!prev || prev.etag !== options.ifMatch)) {
        const e = new Error('Precondition failed')
        e.name = 'BlobPreconditionFailedError'
        throw e
      }
      const text = typeof body === 'string' ? body : String(body)
      setRaw(pathname, text, options.contentType, new Date().toISOString())
      const rec = blobs.get(pathname)
      return {
        url: urlOf(pathname),
        downloadUrl: urlOf(pathname),
        pathname,
        contentType: rec.contentType,
        contentDisposition: '',
        cacheControl: '',
        etag: rec.etag,
      }
    },
    async get(pathname, options = {}) {
      stats.get += 1
      const rec = blobs.get(toPathname(pathname))
      if (!rec) return null
      if (options.ifNoneMatch && options.ifNoneMatch === rec.etag) {
        return { statusCode: 304, stream: null, blob: { etag: rec.etag } }
      }
      return {
        statusCode: 200,
        stream: new Response(rec.body).body,
        blob: {
          url: urlOf(toPathname(pathname)),
          etag: rec.etag,
          contentType: rec.contentType,
          size: Buffer.byteLength(rec.body),
        },
      }
    },
    async head(pathname) {
      stats.head += 1
      const rec = blobs.get(toPathname(pathname))
      if (!rec) throw notFound(pathname)
      return {
        url: urlOf(toPathname(pathname)),
        etag: rec.etag,
        size: Buffer.byteLength(rec.body),
        uploadedAt: rec.uploadedAt,
        contentType: rec.contentType,
      }
    },
    async del(input) {
      stats.del += 1
      const list = Array.isArray(input) ? input : [input]
      for (const one of list) blobs.delete(toPathname(one))
    },
    async list(options = {}) {
      stats.list += 1
      const prefix = options.prefix || ''
      const keys = [...blobs.keys()].filter((k) => k.startsWith(prefix)).sort()
      const limit = options.limit || 100
      const start = options.cursor
        ? Number(Buffer.from(options.cursor, 'base64').toString())
        : 0
      const page = keys.slice(start, start + limit)
      const hasMore = start + limit < keys.length
      return {
        blobs: page.map((k) => {
          const rec = blobs.get(k)
          return {
            pathname: k,
            url: urlOf(k),
            size: Buffer.byteLength(rec.body),
            uploadedAt: rec.uploadedAt,
            etag: rec.etag,
            contentType: rec.contentType,
          }
        }),
        cursor: hasMore
          ? Buffer.from(String(start + limit)).toString('base64')
          : null,
        hasMore,
      }
    },
  }

  return { api, stats, blobs, server, setPort: (p) => (port = p), urlOf }
}

describe('ttmlStore（假 Blob）', () => {
  let fake
  let store
  let storePath
  let originalLoad
  let originalToken

  before(async () => {
    fake = makeFakeBlob()
    await new Promise((resolve) => fake.server.listen(0, '127.0.0.1', resolve))
    fake.setPort(fake.server.address().port)

    originalToken = process.env.BLOB_READ_WRITE_TOKEN
    process.env.BLOB_READ_WRITE_TOKEN = 'test-token'
    storePath = require.resolve('../plugins/ttmlStore.js')
    delete require.cache[storePath]

    originalLoad = Module._load
    Module._load = function (request, parent, isMain) {
      if (request === '@vercel/blob') return fake.api
      return originalLoad.call(this, request, parent, isMain)
    }
    store = require(storePath)
  })

  after((done) => {
    Module._load = originalLoad
    delete require.cache[storePath]
    if (originalToken === undefined) delete process.env.BLOB_READ_WRITE_TOKEN
    else process.env.BLOB_READ_WRITE_TOKEN = originalToken
    fake.server.close(done)
  })

  it('首次读老数据时只 list 一次，之后不再 list', async () => {
    const aId = store.ttmlIdOf(TTML_A)
    fake.blobs.set(store.contentKey(aId), {
      body: TTML_A,
      contentType: 'application/ttml+xml',
      etag: '"a"',
      uploadedAt: '2026-10-01T00:00:00.000Z',
    })
    fake.blobs.set(store.bindKey('186016', aId), {
      body: JSON.stringify({ songId: '186016', ttmlId: aId }),
      contentType: 'application/json',
      etag: '"b"',
      uploadedAt: '2026-10-01T00:00:00.000Z',
    })
    fake.blobs.set('ttml/999.ttml', {
      body: TTML_B,
      contentType: 'application/ttml+xml',
      etag: '"c"',
      uploadedAt: '2026-09-01T00:00:00.000Z',
    })

    const hit = await store.load('186016')
    assert.strictEqual(hit.ttmlId, aId)
    assert.strictEqual(fake.stats.list, 1, '建索引只该 list 一次')
    assert.ok(fake.blobs.has(store.INDEX_KEY), '索引应该已经写进 store')

    const before = { ...fake.stats }
    const again = await store.load('186016')
    assert.strictEqual(again.ttmlId, aId)
    assert.strictEqual(fake.stats.list, before.list, '第二次读不该再 list')

    const all = await store.listAll()
    assert.strictEqual(all.items.length, 1)
    assert.strictEqual(all.bindingCount, 1)
    assert.strictEqual(all.legacy.length, 1)
    assert.strictEqual(fake.stats.list, before.list, 'listAll 不该再 list')
  })

  it('保存 / 冲突 / 并发写 / 解绑 / 真删除', async () => {
    const aId = store.ttmlIdOf(TTML_A)
    const bId = store.ttmlIdOf(TTML_B)

    const saved = await store.save(['186016', '200000'], TTML_A)
    assert.strictEqual(saved.blocked, false)
    assert.deepStrictEqual(saved.already, ['186016'])
    assert.deepStrictEqual(saved.bound, ['200000'])
    assert.ok(fake.blobs.has(store.bindKey('200000', aId)), '绑定存档要写')

    const conflict = await store.save(['186016'], TTML_B)
    assert.strictEqual(conflict.blocked, true)
    assert.strictEqual(conflict.conflicts[0].boundTo, aId)
    assert.ok(
      !fake.blobs.has(store.bindKey('186016', bId)),
      '冲突时不该写任何绑定',
    )

    // 模拟另一个实例抢先改索引：本实例缓存是旧的，靠 ifMatch 重试合并
    const raw = await fake.api.get(store.INDEX_KEY)
    const doc = JSON.parse(await new Response(raw.stream).text())
    doc.contents[bId] = {
      ids: ['300000'],
      size: 10,
      uploadedAt: '2026-11-01T00:00:00.000Z',
      url: null,
      pathname: store.contentKey(bId),
    }
    await fake.api.put(store.INDEX_KEY, JSON.stringify(doc), {
      access: 'public',
      allowOverwrite: true,
      ifMatch: raw.blob.etag,
    })

    const merged = await store.save(['400000'], TTML_B)
    assert.strictEqual(merged.blocked, false)
    const idsB = await store.bindingsOfTtml(bId)
    assert.ok(idsB.includes('300000'), '别把并发写进来的 id 覆盖掉')
    assert.ok(idsB.includes('400000'))

    const unbound = await store.unbind('200000', aId)
    assert.strictEqual(unbound.unbound, true)
    assert.strictEqual(unbound.contentDeleted, false)
    assert.ok(!fake.blobs.has(store.bindKey('200000', aId)))

    const last = await store.unbind('186016', aId)
    assert.strictEqual(last.contentDeleted, true)
    assert.ok(!fake.blobs.has(store.contentKey(aId)))

    const destroyed = await store.destroyTtml(bId)
    assert.deepStrictEqual(destroyed.unbound.sort(), ['300000', '400000'])
    assert.ok(!fake.blobs.has(store.contentKey(bId)))
    assert.ok(!fake.blobs.has(store.bindKey('300000', bId)))

    const empty = await store.listAll({ fresh: true })
    assert.strictEqual(empty.items.length, 0)
  })

  it('查不到歌词时不额外打 Blob（不 head、不 list）', async () => {
    store.clearCaches()
    const before = { ...fake.stats }
    const miss = await store.load('123456789')
    assert.strictEqual(miss, null)
    assert.strictEqual(fake.stats.list, before.list, '查不到也不该 list')
    assert.strictEqual(fake.stats.head, before.head, '不该 head 探老格式')
    assert.ok(
      fake.stats.get - before.get <= 1,
      '冷缓存下最多读一次索引：' + (fake.stats.get - before.get),
    )
  })

  it('老格式还能读、能删', async () => {
    const stat = await store.stat('999')
    assert.strictEqual(stat.ttmlId, store.ttmlIdOf(TTML_B))
    const deleted = await store.destroyLegacy('999')
    assert.strictEqual(deleted.deleted, true)
    assert.ok(!fake.blobs.has('ttml/999.ttml'))
  })

  it('索引坏掉时按「不存在」处理，从存档重建（不能当成空索引）', async () => {
    const aId = store.ttmlIdOf(TTML_A)
    await store.save(['600000'], TTML_A)
    fake.blobs.set(store.INDEX_KEY, {
      body: '{"contents": {broken',
      contentType: 'application/json',
      etag: '"broken"',
      uploadedAt: new Date().toISOString(),
    })
    store.clearCaches()

    const hit = await store.load('600000')
    assert.ok(hit, '索引坏了也要能读出来')
    assert.strictEqual(hit.ttmlId, aId)
    const again = await store.listAll({ fresh: true })
    assert.strictEqual(again.items.length, 1, '重建后不该变成空索引')
  })

  it('索引被删掉后能靠绑定存档重建', async () => {
    const aId = store.ttmlIdOf(TTML_A)
    await store.save(['500000'], TTML_A)
    fake.blobs.delete(store.INDEX_KEY)
    store.clearCaches()

    const hit = await store.load('500000')
    assert.ok(hit, '索引丢了也要能读出来')
    assert.strictEqual(hit.ttmlId, aId)
    assert.ok(fake.blobs.has(store.INDEX_KEY), '重建后应该重新写回索引')
  })
})
