// /ttml/migrate —— 一次性迁移：把 Blob 时代的 TTML 搬进 KV
//
// 背景：wymusic-file 这个 Blob store 被 Hobby 的 Advanced Operations 额度
// 停用到 2026-12-08，恢复之后跑一次这个接口，把老歌词搬进 KV，
// 之后 KV 就是唯一来源（Blob 只当历史备份）。
//
// 要求：
//   - 管理密码（query.password，同 /ttml/destroy）
//   - 环境变量 BLOB_READ_WRITE_TOKEN（Vercel 项目里本来就有）
//   - KV 已配置（同其它 /ttml 接口）
//
// 幂等：重复跑只是把同样的内容再写一遍，不会重复计数。
const store = require('../plugins/ttmlStore.js')
const admin = require('../plugins/ttmlAdmin.js')

module.exports = async (query) => {
  const pw = admin.checkPassword(query.password)
  if (!pw.ok) {
    await admin.slowDown(600)
    return { status: 403, body: { code: 403, msg: '管理密码不对' } }
  }

  if (!store.hasToken()) {
    return {
      status: 501,
      body: {
        code: 501,
        msg: '未配置 KV（缺少 KV_REST_API_URL / KV_REST_API_TOKEN）',
      },
    }
  }

  let moved
  try {
    moved = await store.migrateFromBlob({ verbose: query.verbose === '1' })
  } catch (e) {
    return {
      status: 500,
      body: {
        code: 500,
        ok: false,
        msg: '迁移失败：' + (e.message || e),
        hint: 'Blob store 被停用期间所有请求都会 403，等它恢复（2026-12-08）后再跑一次。',
      },
    }
  }

  return {
    status: 200,
    body: {
      code: 200,
      ok: true,
      msg:
        `已迁移 ${moved.contents} 份歌词、${moved.bindings} 条绑定` +
        `、${moved.legacy} 份老格式`,
      ...moved,
    },
  }
}
