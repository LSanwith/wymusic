// /ttml/file?id=186016 —— 按歌曲 id 下载 TTML
//
// 存在的意义：给出去的下载地址是本站域名（……/ttml/file?id=xxx），
// 而不是 Blob 的随机子域（hbw16hh5qr9i4tgm.public.blob.vercel-storage.com）。
// 这里负责 302 到真正的 Blob。
//
// Blob 那边 Content-Type 是 application/ttml+xml，浏览器没有渲染器，会直接存盘。
const ttmlStore = require('../plugins/ttmlStore.js')

module.exports = async (query) => {
  const id = String(query.id == null ? query.ttml || '' : query.id).trim()

  if (!ttmlStore.isValidId(id)) {
    return {
      status: 400,
      body: { code: 400, msg: 'id 必须是网易云歌曲 id（纯数字）' },
    }
  }
  if (!ttmlStore.hasToken()) {
    return {
      status: 501,
      body: {
        code: 501,
        msg: '未配置 Vercel Blob（缺少 BLOB_READ_WRITE_TOKEN）',
      },
    }
  }

  let meta
  try {
    meta = await ttmlStore.stat(id)
  } catch (e) {
    return {
      status: 500,
      body: { code: 500, msg: '读取失败：' + (e.message || e) },
    }
  }
  if (!meta) {
    return {
      status: 404,
      body: {
        code: 404,
        msg: `没有 id=${id} 的 TTML 歌词`,
        upload: '/ttml/',
      },
    }
  }

  return { status: 302, body: '', redirectUrl: meta.url }
}
