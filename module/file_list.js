// 文件挂载代理 · 已上传文件列表 / 删除
//
//   （无参数）         列出已上传的文件（最多 100 个，按上传时间倒序）
//   ?cursor=<偏移量>   继续翻页
//   ?del=<文件名或 url> 删除指定文件
//
// 顺带做两件事：
//   - 惰性清理：每次列表顺手删掉超过 7 天的临时文件（同一实例 10 分钟内只跑一次），
//     这样不配置 Vercel Cron 也能让「7 天有效」真正生效；
//   - 顺带上报公开口令的当月额度用量，供页面显示剩余次数。
//
// 列表 / 额度 / 过期名单全部来自 KV 索引（plugins/fileIndex.js），
// 不再 list Blob —— 那样每刷新一次页面就把 Advanced Operations 打掉几次。
//
// 若设置了 FILE_UPLOAD_KEY，本接口同样要求带 ?key= —— 列表会暴露文件地址，
// 删除是破坏性操作，都不适合对陌生人开放。
const {
  PUB_MONTHLY_LIMIT,
  retentionOf,
  pubUsedThisMonth,
  gcExpired,
} = require('../plugins/fileRetention.js')
const fileIndex = require('../plugins/fileIndex.js')

const GC_INTERVAL_MS = 10 * 60 * 1000
let lastGcAt = 0

/** 惰性 GC：失败不影响列表本身 */
async function maybeGc() {
  if (Date.now() - lastGcAt < GC_INTERVAL_MS) return 0
  lastGcAt = Date.now()
  try {
    return await gcExpired()
  } catch {
    return 0
  }
}

function noKv() {
  return {
    status: 501,
    body: {
      code: 501,
      msg: '未配置 KV（缺少 KV_REST_API_URL / KV_REST_API_TOKEN）',
    },
  }
}

function gateFail() {
  return { status: 403, body: { code: 403, msg: '口令不正确' } }
}

/** 索引条目 -> 页面要的形状 */
function toWire(item) {
  const retention = retentionOf(item.pathname, item.uploadedAt)
  return {
    name: item.name,
    url: item.url,
    // 让浏览器下载而不是内联打开（图片/音频用 url 会直接预览）
    downloadUrl: item.downloadUrl || item.url,
    // 本站短链接：分享出去比 blob.vercel-storage.com 那一长串好看
    shareUrl: '/file/get?n=' + encodeURIComponent(item.name),
    pathname: item.pathname,
    size: item.size,
    uploadedAt: item.uploadedAt,
    contentType: item.contentType,
    retention: retention.kind,
    retentionLabel: retention.label,
    expiresAt: retention.expiresAt || null,
  }
}

/** 真删：先删 Blob 本体，成功了再删索引（删失败就留着，下次还能重试） */
async function removeOne(nameOrUrl) {
  const name = await fileIndex.resolveName(nameOrUrl)
  if (!name) return { ok: false, msg: '没有指定要删的文件' }
  const item = await fileIndex.get(name)
  if (!item) return { ok: false, msg: '这个文件不在列表里（可能已被清理）' }

  if (item.url) {
    const { del } = require('@vercel/blob')
    await del(item.url)
  }
  await fileIndex.remove(name)
  return { ok: true, name }
}

module.exports = async (query) => {
  if (!fileIndex.hasKv()) return noKv()

  const gate = process.env.FILE_UPLOAD_KEY
  if (gate && String(query.key || '') !== gate) return gateFail()

  try {
    if (query.del) {
      const removed = await removeOne(String(query.del))
      if (!removed.ok) {
        return { status: 404, body: { code: 404, msg: removed.msg } }
      }
      return { status: 200, body: { code: 200, deleted: removed.name } }
    }

    const cleaned = await maybeGc()

    let page
    try {
      page = await fileIndex.list({
        limit: 100,
        cursor: query.cursor ? String(query.cursor) : undefined,
      })
    } catch (e) {
      return {
        status: 500,
        body: { code: 500, msg: e.message || '读取列表失败' },
      }
    }

    let used = null
    try {
      used = await pubUsedThisMonth()
    } catch {
      // 额度信息拿不到不影响列表
    }

    return {
      status: 200,
      body: {
        code: 200,
        hasMore: page.hasMore,
        cursor: page.cursor,
        cleaned,
        quota: {
          limit: PUB_MONTHLY_LIMIT,
          used,
          left: used === null ? null : Math.max(0, PUB_MONTHLY_LIMIT - used),
        },
        blobs: page.items.map(toWire),
      },
    }
  } catch (e) {
    return { status: 500, body: { code: 500, msg: e.message || '操作失败' } }
  }
}
