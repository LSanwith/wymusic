// middleware.js
export function middleware(request) {
  return new Response('Middleware is working', { status: 403 });
}
