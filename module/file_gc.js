// 文件挂载代理 · 立即清理过期临时文件
//
//   GET /file/gc        删除超过 7 天的 tmp/ 文件，返回删除条数
//
// 页面每次列列表也会惰性清理（见 file_list.js），这个接口用于「没人访问也要按时清理」：
// 在 Vercel 项目的 Settings → Cron Jobs 里加一个每天执行的 /file/gc 即可。
//
// 不加口令保护：它只会删除早已过期的临时文件，删不掉永久文件，重复调用也无副作用。
// 但配了人机验证时仍要求带通行证，免得被当成免费的定时触发器刷。
const { TEMP_DAYS, gcExpired } = require('../plugins/fileRetention.js')
const { guard } = require('../plugins/filePass.js')

module.exports = async (query) => {
  const denied = guard(query)
  if (denied) return denied

  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    return {
      status: 501,
      body: {
        code: 501,
        msg: '未配置 Vercel Blob（缺少 BLOB_READ_WRITE_TOKEN）',
      },
    }
  }
  try {
    const deleted = await gcExpired(1000)
    return {
      status: 200,
      body: { code: 200, deleted, tempDays: TEMP_DAYS },
    }
  } catch (e) {
    return { status: 500, body: { code: 500, msg: e.message || '清理失败' } }
  }
}
