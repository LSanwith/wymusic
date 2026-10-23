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
/**
 * 解析 id 列表。
 * 重复的 id 不做静默去重 —— 原样报出来，让提交方自己改（重复填通常意味着填错了）。
 */
function parseIds(raw) {
  const list = (
    Array.isArray(raw)
      ? raw
      : String(raw == null ? '' : raw).split(/[\s,，、]+/)
  )
    .map((s) => String(s).trim())
    .filter(Boolean)
  const seen = new Set()
  const dup = new Set()
  for (const id of list) {
    if (seen.has(id)) dup.add(id)
    else seen.add(id)
  }
  return { ids: [...seen], duplicates: [...dup] }
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

  const { ids, duplicates } = parseIds(query.ids)
  if (!ids.length) {
    return {
      status: 400,
      body: { code: 400, msg: 'ids 必填：填这首歌对应的网易云 id' },
    }
  }
  if (duplicates.length) {
    return {
      status: 400,
      body: {
        code: 400,
        msg: 'id 重复了：' + duplicates.join(', ') + '（每个 id 只能填一次）',
        duplicated: duplicates,
      },
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
  //    歌词并发取：一个一个 await 的话，N 个 id 就是 N 次跨洋往返
  const lrcs = await Promise.all(
    songs.map(async (s) => {
      try {
        return await fetchLyric(s.id, query, request)
      } catch {
        return ''
      }
    }),
  )

  const checks = []
  for (let i = 0; i < songs.length; i++) {
    const s = songs[i]
    const lrc = lrcs[i]
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

  // 4) 查重：全部 id 都已经绑着同一份内容，才是纯重复提交。
  //    只要有 id 是新的（或者绑的是别的歌词），就该继续 ——
  //    否则「给已上传的歌词再补一个歌曲 id」永远做不了。
  const incomingId = store.ttmlIdOf(ttml)
  const alreadyBound = []
  for (const id of ids) {
    let existing = null
    try {
      existing = await store.load(id)
    } catch {
      existing = null
    }
    if (existing && existing.ttmlId === incomingId) alreadyBound.push(id)
  }
  if (alreadyBound.length === ids.length) {
    return {
      status: 409,
      body: {
        code: 409,
        ok: false,
        msg:
          '这些 id 已经绑着同一份 TTML 了，属于重复提交：' +
          ids.join(', ') +
          `（ttmlId=${incomingId}）`,
        ttmlId: incomingId,
        duplicated: ids,
        hint: '内容没变就不用重复提交；要更新请改动内容后再提交。',
      },
    }
  }

  // 5) 入 Blob：内容只存一份（按内容 id 命名），再给每个歌曲 id 建绑定
  let put
  try {
    put = await store.save(ids, ttml)
  } catch (e) {
    return {
      status: 500,
      body: { code: 500, msg: '写入失败：' + (e.message || e) },
    }
  }

  // 歌曲 id 为准：它已经绑在别的 TTML 上就不允许直接改绑，必须先解绑
  if (put.blocked) {
    return {
      status: 409,
      body: {
        code: 409,
        ok: false,
        msg:
          '这些歌曲 id 已经绑在别的 TTML 上了，不能直接改绑：' +
          put.conflicts.map((c) => `${c.id} → ttmlId=${c.boundTo}`).join('、'),
        conflicts: put.conflicts,
        hint:
          '一个歌曲 id 同一时间只能绑一份歌词。要换成这份，先到 /ttml/admin/ ' +
          '把这个 id 从旧的那份上解绑，再提交。',
        alreadyBound: put.already,
        ttmlId: put.ttmlId,
      },
    }
  }

  // 这份歌词现在一共绑了哪些歌曲 id（用请求里的 + 已查到的，避免 list 的延迟漏掉刚建的）
  const boundIds = [
    ...new Set([...(await store.bindingsOfTtml(put.ttmlId)), ...ids]),
  ]

  return {
    status: 200,
    body: {
      code: 200,
      ok: true,
      // 这份歌词自己的身份（内容哈希）。换歌曲 id 绑也不变，对外请求仍用歌曲 id
      ttmlId: put.ttmlId,
      ids,
      bound: put.bound,
      alreadyBound: put.already,
      // 这份 TTML 目前绑定的全部歌曲 id
      bindings: boundIds,
      saved: ids.map((id) => ({
        id,
        api: '/search?ttml=' + id,
        url: store.downloadUrl(id),
        bind: '/ttml/bind?id=' + id,
      })),
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
