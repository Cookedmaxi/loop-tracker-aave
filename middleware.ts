// Temporary gate: one shared password (HTTP Basic Auth) until Clerk is wired in.
// Set SITE_PASSWORD in the environment. To replace it with Clerk, swap this file
// for clerkMiddleware() and restrict sign-ins to the team's email domain.

import { NextResponse, type NextRequest } from "next/server";

export function middleware(request: NextRequest) {
  const password = process.env.SITE_PASSWORD;
  if (!password) {
    if (process.env.NODE_ENV !== "production") return NextResponse.next();
    return new NextResponse("SITE_PASSWORD is not set. Add it to the environment variables.", { status: 503 });
  }
  const header = request.headers.get("authorization") ?? "";
  if (header.startsWith("Basic ")) {
    const given = atob(header.slice(6)).split(":").slice(1).join(":");
    if (given === password) return NextResponse.next();
  }
  return new NextResponse("Sign in to open the Loop Monitor.", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="TokenLogic Loop Monitor"' },
  });
}

export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"] };
