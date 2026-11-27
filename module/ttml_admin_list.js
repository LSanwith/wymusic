// /ttml/admin/list —— 管理页：列出所有已上传的 TTML 及其绑定的歌曲 id
//
// 这个接口是**公开**的：没有任何密钥，谁都能看到现在有哪些歌词、各绑了哪些歌曲 id。
// 只读，不含歌词正文（正文在 /search?ttml=<歌曲id>，本来就是公开可读的）。
// 删除（/ttml/destroy）才需要管理密码，和这里分开。
const store = require('../plugins/ttmlStore.js')
const createOption = require('../util/option.js')

/** 批量把歌曲 id 换成歌名；失败就返回空表，不影响列表本身 */
async function songNames(ids, query, request) {
  const out = {}
  if (!ids.length || typeof request !== 'function') return out
  const data = {
    c: '[' + ids.map((id) => '{"id":' + Number(id) + '}').join(',') + ']',
  }
  try {
    const resp = await request(
      '/api/v3/song/detail',
      data,
      createOption(query, 'weapi'),
    )
    for (const s of (resp && resp.body && resp.body.songs) || []) {
      out[String(s.id)] = s.name || ''
    }
  } catch {
    /* 上游挂了就不显示歌名 */
  }
  return out
}

module.exports = async (query, request) => {
  if (!store.hasToken()) {
    return {
      status: 501,
      body: {
        code: 501,
        msg: '未配置 KV（缺少 KV_REST_API_URL / KV_REST_API_TOKEN）',
      },
    }
  }

  let data
  try {
    // fresh：管理页点刷新就该看到最新结果（索引本身有 5 分钟缓存）
    data = await store.listAll({ fresh: true })
  } catch (e) {
    return {
      status: 500,
      body: { code: 500, msg: '列出失败：' + (e.message || e) },
    }
  }

  const items = data.items.map((it) => ({
    ttmlId: it.ttmlId,
    // 这份歌词绑定的歌曲 id
    ids: it.ids,
    count: it.ids.length,
    size: it.size,
    uploadedAt: it.uploadedAt,
    url: it.ids.length ? store.downloadUrl(it.ids[0]) : null,
    // 内容已经没了但绑定还在（历史遗留），建议清掉
    orphan: !!it.orphan,
    // 任意一个 id 都能读这份歌词
    api: it.ids.length ? '/search?ttml=' + it.ids[0] : null,
  }))

  // 收集所有 id（含老格式），一次批量换歌名
  const allIds = []
  for (const it of items) for (const id of it.ids) allIds.push(id)
  for (const it of data.legacy || []) allIds.push(String(it.songId))
  const names = await songNames(
    [...new Set(allIds)].slice(0, 60),
    query,
    request,
  )

  return {
    status: 200,
    body: {
      code: 200,
      // 歌曲 id -> 歌名（页面在 id 旁边显示）
      names,
      total: items.length,
      bindingCount: data.bindingCount,
      items,
      // 老格式 ttml/<歌曲id>.ttml，单独列出来
      legacy: data.legacy || [],
      legacyCount: (data.legacy || []).length,
      // 服务端有没有配管理密码：没配的话删除是关闭的，页面据此提示
      canDelete: true,
    },
  }
}
