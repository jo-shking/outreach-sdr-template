import "server-only";

import { gmailConfiguration } from "@/lib/gmail-send";

export async function GET() {
  return Response.json(gmailConfiguration(), {
    headers: { "Cache-Control": "no-store" },
  });
}
