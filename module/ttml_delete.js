// /ttml/delete —— 解绑歌曲 id，并在没人再用这份歌词时把 TTML 本身删掉
//
// 两种用法：
//   ids=186016,186017        把这两个歌曲 id 从歌词上解绑
//   ttmlId=a1b2c3d4e5f60718  直接按歌词身份删：解绑它所有的歌曲 id 并删掉内容
//
// 「解绑 + 删掉当前的 TTML」是一条链：解绑后如果没有任何歌曲 id 再绑着这份内容，
// 内容会被一起清掉（plugins/ttmlStore.js 的 unbind / gcContent）。
//
// 删掉就没了（Blob 上没有版本历史），所以必须过人机验证。
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

  // ---- 用法一：按歌词身份删 ----
  const wantTtmlId = String(query.ttmlId || '').trim()
  if (wantTtmlId) {
    if (!store.isValidTtmlId(wantTtmlId)) {
      return {
        status: 400,
        body: { code: 400, msg: 'ttmlId 必须是 16 位十六进制' },
      }
    }
    let users = []
    try {
      users = await store.bindingsOfTtml(wantTtmlId)
    } catch (e) {
      return {
        status: 500,
        body: { code: 500, msg: '查询绑定失败：' + (e.message || e) },
      }
    }
    const unbound = []
    for (const id of users) {
      try {
        const r = await store.unbind(id)
        if (r.unbound) unbound.push(id)
      } catch {
        /* 单个失败不影响其它 */
      }
    }
    const contentDeleted = await store.gcContent(wantTtmlId)
    return {
      status: 200,
      body: {
        code: 200,
        msg:
          `ttmlId=${wantTtmlId}：解绑 ${unbound.length} 个歌曲 id` +
          (contentDeleted
            ? '，并已删除歌词内容'
            : '，但歌词内容还在（可能还有别的 id 绑着）'),
        ttmlId: wantTtmlId,
        unbound,
        contentDeleted,
      },
    }
  }

  // ---- 用法二：按歌曲 id 解绑 ----
  const ids = parseIds(query.ids)
  if (!ids.length) {
    return {
      status: 400,
      body: { code: 400, msg: 'ids 必填（也可以用 ttmlId）' },
    }
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

  const unbound = []
  const missing = []
  const failed = []
  const contentDeleted = []
  for (const id of ids) {
    try {
      const r = await store.unbind(id)
      if (r.unbound) {
        unbound.push(id)
        if (r.contentDeleted && r.ttmlId) contentDeleted.push(r.ttmlId)
      } else {
        missing.push(id)
      }
    } catch (e) {
      failed.push({ id, error: String((e && e.message) || e) })
    }
  }

  const parts = []
  if (unbound.length) parts.push(`已解绑 ${unbound.length} 个`)
  if (contentDeleted.length) {
    parts.push(`其中 ${contentDeleted.length} 份歌词已无 id 使用、内容一并删除`)
  }
  if (missing.length) parts.push(`${missing.length} 个本来就没有`)
  if (failed.length) parts.push(`${failed.length} 个失败`)

  return {
    status: failed.length && !unbound.length ? 500 : 200,
    body: {
      code: failed.length && !unbound.length ? 500 : 200,
      msg: parts.join('，') || '没有可删的',
      unbound,
      contentDeleted,
      missing,
      failed,
    },
  }
}
