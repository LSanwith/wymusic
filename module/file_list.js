// 文件挂载代理 · 已上传文件列表 / 删除
//
//   （无参数）         列出已上传的文件（最多 100 个，按上传时间倒序）
//   ?cursor=<游标>     继续翻页
//   ?del=<blob url>    删除指定文件
//
// 依赖 BLOB_READ_WRITE_TOKEN（同 file_upload）。
// 若设置了 FILE_UPLOAD_KEY，本接口同样要求带 ?key= —— 列表会暴露文件地址，
// 删除是破坏性操作，都不适合对陌生人开放。
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
  if (!process.env.BLOB_READ_WRITE_TOKEN) return noToken()

  const gate = process.env.FILE_UPLOAD_KEY
  if (gate && String(query.key || '') !== gate) return gateFail()

  const { list, del } = require('@vercel/blob')
  try {
    if (query.del) {
      await del(String(query.del))
      return { status: 200, body: { code: 200, deleted: String(query.del) } }
    }

    const result = await list({
      limit: 100,
      cursor: query.cursor ? String(query.cursor) : undefined,
    })
    return {
      status: 200,
      body: {
        code: 200,
        hasMore: !!result.hasMore,
        cursor: result.cursor || null,
        blobs: (result.blobs || []).map((b) => ({
          url: b.url,
          pathname: b.pathname,
          size: b.size,
          uploadedAt: b.uploadedAt,
          contentType: b.contentType || '',
        })),
      },
    }
  } catch (e) {
    return { status: 500, body: { code: 500, msg: e.message || '操作失败' } }
  }
}
