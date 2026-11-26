import { NextResponse, type NextRequest } from "next/server";

import {
  ACCESS_SESSION_COOKIE,
  accessSessionProof,
} from "@/lib/access-session";

// These routes belong to the retired accounts and contact-discovery workspace.
const RETIRED_API = new Set([
  "/api/already-done",
  "/api/draft-outreach",
  "/api/enrich-email",
  "/api/recorded-contacts",
  "/api/research-account",
  "/api/reveal-contact",
  "/api/save-to-sheet",
  "/api/search-leads",
  "/api/test-apify",
  "/api/test-apollo",
  "/api/test-model",
]);

/**
 * A shared-code gate for the outreach workspace. Production stays locked
 * if APP_ACCESS_CODE is missing. Local development can run without a code.
 * This is a stopgap until Google sign-in with the team allowlist lands.
 */
export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (RETIRED_API.has(pathname.replace(/\/+$/, ""))) {
    return NextResponse.json(
      { error: "This route has been retired." },
      { status: 410, headers: { "Cache-Control": "no-store" } },
    );
  }

  const code = process.env.APP_ACCESS_CODE?.trim();
  if (!code) {
    if (process.env.NODE_ENV === "production") {
      return new NextResponse("Team access is not configured.", {
        status: 503,
        headers: { "Cache-Control": "no-store" },
      });
    }
    return NextResponse.next();
  }

  const expectedProof = await accessSessionProof(code);
  if (request.cookies.get(ACCESS_SESSION_COOKIE)?.value === expectedProof) {
    return NextResponse.next();
  }

  if (pathname === "/unlock" || pathname === "/api/unlock") {
    return NextResponse.next();
  }

  if (pathname.startsWith("/api/")) {
    return NextResponse.json(
      { error: "Locked. Open the app in a browser and enter the access code." },
      { status: 401 },
    );
  }

  return NextResponse.redirect(new URL("/unlock", request.url));
}

export const config = {
  // Everything except Next's static assets goes through the gate.
  matcher: ["/((?!_next/|favicon\\.ico).*)"],
};
