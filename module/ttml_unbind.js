// /ttml/unbind —— 解绑（不是删除）
//
// 必须「歌曲 id + ttmlId」一对都给，而且必须真的对得上：
//   - 只给歌曲 id 等于盲删：万一那个 id 后来被改绑到别的歌词，删的就是错的那份
//   - 只给 ttmlId 会一次解掉一堆 id，风险更大
// 所以两个 id 缺一个、或对不上，一律拒绝。
//
// 解绑后如果这份 TTML 已经没有任何歌曲 id 在用，内容会被回收
// （那是「解绑」的副作用，不是独立的删除动作）。
const store = require('../plugins/ttmlStore.js')
const filePass = require('../plugins/filePass.js')

const MAX_IDS = 20

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

  const ttmlId = String(query.ttmlId == null ? '' : query.ttmlId).trim()
  if (!ttmlId) {
    return {
      status: 400,
      body: {
        code: 400,
        msg:
          '必须同时给出 ttmlId：解绑要「歌曲 id + 歌词 id」一对，' +
          '只给歌曲 id 等于盲删。可以先用 /ttml/bind?id=<歌曲id> 查它绑的是哪份。',
      },
    }
  }
  if (!store.isValidTtmlId(ttmlId)) {
    return {
      status: 400,
      body: { code: 400, msg: 'ttmlId 必须是 16 位十六进制' },
    }
  }

  const ids = parseIds(query.ids == null ? query.id : query.ids)
  if (!ids.length) {
    return {
      status: 400,
      body: { code: 400, msg: 'ids 必填：要解绑的歌曲 id' },
    }
  }
  if (ids.length > MAX_IDS) {
    return {
      status: 400,
      body: {
        code: 400,
        msg: `一次最多解绑 ${MAX_IDS} 个，当前 ${ids.length} 个`,
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
  const mismatched = []
  const failed = []
  const contentDeleted = []

  for (const id of ids) {
    try {
      const r = await store.unbind(id, ttmlId)
      if (r.unbound) {
        unbound.push(id)
        if (r.contentDeleted) contentDeleted.push(ttmlId)
      } else {
        mismatched.push({ id, reason: r.error || '对不上' })
      }
    } catch (e) {
      failed.push({ id, error: String((e && e.message) || e) })
    }
  }

  const parts = []
  if (unbound.length) parts.push(`已解绑 ${unbound.length} 个`)
  if (contentDeleted.length) {
    parts.push('这份歌词已无 id 使用，内容一并回收')
  }
  if (mismatched.length)
    parts.push(`${mismatched.length} 个与这份歌词对不上，未动`)
  if (failed.length) parts.push(`${failed.length} 个失败`)

  const remaining = unbound.length ? await store.bindingsOfTtml(ttmlId) : null

  return {
    status:
      failed.length && !unbound.length
        ? 500
        : mismatched.length && !unbound.length
          ? 409
          : 200,
    body: {
      code:
        failed.length && !unbound.length
          ? 500
          : mismatched.length && !unbound.length
            ? 409
            : 200,
      msg: parts.join('，') || '没有可解绑的',
      ttmlId,
      unbound,
      mismatched,
      failed,
      contentDeleted: contentDeleted.length > 0,
      remaining: remaining || [],
    },
  }
}
