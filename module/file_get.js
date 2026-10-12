// 文件挂载代理 · 短链接下载
//
//   GET /file/get?n=<文件名>
//
// 把 https://www.sanwith.cc.cd/file/get?n=待机时钟.sb3 302 到 Blob 的真实地址。
// 好处是分享出去的链接是自己域名下的、短且干净；文件名仍由 Blob 侧的
// downloadUrl 决定（上传时已关掉随机后缀，所以就是原文件名）。
//
// 同名文件若存在多个目录，按 私有 > 公开 > 临时 的顺序取第一个。
const { PREFIX } = require('../plugins/fileRetention.js')

/** 只取文件名，去掉目录与 .. / 反斜杠，避免探测其它路径 */
function baseName(input) {
  const parts = String(input || '')
    .replace(/\\/g, '/')
    .split('/')
    .filter((s) => s && s !== '.' && s !== '..')
  const last = parts.pop()
  // 注意：没有合法片段时 pop() 得到 undefined，不能直接 .slice
  return last ? last.slice(0, 200) : ''
}

module.exports = async (query) => {
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    return {
      status: 501,
      body: {
        code: 501,
        msg: '未配置 Vercel Blob（缺少 BLOB_READ_WRITE_TOKEN）',
      },
    }
  }

  const name = baseName(query.n)
  if (!name) {
    return { status: 400, body: { code: 400, msg: '缺少参数 n（文件名）' } }
  }

  const { head } = require('@vercel/blob')
  for (const folder of [PREFIX.vip, PREFIX.pub, PREFIX.temp]) {
    try {
      const blob = await head(folder + name)
      if (blob && (blob.downloadUrl || blob.url)) {
        return {
          status: 302,
          body: '',
          redirectUrl: blob.downloadUrl || blob.url,
        }
      }
    } catch {
      // 这个目录里没有，继续试下一个
    }
  }

  return {
    status: 404,
    body: { code: 404, msg: '文件不存在或已过期（临时文件 7 天后会被清理）' },
  }
}
