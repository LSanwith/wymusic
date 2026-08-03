export function middleware(request) {
  const VALID_KEY = process.env.SKey;
  if (!VALID_KEY) return;
  const url = new URL(request.url);
  const userKey = url.searchParams.get('SKey');
  if (userKey === VALID_KEY) return;   // 放行
  return new Response('Access Denied', { status: 403 });
}
