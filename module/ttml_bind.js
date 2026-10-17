// /ttml/bind —— 查绑定关系：哪个歌曲 id 在哪个 TTML 里
//
// 两个方向都能查：
//   ?id=186016&ttmlId=xxx   校验这一对是否存在（同时返回这份歌词绑了哪些 id）
//   ?id=186016              这个歌曲 id 现在绑的是哪份歌词、那份歌词还绑了哪些 id
//   ?ttmlId=xxx             这份歌词绑了哪些歌曲 id
//
// 只读，不写任何东西，所以不挂人机验证。
const store = require('../plugins/ttmlStore.js')

module.exports = async (query) => {
  if (!store.hasToken()) {
    return {
      status: 501,
      body: {
        code: 501,
        msg: '未配置 Vercel Blob（缺少 BLOB_READ_WRITE_TOKEN）',
      },
    }
  }

  const songId = String(query.id == null ? '' : query.id).trim()
  const ttmlId = String(query.ttmlId == null ? '' : query.ttmlId).trim()

  if (!songId && !ttmlId) {
    return {
      status: 400,
      body: { code: 400, msg: '至少给一个 id（歌曲 id）或 ttmlId' },
    }
  }
  if (songId && !store.isValidId(songId)) {
    return {
      status: 400,
      body: { code: 400, msg: 'id 必须是网易云歌曲 id（纯数字）' },
    }
  }
  if (ttmlId && !store.isValidTtmlId(ttmlId)) {
    return {
      status: 400,
      body: { code: 400, msg: 'ttmlId 必须是 16 位十六进制' },
    }
  }

  // ---- 按歌词 id 查：它绑了哪些歌曲 id ----
  if (ttmlId && !songId) {
    const ids = await store.bindingsOfTtml(ttmlId)
    const meta = ids.length ? await store.stat(ids[0]) : null
    return {
      status: 200,
      body: {
        code: 200,
        ttmlId,
        exists: !!meta,
        ids,
        size: meta ? meta.size : null,
        uploadedAt: meta ? meta.uploadedAt : null,
        url: ids.length ? store.downloadUrl(ids[0]) : null,
      },
    }
  }

  // ---- 按歌曲 id 查：它绑的是哪份歌词 ----
  const cur = await store.load(songId)
  if (!cur) {
    return {
      status: 404,
      body: {
        code: 404,
        msg: `id=${songId} 还没有 TTML`,
        upload: '/ttml/',
      },
    }
  }
  const siblings = await store.bindingsOfTtml(cur.ttmlId)

  // 同时给了 ttmlId：顺手校验这一对是否成立（解绑前可以用它确认）
  const pairOk = ttmlId ? cur.ttmlId === ttmlId : null

  return {
    status: 200,
    body: {
      code: 200,
      id: songId,
      ttmlId: cur.ttmlId,
      // 这份歌词一共绑了哪些歌曲 id
      ids: siblings,
      // 同一份歌词的其他 id 数量
      sharedBy: Math.max(0, siblings.length - 1),
      size: cur.size,
      uploadedAt: cur.uploadedAt,
      url: store.downloadUrl(songId),
      ...(songId && ttmlId ? { pairOk } : {}),
    },
  }
}
