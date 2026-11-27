// 文件挂载代理 · 短链接下载
//
//   GET /file/get?n=<文件名>
//
// 把 https://sanwith.de5.net/file/get?n=待机时钟.sb3 302 到 Blob 的真实地址。
// 好处是分享出去的链接是自己域名下的、短且干净。
//
// 地址从 KV 索引里查（一次 HGET），不再对三个目录轮流 head ——
// 那样每下载一次要 3 次 Simple Operation，而且 Blob 额度超了就直接 403。
const fileIndex = require('../plugins/fileIndex.js')
const blobStore = require('../plugins/blobStore.js')

module.exports = async (query) => {
  if (!fileIndex.hasKv()) {
    return {
      status: 501,
      body: {
        code: 501,
        msg: '未配置 KV（缺少 KV_REST_API_URL / KV_REST_API_TOKEN）',
      },
    }
  }

  const name = fileIndex.baseName(query.n)
  if (!name) {
    return { status: 400, body: { code: 400, msg: '缺少参数 n（文件名）' } }
  }

  const item = await fileIndex.get(name)
  const target = item && (item.downloadUrl || item.url)
  if (!target) {
    return {
      status: 404,
      body: {
        code: 404,
        msg: '文件不存在或已过期（临时文件 7 天后会被清理）',
      },
    }
  }

  // 自建存储模式下，blob 地址要带令牌才能读，不能直接 302 给浏览器，
  // 由这里代理一次把字节转发出去。Vercel Blob 模式仍然是 302（更省流量）。
  if (blobStore.isRemote()) {
    let res
    try {
      res = await blobStore.get(target)
    } catch (e) {
      return {
        status: 502,
        body: { code: 502, msg: '存储服务不可用：' + (e.message || e) },
      }
    }
    if (!res || !res.ok) {
      return { status: 404, body: { code: 404, msg: '文件已不存在' } }
    }
    const buf = Buffer.from(await res.arrayBuffer())
    return {
      status: 200,
      headers: {
        'content-type': item.contentType || 'application/octet-stream',
        'content-length': String(buf.length),
        'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
      },
      body: buf,
    }
  }

  return { status: 302, body: '', redirectUrl: target }
}
