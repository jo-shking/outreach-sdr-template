import "server-only";

import { NextResponse } from "next/server";

import {
  ACCESS_SESSION_COOKIE,
  accessSessionProof,
} from "@/lib/access-session";

const THIRTY_DAYS_SECONDS = 60 * 60 * 24 * 30;

/** Exchanges the shared access code for the cookie the proxy gate checks. */
export async function POST(request: Request) {
  const code = process.env.APP_ACCESS_CODE?.trim();

  if (!code) {
    return NextResponse.json(
      { error: "No access code is configured, so the app is already open." },
      { status: 400 },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "The request body must be valid JSON." },
      { status: 400 },
    );
  }

  const supplied =
    body && typeof body === "object" && "code" in body &&
    typeof (body as { code: unknown }).code === "string"
      ? (body as { code: string }).code.trim()
      : "";

  const [suppliedProof, expectedProof] = await Promise.all([
    accessSessionProof(supplied),
    accessSessionProof(code),
  ]);
  if (suppliedProof !== expectedProof) {
    return NextResponse.json(
      { error: "That code is not right. Ask your team administrator for the current one." },
      { status: 401 },
    );
  }

  const response = NextResponse.json({ ok: true });
  response.cookies.set(ACCESS_SESSION_COOKIE, expectedProof, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: THIRTY_DAYS_SECONDS,
    path: "/",
  });
  return response;
}
