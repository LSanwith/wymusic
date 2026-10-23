// /ttml/admin/list —— 管理页：列出所有已上传的 TTML 及其绑定的歌曲 id
//
// 这个接口是**公开**的：没有任何密钥，谁都能看到现在有哪些歌词、各绑了哪些歌曲 id。
// 只读，不含歌词正文（正文在 /search?ttml=<歌曲id>，本来就是公开可读的）。
// 删除（/ttml/destroy）才需要管理密码，和这里分开。
const store = require('../plugins/ttmlStore.js')

module.exports = async () => {
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
      // 服务端有没有配管理密码：没配的话删除是关闭的，页面据此提示
      canDelete: !!String(process.env.TTML_ADMIN_PASS || ''),
    },
  }
}
