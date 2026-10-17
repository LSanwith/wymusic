// TTML 歌词提交 + AI 审核 + 入库
//
//   POST /ttml/submit
//   body 或 query：{ ttml, ids, pass }
//     ttml  必填，TTML 原文
//     ids   必填，对应的网易云歌曲 id，可多个（数组或逗号分隔，最多 8 个）
//     pass  人机验证通行证（见 plugins/filePass.js）
//
// 流程（顺序即省钱顺序）：
//   1. 结构检查 —— 本地做，0 token
//   2. 查歌曲名/歌手/时长 —— 给审核当对照
//   3. AI 语义审核 —— 只把摘要发过去，约 300 token
//   4. 通过才写 Blob，按 id 各存一份
const createOption = require('../util/option.js')
const { guard } = require('../plugins/filePass.js')
const store = require('../plugins/ttmlStore.js')
const review = require('../plugins/ttmlReview.js')

/** ids 既接受数组，也接受逗号/空白分隔的字符串 */
function parseIds(raw) {
  const list = Array.isArray(raw)
    ? raw
    : String(raw == null ? '' : raw).split(/[\s,，、]+/)
  return [...new Set(list.map((s) => String(s).trim()).filter(Boolean))]
}

/** 查歌曲详情，拿歌名/歌手/专辑/时长给审核用 */
async function fetchSongs(ids, query, request) {
  const data = {
    c: '[' + ids.map((id) => '{"id":' + Number(id) + '}').join(',') + ']',
  }
  const resp = await request(
    '/api/v3/song/detail',
    data,
    createOption(query, 'weapi'),
  )
  const songs = (resp && resp.body && resp.body.songs) || []
  return songs.map((s) => ({
    id: s.id,
    name: s.name || '',
    artists: (s.ar || []).map((a) => a.name).filter(Boolean),
    album: (s.al && s.al.name) || '',
    durationSec: s.dt ? Math.round(s.dt / 1000) : null,
  }))
}

module.exports = async (query, request) => {
  // 这个接口每调一次都要花 AI 的钱，必须挂人机验证
  const denied = guard(query)
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

  const ttml = String(query.ttml || '')
  if (!ttml.trim()) {
    return { status: 400, body: { code: 400, msg: 'ttml 必填' } }
  }

  const ids = parseIds(query.ids)
  if (!ids.length) {
    return {
      status: 400,
      body: { code: 400, msg: 'ids 必填：填这首歌对应的网易云 id' },
    }
  }
  if (ids.length > review.MAX_AI_IDS) {
    return {
      status: 400,
      body: {
        code: 400,
        msg: `一次最多 ${review.MAX_AI_IDS} 个 id，当前 ${ids.length} 个`,
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

  // 1) 先查歌，后面结构检查要用时长
  let songs = []
  try {
    songs = await fetchSongs(ids, query, request)
  } catch {
    songs = []
  }
  if (songs.length !== ids.length) {
    return {
      status: 404,
      body: {
        code: 404,
        msg: '有 id 查不到歌曲，请确认是网易云歌曲 id',
        found: songs.map((s) => s.id),
        asked: ids,
      },
    }
  }

  // 2) 结构检查（不花钱）
  const durations = songs.map((s) => s.durationSec).filter(Boolean)
  const structural = review.structuralCheck(ttml, durations)
  if (!structural.ok) {
    return {
      status: 400,
      body: {
        code: 400,
        msg: 'TTML 结构不合格',
        problems: structural.problems,
        digest: structural.digest,
        tokens: 0,
      },
    }
  }

  // 3) AI 语义审核（花钱，但只发摘要）
  const ai = await review.aiCheck(songs, structural.digest)
  if (!ai.ok) {
    return {
      status: 422,
      body: {
        code: 422,
        msg: 'AI 审核未通过',
        why: ai.why,
        songs: songs.map((s) => s.name + ' / ' + s.artists.join(',')),
        digest: structural.digest,
        tokens: ai.tokens || 0,
      },
    }
  }

  // 4) 入 Blob
  const saved = []
  try {
    for (const id of ids) {
      const r = await store.save(id, ttml)
      saved.push({ id, url: r.url, api: '/search?ttml=' + id })
    }
  } catch (e) {
    return {
      status: 500,
      body: { code: 500, msg: '写入失败：' + (e.message || e), saved },
    }
  }

  return {
    status: 200,
    body: {
      code: 200,
      ok: true,
      ids,
      saved,
      review: {
        verdict: ai.skipped ? '结构检查通过（AI 审核未启用）' : 'AI 审核通过',
        why: ai.why,
        tokens: ai.tokens || 0,
      },
      digest: structural.digest,
    },
  }
}
