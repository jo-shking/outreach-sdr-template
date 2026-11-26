# Outreach SDR template

A Next.js sponsorship outreach app with Monetary and In-kind workflows. In Monetary, pick a company, find people, verify work emails, and review a personalized draft. You can send through your own Gmail mailbox from the app. After Gmail accepts the message, the app records the send in Google Sheets.

## 1. Run locally

Install Node.js 24 and npm. If you are starting from GitHub, click **Use this template** to create your own repository, then clone it.

```sh
npm ci
npm run dev
```

Copy `.env.example` to `.env.local` and fill in the settings you need. Restart the dev server after changes. Open http://localhost:3000. Set `APP_ACCESS_CODE` to use the shared team access gate locally. Hosted production requires an access code.

## 2. Connect your own Google Sheets

1. Enable the Google Sheets API in a Google Cloud project and create a service account.
2. Store the service-account JSON in `GOOGLE_SERVICE_ACCOUNT_JSON` on your host. For local development, you can use `GOOGLE_SERVICE_ACCOUNT_KEY_FILE` instead. Keep the file outside the repository.
3. Share your tracker with the service account email as **Editor** so confirmed sends can be recorded. Set `GOOGLE_SPREADSHEET_ID` to the spreadsheet ID from its URL.
4. Add the `Companies` and `Contacts` tabs. Put the following headers in row 1, in order. A company name is required for each company. A known official website helps avoid domain guessing. Each account can also have `Location` and `Notes` columns after the required company headers.

**Companies**

```text
Company ID | Company Name | Website | Priority | Research Status | Alignment Summary | Pitch Angle | Alignment Score | Confidence | Evidence URLs | Last Researched
```

**Contacts**

```text
Contact ID | Company ID | Company Name | Contact Name | Job Title | Work Email | LinkedIn URL | SFU/MISA Alum | Outreach Status | Channel | Reached Out By | Date Reached Out | Date Followed Up
```

Use `|` as a separator when reading these lists. Each header goes in its own cell. The app adds **Gmail Message ID** when it first records a Monetary send if the column is missing. It records **Email sent**, the Vancouver send date, the selected sender, and the message ID. Follow-up data on an existing contact stays intact.

For In-kind, set `IN_KIND_SPREADSHEET_ID` and `IN_KIND_TAB_GID` to your own sheet and tab. Its first row needs `DATE OF REQ`, `COMPANY`, `CONTACT INFO`, and `STATUS`. You can also use `PREV`, `CONTACTED BY`, and `GMAIL MESSAGE ID`. The Goal tab can read an optional `In-Kind Inventory` tab from `IN_KIND_INVENTORY_SPREADSHEET_ID`, with headers `ITEM`, `COMPANY`, a third column of your choice, and `VALUE $`.

## 3. Connect only the providers you need

| Feature | Settings |
| --- | --- |
| Find people and verified work emails | `HUNTER_API_KEY`. The app checks Hunter's Free-plan allowance. |
| Find the official company website as a fallback | `EXA_API_KEY` and `MONETARY_EXA_FALLBACK=true`. Enable the discovery fallback only with a verified free-only account. |
| Research and draft outreach | `EXA_API_KEY`, `OPENROUTER_API_KEY`, and compatible models. Check model and provider pricing before running a draft. |
| Optional contact and email fallbacks | `GETPROSPECT_API_KEY` and `PROSPEO_API_KEY`. The app checks included allowances. |
| Send approved drafts | `NEXT_PUBLIC_OUTREACH_MAILBOX` and `GMAIL_APP_PASSWORD`. Use your own Gmail sender and Google App Password. Leave the password blank while testing without sending. |

For providers and models, review `.env.example`. Legacy lookup providers are disabled by default. The sender mailbox is shown on the page. All passwords and API keys belong in server-side environment variables. Never prefix secrets with `NEXT_PUBLIC_`.

## 4. Customize before you send

- Set your real team roster in `src/lib/sheet-writes.ts` and update the default sender in `src/lib/outreach-content.ts` and `src/app/accounts-panel.tsx`.
- Update the example organization, events, and outreach text in `src/lib/misa-outreach-context.ts`, `src/lib/outreach-content.ts`, `src/lib/outreach-draft.ts`, and the In-kind draft and follow-up modules.
- Review the existing BC location, SFU affiliation checks, target roles, and Vancouver date defaults for your audience. Look in `src/lib/employee-normalize.ts`, `src/lib/monetary-directory.ts`, and `src/lib/in-kind-follow-ups.ts`.
- Try the workflow with a company and recipient you are authorized to use. Approve and confirm only when you are ready to send. If Gmail sends but tracker logging fails, use the displayed message ID to reconcile the tracker without sending again.

## 5. Host on your own Vercel project

Import your repository into Vercel. Add your settings to the appropriate Vercel environment before building. Use separate test spreadsheets and credentials for previews. The template has no linked Vercel project or deployment script.

Use `npm run lint` and `npm run build` to check changes before deploying your copy.
