// 按歌名搜歌，给上传页/预览页做「一键取 id」用
//
// 只读操作，不写任何数据，所以不挂人机验证。
//
// 两个要注意的点：
//   1. 上游搜索有频率限制（连续搜会返回 405 操作频繁）。所以这里把上游的状态码
//      如实翻译出来，前端才好提示用户，而不是笼统报错。
//      另外前端不要加 cache-buster —— server.js 给所有接口挂了 2 分钟缓存，
//      带随机参数会把这层缓存废掉，反而更容易被限流。
//   2. 搜索接口返回的封面经常缺 picUrl，所以再补一次歌曲详情；
//      详情挂了就退回搜索结果本身。
//
// 关键词纯数字时按 id 直查，绕开搜索（更快也不占搜索配额）。
const createOption = require('../util/option.js')

/** 统一成 https 小图，页面是 https 的，http 图会被浏览器拦掉 */
function smallCover(url) {
  const s = String(url || '').trim()
  if (!s) return ''
  return s.replace(/^http:/, 'https:') + '?param=160y160'
}

/** 拉歌曲详情，拿封面/歌手/专辑/时长 */
async function fetchDetails(ids, query, request) {
  if (!ids.length) return []
  const data = {
    c: '[' + ids.map((id) => '{"id":' + Number(id) + '}').join(',') + ']',
  }
  try {
    const resp = await request(
      '/api/v3/song/detail',
      data,
      createOption(query, 'weapi'),
    )
    return (resp && resp.body && resp.body.songs) || []
  } catch (e) {
    return []
  }
}

function shapeFromDetail(d, fallback) {
  const base = fallback || { id: String(d.id), name: '' }
  const artists = (d.ar || [])
    .map((a) => a && a.name)
    .filter(Boolean)
    .join(' / ')
  return {
    id: String(d.id),
    name: d.name || base.name,
    artists: artists || base.artists || '',
    album: (d.al && d.al.name) || base.album || '',
    cover: smallCover(d.al && d.al.picUrl) || base.cover || '',
    durationSec: d.dt ? Math.round(d.dt / 1000) : base.durationSec || null,
  }
}

/** 上游限流 / 报错时，把它的状态码和提示如实带出去 */
function upstreamFailure(resp) {
  const body = (resp && resp.body) || {}
  const msg = String(body.msg || body.message || '')
  if (
    (resp && (resp.status === 405 || resp.status === 429)) ||
    /操作频繁/.test(msg)
  ) {
    return {
      status: 429,
      body: { code: 429, msg: '搜索太频繁了，等几秒再试（上游限流）' },
    }
  }
  return {
    status: 502,
    body: { code: 502, msg: msg || '搜索失败，请稍后再试' },
  }
}

module.exports = async (query, request) => {
  const keywords = String(query.keywords || '').trim()
  if (!keywords) {
    return { status: 400, body: { code: 400, msg: 'keywords 必填' } }
  }
  const limit = Math.min(Math.max(Number(query.limit) || 12, 1), 20)

  // 纯数字：按 id 直查
  if (/^\d{1,20}$/.test(keywords)) {
    const details = await fetchDetails([keywords], query, request)
    if (!details.length) {
      return { status: 404, body: { code: 404, msg: '没有这个 id 的歌曲' } }
    }
    return {
      status: 200,
      body: {
        code: 200,
        keywords,
        byId: true,
        songs: [shapeFromDetail(details[0], { id: keywords, name: '' })],
      },
    }
  }

  let songs = []
  let resp = null
  try {
    resp = await request(
      '/api/search/get',
      { s: keywords, type: 1, limit, offset: 0 },
      createOption(query),
    )
  } catch (e) {
    return { status: 502, body: { code: 502, msg: '搜索失败，请稍后再试' } }
  }
  if (!resp || resp.status !== 200) return upstreamFailure(resp)
  const result = (resp.body && resp.body.result) || {}
  songs = result.songs || []

  if (!songs.length) {
    return { status: 200, body: { code: 200, keywords, songs: [] } }
  }

  // 从搜索结果先拼一份兜底信息
  const fromSearch = new Map(
    songs.map((s) => [
      String(s.id),
      {
        id: String(s.id),
        name: s.name || '',
        artists: (s.artists || [])
          .map((a) => a && a.name)
          .filter(Boolean)
          .join(' / '),
        album: (s.album && s.album.name) || '',
        cover: smallCover(s.album && s.album.picUrl),
        durationSec:
          typeof s.duration === 'number' ? Math.round(s.duration / 1000) : null,
      },
    ]),
  )

  const ids = songs.map((s) => s.id).filter(Boolean)
  const details = await fetchDetails(ids, query, request)
  const byId = new Map(details.map((s) => [String(s.id), s]))

  const out = ids.map((id) => {
    const base = fromSearch.get(String(id)) || { id: String(id), name: '' }
    const d = byId.get(String(id))
    return d ? shapeFromDetail(d, base) : base
  })

  return {
    status: 200,
    body: { code: 200, keywords, songs: out.filter((s) => s.name) },
  }
}
