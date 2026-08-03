const fs = require('fs')
const path = require('path')
const tmpPath = require('os').tmpdir()

// ===== 最可靠的 SKey 验证注入 =====
// 在 HTTP 服务器创建时拦截，直接给 Express app 加上中间件
const http = require('http')
const originalCreateServer = http.createServer
http.createServer = function (app, ...args) {
  // app 就是 Express 实例
  app.use((req, res, next) => {
    const VALID_KEY = process.env.SKey
    // 环境变量没配好就放行（方便本地调试）
    if (!VALID_KEY) return next()

    const userKey = req.query.SKey
    if (userKey === VALID_KEY) return next()

    res.status(403).send('Access Denied: Invalid or missing SKey')
  })
  // 恢复原始方法，避免无限递归
  http.createServer = originalCreateServer
  return originalCreateServer(app, ...args)
}
// ====================================

async function start() {
  if (!fs.existsSync(path.resolve(tmpPath, 'anonymous_token'))) {
    fs.writeFileSync(path.resolve(tmpPath, 'anonymous_token'), '', 'utf-8')
  }

  const generateConfig = require('./generateConfig')
  await generateConfig()

  require('./server').serveNcmApi({
    checkVersion: true,
  })
}
start()
