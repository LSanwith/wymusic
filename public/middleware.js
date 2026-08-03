// middleware.js
import { NextResponse } from 'next/server';

export function middleware(request) {
  // 从环境变量读取正确密钥（请确保在 Vercel 中已添加名为 SKey 的环境变量）
  const VALID_KEY = process.env.SKey;

  // 本地调试时如未设环境变量，直接放行
  if (!VALID_KEY) {
    return NextResponse.next();
  }

  const url = new URL(request.url);
  const userKey = url.searchParams.get('SKey');   // 改为读取 SKey 参数

  if (userKey === VALID_KEY) {
    // 验证通过，可选禁用缓存，防止带参 URL 被缓存后绕过
    const response = NextResponse.next();
    response.headers.set('Cache-Control', 'private, no-store, max-age=0');
    return response;
  }

  // 验证失败，返回 403
  return new NextResponse('Access Denied', { status: 403 });
}

export const config = {
  matcher: '/((?!_next/static|_next/image|favicon.ico|assets).*)',
};
