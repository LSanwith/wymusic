// Upstash Redis（Vercel KV）的极简 REST 客户端
//
// 为什么不用 SDK：项目里只要几条命令（GET/SET/SADD/...），
// 直接打 REST 接口既不用加依赖，也不会在 Serverless 里多一层连接管理。
//
// 环境变量（Vercel 里连 Upstash for Redis、前缀选 KV 会自动注入）：
//   KV_REST_API_URL / KV_REST_API_TOKEN
// 需要单独配别的实例时可以用 TTML_KV_URL / TTML_KV_TOKEN 覆盖。
//
// 约定：命令参数就是 Redis 命令的参数数组，例如 ['SET', 'k', 'v']；
// 出错一律抛 Error（调用方决定 500 还是 501）。

function kvUrl() {
  const raw = String(
    process.env.KV_REST_API_URL || process.env.TTML_KV_URL || '',
  ).trim()
  return raw.replace(/\/+$/, '')
}

function kvToken() {
  return String(
    process.env.KV_REST_API_TOKEN || process.env.TTML_KV_TOKEN || '',
  ).trim()
}

/** 配了 KV 才算能用 */
function hasKv() {
  return !!kvUrl() && !!kvToken()
}

async function kvRequest(path, payload) {
  const url = kvUrl()
  if (!url) throw new Error('未配置 KV（缺少 KV_REST_API_URL）')
  const res = await fetch(url + path, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${kvToken()}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(payload),
  })
  const text = await res.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    json = null
  }
  if (!res.ok) {
    const detail = (json && json.error) || text.slice(0, 200)
    throw new Error(`KV 请求失败（${res.status}）：${detail}`)
  }
  if (!json) throw new Error('KV 返回不是 JSON：' + text.slice(0, 200))
  if (!Array.isArray(json) && json.error) throw new Error('KV：' + json.error)
  return json
}

/** 单条命令，返回 result */
async function kv(command) {
  const json = await kvRequest('', command)
  return json ? json.result : null
}

/** 一次往返跑多条命令，按顺序返回 result 数组 */
async function kvPipeline(commands) {
  if (!commands.length) return []
  const results = await kvRequest('/pipeline', commands)
  if (!Array.isArray(results)) throw new Error('KV pipeline 返回异常')
  for (const item of results) {
    if (item && item.error) throw new Error('KV：' + item.error)
  }
  return results.map((item) => (item ? item.result : null))
}

module.exports = { kvUrl, kvToken, hasKv, kv, kvPipeline }
