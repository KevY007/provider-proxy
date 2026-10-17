import { NextResponse, type NextRequest } from "next/server";

/**
 * Route guard (Next 16 `proxy`, formerly middleware).
 *  - /dashboard/* and /admin/*: redirect to /login?next=... when there is no session cookie.
 *    (Cheap optimistic check only - the real validation + role checks happen server-side in the
 *    layouts via requireUser()/requireAdmin() and in every server action.)
 *  - Keeps the session cookie's browser expiry rolling.
 * Intentionally does NOT match /v1/*, /v1beta/*, /api/* (the gateway authenticates by API key).
 */
const SESSION_COOKIE = "pp_session";
const THIRTY_DAYS = 30 * 24 * 60 * 60;

export function proxy(request: NextRequest) {
  const token = request.cookies.get(SESSION_COOKIE)?.value;
  const { pathname, search } = request.nextUrl;

  if (!token) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.search = `?next=${encodeURIComponent(pathname + search)}`;
    return NextResponse.redirect(url);
  }

  const res = NextResponse.next();
  // rolling cookie lifetime (DB expiry is rolled in getSession)
  res.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production" && (process.env.APP_URL ?? "").startsWith("https://"),
    path: "/",
    maxAge: THIRTY_DAYS,
  });
  return res;
}

export const config = {
  matcher: ["/dashboard/:path*", "/admin/:path*"],
};
