// ttmlStore 的离线单测：用一个假 Upstash REST 服务替代真 KV。
//
// 重点验证三件事：
//   1. 读一份歌词只用点查（GET），不再有 list 这种「高级操作」；
//   2. 保存 / 冲突 / 并发绑定 / 解绑 / 真删除的行为和以前一致；
//   3. Blob 时代的老数据能通过 migrateFromBlob 搬进来。
//
// 这个文件不联网、不需要任何 token，`pnpm test` 时会一起跑。
const assert = require('assert')
const http = require('http')
const Module = require('module')
const path = require('path')

const TTML_A =
  '<?xml version="1.0"?><tt xmlns="http://www.w3.org/ns/ttml"><body><div>' +
  '<p begin="00:00:01.000" end="00:00:03.000">a</p></div></body></tt>'
const TTML_B = TTML_A.replace('>a<', '>b<')
const TTML_L = TTML_A.replace('>a<', '>legacy<')

const { makeFakeKv, makeFakeBlob } = require('./_fake_kv.js')

describe('ttmlStore（假 KV）', () => {
  let kv
  let fakeBlob
  let store
  let storePath
  let originalLoad
  let originalEnv

  before(async () => {
    kv = makeFakeKv()
    await new Promise((r) => kv.server.listen(0, '127.0.0.1', r))
    const port = kv.server.address().port

    originalEnv = {
      url: process.env.KV_REST_API_URL,
      token: process.env.KV_REST_API_TOKEN,
      blob: process.env.BLOB_READ_WRITE_TOKEN,
    }
    process.env.KV_REST_API_URL = `http://127.0.0.1:${port}`
    process.env.KV_REST_API_TOKEN = 'fake-token'
    process.env.BLOB_READ_WRITE_TOKEN = 'fake-blob-token'

    fakeBlob = makeFakeBlob()
    storePath = require.resolve('../plugins/ttmlStore.js')
    delete require.cache[storePath]

    originalLoad = Module._load
    Module._load = function (request, parent, isMain) {
      if (request === '@vercel/blob') return fakeBlob.api
      return originalLoad.call(this, request, parent, isMain)
    }
    store = require(storePath)
  })

  after((done) => {
    Module._load = originalLoad
    delete require.cache[storePath]
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

  it('保存后可读，且读只用点查（没有 list 这种操作）', async () => {
    store.clearCaches()
    const aId = store.ttmlIdOf(TTML_A)

    const saved = await store.save(['186016', '200000'], TTML_A)
    assert.strictEqual(saved.blocked, false)
    assert.deepStrictEqual(saved.bound, ['186016', '200000'])

    const commandsBefore = kv.stats.commands
    const hit = await store.load('186016')
    assert.strictEqual(hit.ttmlId, aId)
    assert.strictEqual(hit.ttml, TTML_A)
    // 冷缓存：GET song + (GET content + GET meta) = 3 条命令，一次往返
    assert.ok(
      kv.stats.commands - commandsBefore <= 3,
      '读一份歌词不该超过 3 条命令：' + (kv.stats.commands - commandsBefore),
    )

    const commandsWarm = kv.stats.commands
    await store.load('186016')
    assert.strictEqual(
      kv.stats.commands,
      commandsWarm,
      '热缓存下读同一份歌词应该是 0 条命令',
    )

    assert.deepStrictEqual(await store.bindingsOfTtml(aId), [
      '186016',
      '200000',
    ])
    const all = await store.listAll()
    assert.strictEqual(all.items.length, 1)
    assert.strictEqual(all.bindingCount, 2)
  })

  it('查不到的歌曲不会写出任何东西，也不会反复查 KV', async () => {
    store.clearCaches()
    const commandsBefore = kv.stats.commands
    assert.strictEqual(await store.load('123456789'), null)
    const first = kv.stats.commands - commandsBefore
    assert.ok(first <= 4, '查不到最多 4 条命令（song + legacy 两对）：' + first)

    const commandsAfter = kv.stats.commands
    assert.strictEqual(await store.load('123456789'), null)
    assert.strictEqual(
      kv.stats.commands,
      commandsAfter,
      '「没有」也要缓存，别每个请求都打 KV',
    )
  })

  it('冲突检测：一个歌曲 id 不能同时绑两份', async () => {
    const bId = store.ttmlIdOf(TTML_B)
    const conflict = await store.save(['186016'], TTML_B)
    assert.strictEqual(conflict.blocked, true)
    assert.strictEqual(conflict.conflicts[0].boundTo, store.ttmlIdOf(TTML_A))
    assert.strictEqual(
      kv.strings.get('ttml:song:186016'),
      store.ttmlIdOf(TTML_A),
    )

    // 同一份内容再提交：already，不算冲突
    const again = await store.save(['186016'], TTML_A)
    assert.strictEqual(again.blocked, false)
    assert.deepStrictEqual(again.already, ['186016'])
    assert.deepStrictEqual(again.bound, [])
    assert.ok(!(kv.sets.get('ttml:ids') || new Set()).has(bId))
  })

  it('解绑 / 最后一条解绑回收正文 / 真删除', async () => {
    const aId = store.ttmlIdOf(TTML_A)

    const one = await store.unbind('200000', aId)
    assert.strictEqual(one.unbound, true)
    assert.strictEqual(one.contentDeleted, false)
    assert.deepStrictEqual(await store.bindingsOfTtml(aId), ['186016'])

    const last = await store.unbind('186016', aId)
    assert.strictEqual(last.contentDeleted, true)
    assert.strictEqual(kv.strings.has(`ttml:content:${aId}`), false)

    // 真删除：绑了两个 id，删完两边都没了
    const bId = store.ttmlIdOf(TTML_B)
    await store.save(['300000', '400000'], TTML_B)
    const destroyed = await store.destroyTtml(bId)
    assert.deepStrictEqual(destroyed.unbound, ['300000', '400000'])
    assert.strictEqual(destroyed.contentDeleted, true)
    assert.strictEqual(kv.strings.has('ttml:song:300000'), false)
    assert.strictEqual((await store.listAll()).items.length, 0)
  })

  it('老格式数据可读、可删', async () => {
    kv.strings.set('ttml:legacy:999', TTML_L)
    kv.sets.set('ttml:legacy:ids', new Set(['999']))
    store.clearCaches()

    const hit = await store.load('999')
    assert.ok(hit && hit.legacy)
    assert.strictEqual(hit.ttmlId, store.ttmlIdOf(TTML_L))

    const out = await store.destroyLegacy('999')
    assert.strictEqual(out.deleted, true)
    assert.strictEqual(kv.strings.has('ttml:legacy:999'), false)
  })

  it('能把 Blob 时代的数据迁移进来', async () => {
    const aId = store.ttmlIdOf(TTML_A)
    fakeBlob.files.set('ttml/c/' + aId + '.ttml', {
      text: TTML_A,
      uploadedAt: '2026-10-01T00:00:00.000Z',
    })
    fakeBlob.files.set('ttml/b/186016--' + aId + '.json', {
      text: '{}',
      uploadedAt: '2026-10-01T00:00:00.000Z',
    })
    fakeBlob.files.set('ttml/888.ttml', {
      text: TTML_L,
      uploadedAt: '2026-09-01T00:00:00.000Z',
    })

    store.clearCaches()
    const moved = await store.migrateFromBlob()
    assert.strictEqual(moved.contents, 1)
    assert.strictEqual(moved.bindings, 1)
    assert.strictEqual(moved.legacy, 1)

    const hit = await store.load('186016')
    assert.strictEqual(hit.ttmlId, aId)
    assert.strictEqual(hit.uploadedAt, '2026-10-01T00:00:00.000Z')
    const legacy = await store.load('888')
    assert.ok(legacy && legacy.legacy)
  })
})
