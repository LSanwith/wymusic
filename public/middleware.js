export function middleware(request) {
  return new Response('中间件已拦截', { status: 403 });
}
