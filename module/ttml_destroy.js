// /ttml/destroy —— 管理页：真删除一份 TTML
//
// 管理页本身是公开的（谁都能看有哪些歌词、各绑了哪些歌曲 id），
// 但「删除」必须给管理密码 —— 密码来自环境变量 TTML_ADMIN_PASS，
// 不写进代码（这个仓库是公开的 fork）。
//
// 密码没配置时删除功能直接关闭（fail closed），不会变成「谁都能删」。
//
// 删除 = 内容从 Blob 上真的删掉（不留），并且它绑的所有歌曲 id 自动解绑。
const crypto = require('crypto')
const store = require('../plugins/ttmlStore.js')

/** 正确的管理密码；没配就是空串 */
function adminPass() {
  return String(process.env.TTML_ADMIN_PASS || '')
}

/**
 * 校验管理密码。
 * 先各自 sha256 再定长比较：既避开长度不等时 timingSafeEqual 抛错，
 * 也不泄露「密码多长、从第几位开始不一样」。
 */
function checkPassword(input) {
  const want = adminPass()
  if (!want) return { ok: false, reason: 'no-pass' }
  const got = String(input == null ? '' : input)
  if (!got) return { ok: false, reason: 'missing' }
  const a = crypto.createHash('sha256').update(got, 'utf8').digest()
  const b = crypto.createHash('sha256').update(want, 'utf8').digest()
  return { ok: crypto.timingSafeEqual(a, b), reason: 'mismatch' }
}

module.exports = async (query) => {
  const pw = checkPassword(query.password)
  if (!pw.ok) {
    if (pw.reason === 'no-pass') {
      return {
        status: 501,
        body: {
          code: 501,
          msg: '服务端没配置 TTML_ADMIN_PASS，删除功能是关闭的',
        },
      }
    }
    // 密码错时故意慢一点，抬高暴力尝试的成本
    await new Promise((r) => setTimeout(r, 600))
    return { status: 403, body: { code: 403, msg: '管理密码不对' } }
  }

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
