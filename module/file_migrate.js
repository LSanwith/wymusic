// /file/migrate —— 一次性迁移：把 Blob 里已有的文件登记进 KV 索引
//
// 背景：文件列表 / 公开额度 / 7 天 GC 现在都读 KV 索引
// （见 plugins/fileIndex.js），Blob 里已经存在的文件没有索引条目，
// 不迁移的话列表里看不到、也永远清不掉。
//
// 等 wymusic-file 这个 Blob store 恢复（2026-12-08）后跑一次即可，
// 幂等，重复执行只是把同样的条目再写一遍。
const fileIndex = require('../plugins/fileIndex.js')
const admin = require('../plugins/ttmlAdmin.js')

module.exports = async (query) => {
  const pw = admin.checkPassword(query.password)
  if (!pw.ok) {
    await admin.slowDown(600)
    return { status: 403, body: { code: 403, msg: '管理密码不对' } }
  }

  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    return {
      status: 501,
      body: {
        code: 501,
        msg: '未配置 Vercel Blob（缺少 BLOB_READ_WRITE_TOKEN）',
      },
    }
  }
  if (!fileIndex.hasKv()) {
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
    moved = await fileIndex.migrateFromBlob({ verbose: query.verbose === '1' })
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
      msg: `已迁移 ${moved.files} 个文件`,
      ...moved,
    },
  }
}
