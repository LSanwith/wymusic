// /ttml/file?id=186016 —— 按歌曲 id 下载 TTML
//
// 存在的意义：给出去的下载地址是本站域名（……/ttml/file?id=xxx），
// 而不是存储侧的地址。歌词正文现在存在 KV 里，所以这里直接把内容发出去，
// 顺带把 Content-Type 设成 application/ttml+xml（浏览器没有渲染器，会直接存盘）。
//
// 以前正文在 Vercel Blob 上时这里是 302 到 Blob；Blob 被额度停用后
// 换成了 KV，下载地址对外保持不变。
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
        msg: '未配置 KV（缺少 KV_REST_API_URL / KV_REST_API_TOKEN）',
      },
    }
  }

  let hit
  try {
    hit = await ttmlStore.load(id)
  } catch (e) {
    return {
      status: 500,
      body: { code: 500, msg: '读取失败：' + (e.message || e) },
    }
  }
  if (!hit) {
    return {
      status: 404,
      body: {
        code: 404,
        msg: `没有 id=${id} 的 TTML 歌词`,
        upload: '/ttml/',
      },
    }
  }

  return {
    status: 200,
    headers: {
      'content-type': 'application/ttml+xml; charset=utf-8',
      'content-disposition': `attachment; filename="${id}.ttml"`,
    },
    body: hit.ttml,
  }
}
