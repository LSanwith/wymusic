// /ttml/admin —— 后台：列出所有已上传的 TTML 及其绑定的歌曲 id
//
// 只读，但内容和绑定关系全都在这里，所以照样过人机验证。
const store = require('../plugins/ttmlStore.js')
const filePass = require('../plugins/filePass.js')

module.exports = async (query) => {
  const denied = filePass.guard(query)
  if (denied) return denied

  if (!store.hasToken()) {
    return {
      status: 501,
      body: {
        code: 501,
        msg: '未配置 Vercel Blob（缺少 BLOB_READ_WRITE_TOKEN）',
      },
    }
  }

  let data
  try {
    data = await store.listAll()
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

  return {
    status: 200,
    body: {
      code: 200,
      total: items.length,
      bindingCount: data.bindingCount,
      items,
      // 老格式 ttml/<歌曲id>.ttml，单独列出来
      legacy: data.legacy || [],
      legacyCount: (data.legacy || []).length,
    },
  }
}
