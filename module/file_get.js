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

  return { status: 302, body: '', redirectUrl: target }
}
