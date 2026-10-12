// 文件挂载代理 · 上传授权（签发 Vercel Blob 客户端令牌）
//
// 浏览器拿到令牌后用 @vercel/blob/client 的 upload() 把文件【直传】Blob，
// 文件本身不经过本函数，因此不受 Vercel 函数 4.5MB 请求体上限约束（大文件也能传）。
//
// 依赖：在 Vercel 项目的 Storage 里创建一个 Blob store，环境变量
//       BLOB_READ_WRITE_TOKEN 会自动注入；未配置时本接口返回 501 与提示。
//
// 防盗用（可选）：设置环境变量 FILE_UPLOAD_KEY 后，上传必须带上同一个 key。
//       不设置则任何拿到网址的人都能往你的 Blob store 里传文件（会产生费用），
//       公开部署强烈建议设置。
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

  // 口令可以从查询串带（直接 fetch 调用），也可以走 clientPayload
  // （@vercel/blob/client 的 upload() 只允许通过 clientPayload 传自定义数据）
  const gate = process.env.FILE_UPLOAD_KEY
  if (gate) {
    const sent =
      query.key || (query.payload && query.payload.clientPayload) || ''
    if (String(sent) !== gate) {
      return { status: 403, body: { code: 403, msg: '上传口令不正确' } }
    }
  }

  const pathname = safePathname(query.payload && query.payload.pathname)
  if (!pathname) {
    return { status: 400, body: { code: 400, msg: '缺少文件名' } }
  }

  const {
    generateClientTokenFromReadWriteToken,
  } = require('@vercel/blob/client')
  try {
    const clientToken = await generateClientTokenFromReadWriteToken({
      pathname,
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
