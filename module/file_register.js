// 文件挂载代理 · 上传完成登记
//
//   GET/POST /file/register?pathname=tmp/待机时钟.sb3[&key=…][&pass=…]
//
// 浏览器的 @vercel/blob/client 把文件直传到 Blob 之后调一下这里，
// 服务端 head 一次拿到权威的 url / 大小 / 上传时间，写进 KV 索引
// （文件列表、公开额度、7 天 GC 都靠这份索引，不再 list Blob）。
//
// 为什么不由 blob.upload-completed 回调来做：模块体系里拿不到请求体，
// 而回调的信息全在 body 里；页面自己调一次更直接，也方便失败重试。
const fileIndex = require('../plugins/fileIndex.js')
const { guard } = require('../plugins/filePass.js')

module.exports = async (query) => {
  const denied = guard(query)
  if (denied) return denied

  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    return {
      status: 501,
      body: {
        code: 501,
        msg: '未配置 Vercel Blob（缺少 BLOB_READ_WRITE_TOKEN）',
      },
    }
  }
  if (!fileIndex.hasKv()) {
    return {
      status: 501,
      body: {
        code: 501,
        msg: '未配置 KV（缺少 KV_REST_API_URL / KV_REST_API_TOKEN）',
      },
    }
  }

  const gate = process.env.FILE_UPLOAD_KEY
  if (gate && String(query.key || '') !== gate) {
    return { status: 403, body: { code: 403, msg: '上传口令不正确' } }
  }

  const pathname = String(query.pathname || '')
  if (!/^(tmp|keep-pub|keep-vip)\/[^/]{1,180}$/.test(pathname)) {
    return {
      status: 400,
      body: {
        code: 400,
        msg: 'pathname 必须形如 tmp/文件名、keep-pub/文件名 或 keep-vip/文件名',
      },
    }
  }

  const { head } = require('@vercel/blob')
  let meta
  try {
    meta = await head(pathname)
  } catch (e) {
    return {
      status: 404,
      body: {
        code: 404,
        msg: '没在 Blob 里找到这个文件（上传可能没成功）：' + (e.message || e),
      },
    }
  }
  if (!meta || !meta.url) {
    return { status: 404, body: { code: 404, msg: '没在 Blob 里找到这个文件' } }
  }

  const item = await fileIndex.put({
    name: fileIndex.baseName(pathname),
    pathname,
    url: meta.url,
    downloadUrl: meta.downloadUrl || meta.url,
    size: meta.size,
    contentType: meta.contentType,
    uploadedAt: meta.uploadedAt,
    tier: fileIndex.tierOfPathname(pathname),
  })

  return { status: 200, body: { code: 200, item } }
}
