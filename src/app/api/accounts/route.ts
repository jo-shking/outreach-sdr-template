import "server-only";

import {
  getAccounts,
  GoogleSheetsAccessError,
  GoogleSheetsConfigurationError,
  GoogleSheetsStructureError,
} from "@/lib/google-sheets";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const accounts = await getAccounts();

    return Response.json(
      { accounts: accounts.map(({ companyId, companyName, website }) => ({ companyId, companyName, website })) },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    if (error instanceof GoogleSheetsConfigurationError) {
      return Response.json({ error: error.message }, { status: 500 });
    }

    if (error instanceof GoogleSheetsStructureError) {
      return Response.json({ error: error.message }, { status: 422 });
    }

    if (error instanceof GoogleSheetsAccessError) {
      return Response.json(
        {
          error: error.message,
          failure: error.failure,
          upstreamStatus: error.upstreamStatus,
        },
        { status: 502 },
      );
    }

    return Response.json(
      {
        error:
          "The server could not read the Companies tab. Check the service-account sharing and credential configuration.",
      },
      { status: 502 },
    );
  }
}
