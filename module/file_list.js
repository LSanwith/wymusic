// 文件挂载代理 · 已上传文件列表 / 删除
//
//   （无参数）         列出已上传的文件（最多 100 个，按上传时间倒序）
//   ?cursor=<游标>     继续翻页
//   ?del=<blob url>    删除指定文件
//
// 顺带做两件事：
//   - 惰性清理：每次列表顺手删掉超过 7 天的临时文件（同一实例 10 分钟内只跑一次），
//     这样不配置 Vercel Cron 也能让「7 天有效」真正生效；
//   - 顺带上报公开口令的当月额度用量，供页面显示剩余次数。
//
// 依赖 BLOB_READ_WRITE_TOKEN（同 file_upload）。
// 若设置了 FILE_UPLOAD_KEY，本接口同样要求带 ?key= —— 列表会暴露文件地址，
// 删除是破坏性操作，都不适合对陌生人开放。
const {
  PUB_MONTHLY_LIMIT,
  retentionOf,
  pubUsedThisMonth,
  gcExpired,
} = require('../plugins/fileRetention.js')
const { guard } = require('../plugins/filePass.js')

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

function noToken() {
  return {
    status: 501,
    body: {
      code: 501,
      msg: '未配置 Vercel Blob（缺少 BLOB_READ_WRITE_TOKEN）',
    },
  }
}

function gateFail() {
  return { status: 403, body: { code: 403, msg: '口令不正确' } }
}

module.exports = async (query) => {
  const denied = guard(query)
  if (denied) return denied

  if (!process.env.BLOB_READ_WRITE_TOKEN) return noToken()

  const gate = process.env.FILE_UPLOAD_KEY
  if (gate && String(query.key || '') !== gate) return gateFail()

  const { list, del } = require('@vercel/blob')
  try {
    if (query.del) {
      await del(String(query.del))
      return { status: 200, body: { code: 200, deleted: String(query.del) } }
    }

    const cleaned = await maybeGc()

    const result = await list({
      limit: 100,
      cursor: query.cursor ? String(query.cursor) : undefined,
    })

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
        hasMore: !!result.hasMore,
        cursor: result.cursor || null,
        cleaned,
        quota: {
          limit: PUB_MONTHLY_LIMIT,
          used,
          left: used === null ? null : Math.max(0, PUB_MONTHLY_LIMIT - used),
        },
        blobs: (result.blobs || []).map((b) => {
          const retention = retentionOf(b.pathname, b.uploadedAt)
          const base = String(b.pathname || '')
            .split('/')
            .pop()
          return {
            url: b.url,
            // 让浏览器下载而不是内联打开（图片/音频用 url 会直接预览）
            downloadUrl: b.downloadUrl || b.url,
            // 本站短链接：分享出去比 blob.vercel-storage.com 那一长串好看
            shareUrl: '/file/get?n=' + encodeURIComponent(base),
            pathname: b.pathname,
            size: b.size,
            uploadedAt: b.uploadedAt,
            contentType: b.contentType || '',
            retention: retention.kind,
            retentionLabel: retention.label,
            expiresAt: retention.expiresAt || null,
          }
        }),
      },
    }
  } catch (e) {
    return { status: 500, body: { code: 500, msg: e.message || '操作失败' } }
  }
}
