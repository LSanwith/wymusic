// fileIndex 的离线单测：假 KV + 假 Blob。
//
// 重点验证「文件列表 / 公开额度 / 7 天清理不再 list Blob」这条线，
// 以及同名覆盖、按 url 删除、迁移这些边界。
const assert = require('assert')
const Module = require('module')
const { makeFakeKv, makeFakeBlob } = require('./_fake_kv.js')

const DAY = 24 * 3600 * 1000
const iso = (ms) => new Date(ms).toISOString()

describe('fileIndex（假 KV）', () => {
  let kv
  let fakeBlob
  let index
  let retention
  let originalLoad
  let originalEnv

  before(async () => {
    kv = makeFakeKv()
    await new Promise((r) => kv.server.listen(0, '127.0.0.1', r))

    originalEnv = {
      url: process.env.KV_REST_API_URL,
      token: process.env.KV_REST_API_TOKEN,
      blob: process.env.BLOB_READ_WRITE_TOKEN,
    }
    process.env.KV_REST_API_URL = `http://127.0.0.1:${kv.server.address().port}`
    process.env.KV_REST_API_TOKEN = 'fake-token'
    process.env.BLOB_READ_WRITE_TOKEN = 'fake-blob-token'

    fakeBlob = makeFakeBlob()
    originalLoad = Module._load
    Module._load = function (request, parent, isMain) {
      if (request === '@vercel/blob') return fakeBlob.api
      return originalLoad.call(this, request, parent, isMain)
    }

    for (const mod of [
      '../plugins/fileIndex.js',
      '../plugins/fileRetention.js',
    ]) {
      delete require.cache[require.resolve(mod)]
    }
    index = require('../plugins/fileIndex.js')
    retention = require('../plugins/fileRetention.js')
  })

  after((done) => {
    Module._load = originalLoad
    delete require.cache[require.resolve('../plugins/fileIndex.js')]
    delete require.cache[require.resolve('../plugins/fileRetention.js')]
    for (const [key, value] of [
      ['KV_REST_API_URL', originalEnv.url],
      ['KV_REST_API_TOKEN', originalEnv.token],
      ['BLOB_READ_WRITE_TOKEN', originalEnv.blob],
    ]) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    kv.server.close(done)
  })

  it('登记后可查，列表按上传时间倒序', async () => {
    await index.clear()
    await index.put({
      name: 'old.txt',
      pathname: 'tmp/old.txt',
      url: 'https://blob.invalid/tmp/old.txt',
      size: 10,
      contentType: 'text/plain',
      uploadedAt: iso(Date.now() - 2 * DAY),
      tier: 'temp',
    })
    await index.put({
      name: 'new.txt',
      pathname: 'keep-vip/new.txt',
      url: 'https://blob.invalid/keep-vip/new.txt',
      size: 20,
      contentType: 'text/plain',
      uploadedAt: iso(Date.now() - DAY),
      tier: 'vip',
    })

    const got = await index.get('new.txt')
    assert.strictEqual(got.name, 'new.txt')
    assert.strictEqual(got.tier, 'vip')
    assert.strictEqual(got.size, 20)

    const page = await index.list({ limit: 10 })
    assert.deepStrictEqual(
      page.items.map((it) => it.name),
      ['new.txt', 'old.txt'],
    )
    assert.strictEqual(page.hasMore, false)

    const first = await index.list({ limit: 1 })
    assert.deepStrictEqual(
      first.items.map((it) => it.name),
      ['new.txt'],
    )
    assert.strictEqual(first.hasMore, true)
    const next = await index.list({ limit: 1, cursor: first.cursor })
    assert.deepStrictEqual(
      next.items.map((it) => it.name),
      ['old.txt'],
    )
  })

  it('同名覆盖：旧链接映射被清掉，公开额度不重复计数', async () => {
    await index.clear()
    const base = {
      name: 'same.bin',
      size: 1,
      contentType: 'application/octet-stream',
      uploadedAt: iso(Date.now()),
    }
    await index.put({
      ...base,
      pathname: 'keep-pub/same.bin',
      url: 'https://blob.invalid/keep-pub/same.bin',
      tier: 'pub',
    })
    assert.strictEqual(await index.pubUsedThisMonth(), 1)

    // 同名重新上传：换到 tmp，旧的 URL 映射应该失效
    await index.put({
      ...base,
      pathname: 'tmp/same.bin',
      url: 'https://blob.invalid/tmp/same.bin',
      tier: 'temp',
    })
    assert.strictEqual(await index.pubUsedThisMonth(), 0)
    assert.strictEqual(
      await index.resolveName('https://blob.invalid/tmp/same.bin'),
      'same.bin',
    )
    assert.strictEqual(
      await index.resolveName('https://blob.invalid/keep-pub/same.bin'),
      null,
    )
  })

  it('公开额度按东八区自然月统计', async () => {
    await index.clear()
    const now = new Date()
    const thisMonth = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 2),
    )
    const lastMonth = new Date(thisMonth.getTime() - 40 * DAY)
    for (const [name, at] of [
      ['a.bin', thisMonth],
      ['b.bin', lastMonth],
    ]) {
      await index.put({
        name,
        pathname: 'keep-pub/' + name,
        url: 'https://blob.invalid/keep-pub/' + name,
        uploadedAt: iso(at.getTime()),
        tier: 'pub',
      })
    }
    const used = await index.pubUsedThisMonth()
    assert.strictEqual(used, 1, '只有本月的那个文件算额度')
  })

  it('7 天过期名单只取临时文件', async () => {
    await index.clear()
    await index.put({
      name: 'expired.bin',
      pathname: 'tmp/expired.bin',
      url: 'https://blob.invalid/tmp/expired.bin',
      uploadedAt: iso(Date.now() - 8 * DAY),
      tier: 'temp',
    })
    await index.put({
      name: 'fresh.bin',
      pathname: 'tmp/fresh.bin',
      url: 'https://blob.invalid/tmp/fresh.bin',
      uploadedAt: iso(Date.now() - 1 * DAY),
      tier: 'temp',
    })
    await index.put({
      name: 'vip.bin',
      pathname: 'keep-vip/vip.bin',
      url: 'https://blob.invalid/keep-vip/vip.bin',
      uploadedAt: iso(Date.now() - 30 * DAY),
      tier: 'vip',
    })

    const expired = await index.expiredTemps(Date.now(), 100)
    assert.deepStrictEqual(
      expired.map((it) => it.name),
      ['expired.bin'],
    )
  })

  it('GC 会删掉 Blob 本体和索引条目', async () => {
    await index.clear()
    fakeBlob.files.clear()
    fakeBlob.files.set('tmp/expired.bin', {
      text: 'x',
      contentType: 'text/plain',
      uploadedAt: iso(Date.now() - 8 * DAY),
    })
    await index.put({
      name: 'expired.bin',
      pathname: 'tmp/expired.bin',
      url: 'https://blob.invalid/tmp/expired.bin',
      uploadedAt: iso(Date.now() - 8 * DAY),
      tier: 'temp',
    })

    const deleted = await retention.gcExpired(10)
    assert.strictEqual(deleted, 1)
    assert.strictEqual(fakeBlob.files.has('tmp/expired.bin'), false)
    assert.strictEqual(await index.get('expired.bin'), null)
  })

  it('删除可以按文件名，也可以按老的 blob url', async () => {
    await index.clear()
    await index.put({
      name: 'by-name.txt',
      pathname: 'tmp/by-name.txt',
      url: 'https://blob.invalid/tmp/by-name.txt',
      tier: 'temp',
    })
    await index.put({
      name: 'by-url.txt',
      pathname: 'tmp/by-url.txt',
      url: 'https://blob.invalid/tmp/by-url.txt',
      tier: 'temp',
    })
    assert.strictEqual((await index.remove('by-name.txt')).name, 'by-name.txt')
    assert.strictEqual(
      (await index.remove('https://blob.invalid/tmp/by-url.txt')).name,
      'by-url.txt',
    )
    assert.deepStrictEqual((await index.list({})).items, [])
  })

  it('迁移：三个前缀的文件都登记进索引', async () => {
    await index.clear()
    fakeBlob.files.clear()
    fakeBlob.files.set('tmp/a.txt', {
      text: 'a',
      contentType: 'text/plain',
      uploadedAt: iso(Date.now() - DAY),
    })
    fakeBlob.files.set('keep-pub/b.txt', {
      text: 'b',
      contentType: 'text/plain',
      uploadedAt: iso(Date.now() - 2 * DAY),
    })
    fakeBlob.files.set('keep-vip/c.txt', {
      text: 'c',
      contentType: 'text/plain',
      uploadedAt: iso(Date.now() - 3 * DAY),
    })

    const moved = await index.migrateFromBlob()
    assert.strictEqual(moved.files, 3)

    const page = await index.list({ limit: 10 })
    assert.deepStrictEqual(
      page.items.map((it) => it.name),
      ['a.txt', 'b.txt', 'c.txt'],
    )
    assert.strictEqual(await index.pubUsedThisMonth(), 1)
    assert.strictEqual((await index.get('c.txt')).tier, 'vip')

    // 幂等：再跑一次不会重复
    const again = await index.migrateFromBlob()
    assert.strictEqual(again.files, 3)
    assert.strictEqual((await index.list({ limit: 10 })).items.length, 3)
  })
})
