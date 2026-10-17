// 搜索

const createOption = require('../util/option.js')
const ttmlStore = require('../plugins/ttmlStore.js')

/**
 * TTML 歌词读取（本项目自定义扩展）。
 *
 *   GET /search?ttml=<网易云歌曲id>          返回 JSON（含 ttml 原文）
 *   GET /search?ttml=<网易云歌曲id>&raw=1    302 到 Blob 原文，拿到正确的 TTML MIME
 *
 * 歌词由 /ttml/ 页面上传、经 AI 审核后入 Blob，见 plugins/ttmlStore.js。
 * 注意：这是加在上游文件里的钩子，上游同步时保留这一段（同 server.js 里
 * /song/url/v1 那处自定义修复的处理方式）。
 */
async function readTtml(query) {
  const id = String(query.ttml || '').trim()
  if (!ttmlStore.isValidId(id)) {
    return {
      status: 400,
      body: {
        code: 400,
        msg: 'ttml 参数必须是网易云歌曲 id（纯数字）',
        demo: '/ttml/demo/',
      },
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

  // raw 模式直接跳 Blob：那边 Content-Type 是 application/ttml+xml，
  // 比在经过本接口时被强制成 application/json 更规范
  if (query.raw === '1' || query.raw === 'true') {
    return { status: 302, body: '', redirectUrl: hit.url }
  }

  return {
    status: 200,
    body: {
      code: 200,
      id,
      ttml: hit.ttml,
      url: hit.url,
      size: hit.size,
      uploadedAt: hit.uploadedAt,
    },
  }
}

module.exports = (query, request) => {
  if (query.ttml != null && query.ttml !== '') return readTtml(query)

  if (query.type && query.type == '2000') {
    const data = {
      keyword: query.keywords,
      scene: 'normal',
      limit: query.limit || 30,
      offset: query.offset || 0,
    }
    return request(`/api/search/voice/get`, data, createOption(query))
  }
  const data = {
    s: query.keywords,
    type: query.type || 1, // 1: 单曲, 10: 专辑, 100: 歌手, 1000: 歌单, 1002: 用户, 1004: MV, 1006: 歌词, 1009: 电台, 1014: 视频
    limit: query.limit || 30,
    offset: query.offset || 0,
  }
  return request(`/api/search/get`, data, createOption(query))
}
