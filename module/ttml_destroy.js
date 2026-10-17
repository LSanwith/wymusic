// /ttml/destroy —— 后台：真删除一份 TTML
//
// 删除 = 内容从 Blob 上真的删掉（不留），并且它绑的所有歌曲 id 自动解绑。
// 这是后台专用动作，必须带 ttmlId，必须过人机验证。
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

  const ttmlId = String(query.ttmlId == null ? '' : query.ttmlId)
    .trim()
    .toLowerCase()
  const songId = String(query.songId == null ? '' : query.songId).trim()

  // 老格式（ttml/<歌曲id>.ttml）：按歌曲 id 删，没有 ttmlId 概念
  if (!ttmlId && songId) {
    if (!store.isValidId(songId)) {
      return {
        status: 400,
        body: { code: 400, msg: 'songId 必须是纯数字' },
      }
    }
    let lg
    try {
      lg = await store.destroyLegacy(songId)
    } catch (e) {
      return {
        status: 500,
        body: { code: 500, msg: '删除失败：' + (e.message || e) },
      }
    }
    return {
      status: 200,
      body: {
        code: 200,
        ok: true,
        msg: lg.deleted
          ? `已删除老格式 ttml/${songId}.ttml`
          : `老格式里没有 ${songId}`,
        songId,
        legacy: true,
        contentDeleted: lg.deleted,
        unbound: lg.deleted ? [songId] : [],
      },
    }
  }

  if (!ttmlId) {
    return {
      status: 400,
      body: { code: 400, msg: 'ttmlId 必填（老格式数据可以用 songId）' },
    }
  }
  if (!store.isValidTtmlId(ttmlId)) {
    return {
      status: 400,
      body: { code: 400, msg: 'ttmlId 必须是 16 位十六进制' },
    }
  }

  let r
  try {
    r = await store.destroyTtml(ttmlId)
  } catch (e) {
    return {
      status: 500,
      body: { code: 500, msg: '删除失败：' + (e.message || e) },
    }
  }

  const parts = []
  if (r.unbound.length) parts.push(`解绑 ${r.unbound.length} 个歌曲 id`)
  if (r.contentDeleted) parts.push('内容已从 Blob 删除')
  if (!r.unbound.length && !r.contentDeleted) parts.push('这份已经不存在了')

  return {
    status: 200,
    body: {
      code: 200,
      ok: true,
      msg: `ttmlId=${ttmlId}：` + parts.join('，'),
      ttmlId,
      unbound: r.unbound,
      contentDeleted: r.contentDeleted,
    },
  }
}
