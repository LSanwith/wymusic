// /ttml/delete —— 按歌曲 id 删除已上传的 TTML
//
// 删掉就没了（Blob 上一个 id 只有一份，覆盖式存储），所以必须过人机验证。
// 一次最多删 20 个，避免误操作一口气清空。
const store = require('../plugins/ttmlStore.js')
const filePass = require('../plugins/filePass.js')

const MAX_DELETE = 20

function parseIds(raw) {
  const list = (
    Array.isArray(raw)
      ? raw
      : String(raw == null ? '' : raw).split(/[\s,，、]+/)
  )
    .map((s) => String(s).trim())
    .filter(Boolean)
  return [...new Set(list)]
}

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

  const ids = parseIds(query.ids)
  if (!ids.length) {
    return { status: 400, body: { code: 400, msg: 'ids 必填' } }
  }
  if (ids.length > MAX_DELETE) {
    return {
      status: 400,
      body: {
        code: 400,
        msg: `一次最多删 ${MAX_DELETE} 个，当前 ${ids.length} 个`,
      },
    }
  }
  const bad = ids.filter((id) => !store.isValidId(id))
  if (bad.length) {
    return {
      status: 400,
      body: {
        code: 400,
        msg: '这些 id 不合法（必须是纯数字）：' + bad.join(', '),
      },
    }
  }

  const deleted = []
  const missing = []
  const failed = []
  for (const id of ids) {
    try {
      const ok = await store.remove(id)
      if (ok) deleted.push(id)
      else missing.push(id)
    } catch (e) {
      failed.push({ id, error: String((e && e.message) || e) })
    }
  }

  const parts = []
  if (deleted.length) parts.push(`已删除 ${deleted.length} 份`)
  if (missing.length) parts.push(`${missing.length} 个本来就没有`)
  if (failed.length) parts.push(`${failed.length} 个删除失败`)

  return {
    status: failed.length && !deleted.length ? 500 : 200,
    body: {
      code: failed.length && !deleted.length ? 500 : 200,
      msg: parts.join('，') || '没有可删的',
      deleted,
      missing,
      failed,
    },
  }
}
