const fs = require('fs')
const path = require('path')
const { register_anonimous } = require('./main')
const { getXeapiPublicKey } = require('./util/xeapiKey')   // 只保留这个依赖
const tmpPath = require('os').tmpdir()

// 内联随机中国 IP 生成
function generateRandomChineseIP() {
  const prefixes = ['116', '117', '118', '119', '120', '121', '122', '123', '124', '125', '126', '127', '220', '221', '222', '223'];
  const a = prefixes[Math.floor(Math.random() * prefixes.length)];
  const b = Math.floor(Math.random() * 256);
  const c = Math.floor(Math.random() * 256);
  const d = Math.floor(Math.random() * 254) + 1;
  return `${a}.${b}.${c}.${d}`;
}

async function generateConfig() {
  global.cnIp = generateRandomChineseIP()
  try {
    const res = await register_anonimous()
    const cookie = res.body.cookie
    if (cookie) {
      // 临时 require cookieToJson，避免启动时依赖 util/index 出错
      const { cookieToJson } = require('./util/index')
      const cookieObj = cookieToJson(cookie)
      fs.writeFileSync(
        path.resolve(tmpPath, 'anonymous_token'),
        cookieObj.MUSIC_A,
        'utf-8',
      )
    }
  } catch (error) {
    console.log(error)
  }
  try {
    let currentPublicKey = {}
    try {
      currentPublicKey = JSON.parse(
        fs.readFileSync(path.resolve(tmpPath, 'xeapi_public_key'), 'utf-8'),
      )
    } catch (_) {}
    const publicKey = await getXeapiPublicKey(currentPublicKey, global.deviceId)
    fs.writeFileSync(
      path.resolve(tmpPath, 'xeapi_public_key'),
      JSON.stringify(publicKey),
      'utf-8',
    )
  } catch (error) {
    console.log(error)
  }
}
module.exports = generateConfig
