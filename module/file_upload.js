// 文件挂载代理 · 上传授权（签发 Vercel Blob 客户端令牌）
//
// 浏览器拿到令牌后用 @vercel/blob/client 的 upload() 把文件【直传】Blob，
// 文件本身不经过本函数，因此不受 Vercel 函数 4.5MB 请求体上限约束（大文件也能传）。
//
// 保存期由路径前缀决定（见 plugins/fileRetention.js）：
//   不填口令        -> tmp/       7 天后自动清理
//   口令 FileAlways -> keep-pub/  永久保存，全站每月共享 5 次
//   私有口令        -> keep-vip/  永久保存，不限次数
//
// 依赖：在 Vercel 项目的 Storage 里创建一个 Blob store（选 Public），环境变量
//       BLOB_READ_WRITE_TOKEN 会自动注入；未配置时本接口返回 501 与提示。
//
// 防盗用（可选）：设置环境变量 FILE_UPLOAD_KEY 后，上传必须带上同一个 gate。
const {
  PREFIX,
  PUB_MONTHLY_LIMIT,
  alwaysTier,
  pubUsedThisMonth,
} = require('../plugins/fileRetention.js')

const MAX_SIZE = 200 * 1024 * 1024 // 单文件上限 200MB

function noToken() {
  return {
    status: 501,
    body: {
      code: 501,
      msg: '未配置 Vercel Blob：请在 Vercel 项目的 Storage 中创建一个 Blob store（BLOB_READ_WRITE_TOKEN 会自动注入），然后重新部署。',
    },
  }
}

/** 只取文件名，去掉目录与 .. / 反斜杠，避免污染 Blob 路径 */
function safePathname(input) {
  return String(input || '')
    .replace(/\\/g, '/')
    .split('/')
    .filter((s) => s && s !== '.' && s !== '..')
    .pop()
    .slice(0, 180)
}

/** clientPayload 是 JSON 字符串 {gate, always}；兼容直接传纯文本 gate 的写法 */
function parsePayload(raw) {
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : { gate: String(raw) }
  } catch {
    return { gate: String(raw) }
  }
}

module.exports = async (query) => {
  const type = query.type

  // Vercel Blob 在客户端上传完成后会回调这里。本功能不需要落库，
  // 直接回 ok 让回调停止重试。
  // 说明：模块体系里拿不到请求头，所以这里不校验 x-vercel-signature；
  //       该分支没有任何副作用，伪造回调无害。
  if (type === 'blob.upload-completed') {
    return { status: 200, body: { type, response: 'ok' } }
  }

  if (type !== 'blob.generate-client-token') {
    return { status: 400, body: { code: 400, msg: '未知的事件类型' } }
  }

  if (!process.env.BLOB_READ_WRITE_TOKEN) return noToken()

  // clientPayload 是 @vercel/blob/client 唯一能传自定义数据的通道
  const payload = parsePayload(query.payload && query.payload.clientPayload)

  // 总开关口令：保护整个文件功能不被陌生人使用
  const gate = process.env.FILE_UPLOAD_KEY
  if (gate && String(payload.gate || query.key || '') !== gate) {
    return { status: 403, body: { code: 403, msg: '上传口令不正确' } }
  }

  // 永久保存口令
  const wanted = String(payload.always || '').trim()
  const tier = alwaysTier(wanted)
  if (wanted && !tier) {
    return {
      status: 403,
      body: { code: 403, msg: '永久保存口令不正确（留空则按 7 天有效上传）' },
    }
  }

  let prefix = PREFIX.temp
  if (tier === 'vip') {
    prefix = PREFIX.vip
  } else if (tier === 'pub') {
    let used
    try {
      used = await pubUsedThisMonth()
    } catch {
      // 统计失败时不放行，避免把公开额度算漏
      return {
        status: 502,
        body: { code: 502, msg: '暂时无法核对公开口令次数，请稍后再试' },
      }
    }
    if (used >= PUB_MONTHLY_LIMIT) {
      return {
        status: 429,
        body: {
          code: 429,
          msg: `公开口令本月 ${PUB_MONTHLY_LIMIT} 次已用完（下月恢复）；不填口令仍可按 7 天有效上传。`,
        },
      }
    }
    prefix = PREFIX.pub
  }

  const base = safePathname(query.payload && query.payload.pathname)
  if (!base) {
    return { status: 400, body: { code: 400, msg: '缺少文件名' } }
  }

  const {
    generateClientTokenFromReadWriteToken,
  } = require('@vercel/blob/client')
  try {
    const clientToken = await generateClientTokenFromReadWriteToken({
      pathname: prefix + base,
      addRandomSuffix: true,
      maximumSizeInBytes: MAX_SIZE,
    })
    return { status: 200, body: { type, clientToken } }
  } catch (e) {
    return {
      status: 500,
      body: { code: 500, msg: e.message || '签发令牌失败' },
    }
  }
}
