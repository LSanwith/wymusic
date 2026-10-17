// TTML 歌词提交 + 脚本审核 + 入库
//
//   POST /ttml/submit
//   body 或 query：{ ttml, ids, pass }
//     ttml  必填，TTML 原文
//     ids   必填，对应的网易云歌曲 id，可多个（数组或逗号分隔，最多 8 个）
//     pass  人机验证通行证（见 plugins/filePass.js）
//
// 审核是纯脚本，不调用 AI（0 token），规则见 plugins/ttmlReview.js：
//   结构那一套（行数、时间轴、完整性）+ 与官方歌词的字面重合率。
// 关键约束：**每一个 id 的歌都必须和歌词对得上**，有一个过不了就整体拒。
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

/** 查歌曲详情，拿歌名/歌手/专辑/时长 */
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

/** 取官方歌词（LRC 原文） */
async function fetchLyric(id, query, request) {
  const data = { id, tv: -1, lv: -1, rv: -1, kv: -1, _nmclfl: 1 }
  const resp = await request('/api/song/lyric', data, createOption(query))
  const body = (resp && resp.body) || {}
  return String((body.lrc && body.lrc.lyric) || '')
}

module.exports = async (query, request) => {
  // 这个接口要调网易云接口、还要写 Blob，必须挂人机验证
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

  // 还原 JSON 转义 / HTML 实体：从接口返回的 JSON 里复制 ttml 字段值会带 \"
  // 这种转义，直接存下来既过不了解析也没法用
  const ttml = review.normalizeTtmlInput(query.ttml)
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
  if (ids.length > review.MAX_IDS) {
    return {
      status: 400,
      body: {
        code: 400,
        msg: `一次最多 ${review.MAX_IDS} 个 id，当前 ${ids.length} 个`,
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

  // 1) 查歌
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

  // 2) 结构检查。多首歌时长可能不同，用最短的那首当基准（最严）
  const durations = songs.map((s) => s.durationSec).filter(Boolean)
  const baseDur = durations.length ? Math.min(...durations) : null
  const structural = review.structuralCheck(ttml, baseDur)
  if (!structural.ok) {
    return {
      status: 400,
      body: {
        code: 400,
        msg: 'TTML 结构不合格',
        problems: structural.problems,
        digest: pickDigest(structural.digest),
      },
    }
  }

  // 3) 逐 id 与官方歌词比对，每个都必须过
  const checks = []
  for (const s of songs) {
    let lrc = ''
    try {
      lrc = await fetchLyric(s.id, query, request)
    } catch {
      lrc = ''
    }
    if (!review.lyricUsable(lrc)) {
      checks.push({
        id: String(s.id),
        name: s.name,
        ok: false,
        reason: '这首歌没有可用的官方歌词，无法核对（纯音乐或暂无歌词）',
      })
      continue
    }
    const cmp = review.contentRatio(
      structural.digest.text,
      review.lrcTextOf(lrc),
    )
    checks.push({
      id: String(s.id),
      name: s.name,
      ok: cmp.ok,
      ratio: cmp.ratio,
      threshold: cmp.threshold,
      reason: cmp.ok
        ? `与官方歌词重合 ${(cmp.ratio * 100).toFixed(1)}%`
        : `与官方歌词只重合 ${(cmp.ratio * 100).toFixed(1)}%，` +
          `低于 ${(cmp.threshold * 100).toFixed(0)}%，不像是这首歌的歌词`,
    })
  }

  const failed = checks.filter((c) => !c.ok)
  if (failed.length) {
    return {
      status: 422,
      body: {
        code: 422,
        msg: '脚本审核未通过',
        why: failed.map((f) => `${f.name}：${f.reason}`).join('；'),
        checks,
        digest: pickDigest(structural.digest),
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
        verdict: '脚本审核通过',
        checks,
        // 纯脚本审核，不花任何 token
        tokens: 0,
      },
      digest: pickDigest(structural.digest),
    },
  }
}

/** 回给客户端的摘要里不要带整份歌词文本 */
function pickDigest(d) {
  if (!d) return null
  const out = Object.assign({}, d)
  delete out.text
  return out
}
