const fs = require('fs')
const path = require('path')
const tmpPath = require('os').tmpdir()

async function start() {
  // 1. 确保 anonymous_token 存在
  if (!fs.existsSync(path.resolve(tmpPath, 'anonymous_token'))) {
    fs.writeFileSync(path.resolve(tmpPath, 'anonymous_token'), '', 'utf-8')
  }

  // 2. 生成配置（修复后不会再崩溃）
  const generateConfig = require('./generateConfig')
  await generateConfig()

  // 3. 加载 server 模块，并给 serveNcmApi 打补丁，注入 SKey 验证
  const server = require('./server')
  const originalServe = server.serveNcmApi

  server.serveNcmApi = function (options) {
    // 调用原始的 serveNcmApi，它会返回 Express app（或内部创建 app 并启动）
    const app = originalServe.call(this, options)

    // 如果返回的是 Express app（通常网易云API项目会返回 app），直接加中间件
    if (app && app.use && !app.__sKeyPatched) {
      app.use((req, res, next) => {
        const VALID_KEY = process.env.SKey
        if (!VALID_KEY) return next()
        const userKey = req.query.SKey
        if (userKey === VALID_KEY) return next()
        res.status(403).send('Access Denied: Invalid or missing SKey')
      })
      app.__sKeyPatched = true
    }
    // 如果 serveNcmApi 内部创建了 app 但没返回，可能需要另一种方式，
    // 但标准的 NeteaseCloudMusicApi 项目是返回 app 的，所以这层够用。
    return app
  }

  // 4. 启动服务（验证中间件已注入）
  server.serveNcmApi({ checkVersion: true })
}

start()
