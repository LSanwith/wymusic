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

  // Apple Music 的形状：{ data: [{ id, type, attributes: { playParams, ttmlLocalizations } }] }
  // 对标 Apple 的 syllable-lyrics 资源，方便直接对接吃 Apple TTML 的客户端。
  // 注意 id 仍是本接口的网易云 id（Apple 的 catalogId 是人家的目录号，这里没有对应关系）。
  if (
    query.format === 'apple' ||
    query.apple === '1' ||
    query.apple === 'true'
  ) {
    const langMatch = hit.ttml.match(/xml:lang\s*=\s*["']([^"']+)["']/i)
    const lang = (langMatch && langMatch[1]) || 'zh'
    return {
      status: 200,
      body: {
        data: [
          {
            id,
            type: 'syllable-lyrics',
            attributes: {
              playParams: {
                catalogId: id,
                // 3 = 逐字/逐音节歌词（Apple 的 displayType 取值）
                displayType: 3,
                id: `AP_${id}-${lang}`,
                kind: 'lyric',
              },
              language: lang,
              ttmlLocalizations: hit.ttml,
            },
          },
        ],
      },
    }
  }

  // 同一份 TTML 还绑着哪些别的歌曲 id。
  // 把自己也并进去再排除掉，这样即使 list 有延迟、暂时没列出自己，结果也是准的。
  let siblings = []
  try {
    siblings = await ttmlStore.bindingsOfTtml(hit.ttmlId)
  } catch {
    siblings = []
  }
  const allIds = [...new Set([String(id), ...siblings.map(String)])]
  const otherId = allIds.filter((x) => x !== String(id))

  return {
    status: 200,
    body: {
      code: 200,
      id,
      // 这份歌词自己的身份（内容哈希）。一份 TTML 可以绑多个歌曲 id，
      // 绑到别的 id 上时 ttmlId 不变 —— 对外请求仍按歌曲 id
      ttmlId: hit.ttmlId,
      // 同一份 TTML 绑定的其它歌曲 id
      otherId,
      ttml: hit.ttml,
      // 对外给本站域名的下载地址；blobUrl 留着方便排查
      url: ttmlStore.downloadUrl(id),
      blobUrl: hit.url,
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
