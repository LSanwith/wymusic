const { getCookieHeader, hasCookie } = require('./index')

const createOption = (query, crypto = '', checkToken = false) => {
  const headerCookie = getCookieHeader(query.headers)

  return {
    crypto: query.crypto || crypto || '',
    cookie: hasCookie(query.cookie)
      ? query.cookie
      : hasCookie(headerCookie)
        ? headerCookie
        : process.env.NETEASE_COOKIE,
    ua: query.ua || '',
    proxy: query.proxy || process.env.NETEASE_PROXY || undefined,
    // realIP 会变成请求头里的 X-Real-IP / X-Forwarded-For。
    // 网易云对播放地址接口（/song/url/v1）按 IP 地域限制，
    // 海外出口（比如 Vercel 的香港区）会直接返回 404，
    // 而 song/detail 这类接口不受影响 —— 所以配一个国内 IP 就能绕过。
    realIP: query.realIP || process.env.NETEASE_REAL_IP || undefined,
    randomCNIP:
      process.env.ENABLE_RANDOM_CN_IP === 'true'
        ? !['false', false].includes(query.randomCNIP)
        : ['true', true].includes(query.randomCNIP),
    e_r: query.e_r || undefined,
    domain: query.domain || '',
    checkToken: query.checkToken || checkToken,
    headers: query.headers || {},
    timeout: query.timeout || 0,
  }
}
module.exports = createOption
