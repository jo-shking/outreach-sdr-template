import "server-only";

import { isSameCompanyName } from "@/lib/company-identity";
import {
  assembleEmailBody,
  buildDraftEvidence,
  buildFallbackLinkedInNote,
  CANONICAL_BULLETS,
  findUnsupportedClaims,
  hasPersonalizationEvidence,
  LINKEDIN_NOTE_MAX_LENGTH,
  resolveWhyYouSentence,
  sfuClaimAllowed,
  validateBullets,
  validateLinkedInNote,
  type BulletId,
  type CanonicalBullet,
  type DraftContact,
  type OutreachSender,
} from "@/lib/outreach-content";
import { parseResearchObject } from "@/lib/research-synthesis";

export class OutreachDraftConfigurationError extends Error {}

export class OutreachDraftError extends Error {
  constructor(
    message: string,
    public readonly failure: "timeout" | "network" | "rejected" | "invalid_response" | "mismatch",
    public readonly status?: number,
  ) {
    super(message);
  }
}

export type OutreachDraft = {
  channel: "email";
  subject: string;
  body: string;
  recipientEmail: string | null;
  whyYouSourceIds: string[];
  bulletOrder: BulletId[];
  personalized: boolean;
  violations: string[];
  limitations: string[];
};

export type LinkedInNoteDraft = {
  channel: "linkedin_note";
  note: string;
  profileUrl: string | null;
  sourceIds: string[];
  personalized: boolean;
  violations: string[];
  limitations: string[];
};

const FALLBACK_SUBJECT = "Partnership opportunity with Example Student Association";
const MAX_SUBJECT_LENGTH = 120;
const MAX_SENTENCE_LENGTH = 400;
// The drafts themselves are tiny — a 300-character note is roughly 80 tokens — but
// reasoning models spend this same budget thinking before they emit anything. At 1,200
// the model reliably hit finish_reason "length" and returned empty content, which
// surfaced as an unexplained fallback. Completion tokens are cheap enough that generous
// headroom costs a fraction of a cent.
const MAX_DRAFT_TOKENS = 8_000;
// Drafting needs a short, constrained JSON answer. deepseek-v4-flash is a reasoning
// model: it spent the whole token budget thinking and returned empty content on roughly
// three of every four drafts, even at 8,000 tokens. Research synthesis still uses
// OPENROUTER_MODEL, where the lower price is worth an occasional retry.
const DEFAULT_DRAFT_MODEL = "openai/gpt-5.2";

function draftModel() {
  return process.env.OPENROUTER_DRAFT_MODEL?.trim() || DEFAULT_DRAFT_MODEL;
}

type OpenRouterResponse = {
  choices?: Array<{
    finish_reason?: string | null;
    message?: { content?: string | null };
  }>;
};

function requiredEnvironment(name: string) {
  const value = process.env[name]?.trim();

  if (!value) {
    throw new OutreachDraftConfigurationError(
      `${name} is not configured on the server.`,
    );
  }

  return value;
}

function isTimeoutError(error: unknown) {
  return (
    error instanceof Error &&
    (error.name === "TimeoutError" || error.name === "AbortError")
  );
}

function clamp(value: unknown, maxLength: number) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) || null : null;
}

function evidencePacket(evidence: ReturnType<typeof buildDraftEvidence>) {
  return [
    evidence.alignmentSummary
      ? `Alignment summary: ${evidence.alignmentSummary}`
      : null,
    evidence.pitchAngle ? `Strongest angle: ${evidence.pitchAngle}` : null,
    ...evidence.claims.map(
      (claim) =>
        `Claim [${claim.sourceIds.join(", ")}]: ${claim.claim} — ${claim.evidence}`,
    ),
    ...evidence.opportunities.map(
      (opportunity) =>
        `Opportunity [${opportunity.sourceIds.join(", ")}]: ${opportunity.title} — ${opportunity.rationale}`,
    ),
  ]
    .filter(Boolean)
    .join("\n");
}

async function requestDraftSlots({
  apiKey,
  model,
  systemPrompt,
  userPrompt,
}: {
  apiKey: string;
  model: string;
  systemPrompt: string;
  userPrompt: string;
}): Promise<Record<string, unknown>> {
  let response: Response;

  try {
    response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        response_format: { type: "json_object" },
        // Prose needs a little latitude; the factual guardrails are enforced in code.
        temperature: 0.3,
        max_tokens: MAX_DRAFT_TOKENS,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
      }),
      cache: "no-store",
      signal: AbortSignal.timeout(60_000),
    });
  } catch (error) {
    throw new OutreachDraftError(
      isTimeoutError(error)
        ? "OpenRouter took longer than 60 seconds to draft the email."
        : "The server could not reach OpenRouter to draft the email.",
      isTimeoutError(error) ? "timeout" : "network",
    );
  }

  if (!response.ok) {
    throw new OutreachDraftError(
      "OpenRouter rejected the outreach draft request.",
      "rejected",
      response.status,
    );
  }

  let data: OpenRouterResponse;

  try {
    data = (await response.json()) as OpenRouterResponse;
  } catch (error) {
    throw new OutreachDraftError(
      isTimeoutError(error)
        ? "OpenRouter took longer than 60 seconds to draft the email."
        : "OpenRouter returned an unreadable draft response.",
      isTimeoutError(error) ? "timeout" : "invalid_response",
    );
  }

  const content = data.choices?.[0]?.message?.content;

  if (!content) {
    // finish_reason "length" means the token budget was spent before any content was
    // emitted, which is a cap problem rather than a refusal.
    console.error("Outreach draft returned empty content", {
      finishReason: data.choices?.[0]?.finish_reason ?? null,
      choiceCount: data.choices?.length ?? 0,
    });

    throw new OutreachDraftError(
      "OpenRouter returned no outreach draft.",
      "invalid_response",
    );
  }

  const parsed = parseResearchObject(content);

  if (!parsed) {
    console.error("Outreach draft content was not a JSON object", {
      finishReason: data.choices?.[0]?.finish_reason ?? null,
      contentPrefix: content.slice(0, 200),
    });

    throw new OutreachDraftError(
      "OpenRouter returned the draft in an unreadable format.",
      "invalid_response",
    );
  }

  return parsed;
}

export async function generateEmailDraft({
  companyName,
  research,
  contact,
  sender,
  recipientEmail,
  misaEvents,
  partnershipFormats,
}: {
  companyName: string;
  research: unknown;
  contact: DraftContact;
  sender: OutreachSender;
  recipientEmail: string | null;
  misaEvents: string | null;
  partnershipFormats: string | null;
}): Promise<OutreachDraft> {
  // Guard against drafting to someone who does not actually work at this account —
  // the same identity hazard company-identity.ts was written for.
  if (!isSameCompanyName(companyName, contact.currentCompany)) {
    throw new OutreachDraftError(
      `${contact.name} is not verified as a current ${companyName} employee, so no draft was written.`,
      "mismatch",
    );
  }

  const sfuAllowed = sfuClaimAllowed(contact);
  const limitations: string[] = [];

  if (!recipientEmail) {
    limitations.push(
      "No verified work email was found for this contact, so the draft has no recipient address. Do not guess one.",
    );
  }

  const templateOnlyDraft = (reason: string): OutreachDraft => {
    const bullets = [...CANONICAL_BULLETS];

    return {
      channel: "email",
      subject: FALLBACK_SUBJECT,
      body: assembleEmailBody({
        contact,
        companyName,
        sender,
        slots: { whyYouSentence: null, bullets },
      }),
      recipientEmail,
      whyYouSourceIds: [],
      bulletOrder: bullets.map((bullet) => bullet.id),
      personalized: false,
      violations: [],
      limitations: [...limitations, reason],
    };
  };

  // The template asserts nothing about the company, so a failed or uncited research run
  // still yields a sendable draft — just without the personalized sentence. This also
  // skips a paid model call that would have nothing to draw on.
  if (!hasPersonalizationEvidence(research)) {
    return templateOnlyDraft(
      "The research for this account has no source-cited findings, so the template was produced without a personalized sentence or tailored bullet order.",
    );
  }

  const apiKey = requiredEnvironment("OPENROUTER_API_KEY");
  const model = draftModel();
  const evidence = buildDraftEvidence(research);
  const systemPrompt = [
    "You personalize partnership outreach for Example Student Association, a student-led business technology group.",
    "You do not write the email. You fill a small number of slots in a fixed, approved template.",
    "Use only the supplied evidence for statements about the company. Never state a company fact that the evidence does not support.",
    "Never claim or imply an existing relationship, prior sponsorship, prior donation, prior partnership, or a previous conversation. No relationship exists yet; this is a first approach.",
    sfuAllowed
      ? "This contact has a verified SFU connection. You may reference it only in the terms of the supplied SFU evidence."
      : "This contact has NO verified SFU connection. Never suggest they attended SFU, are an alum, or share an alma mater with the sender.",
    "Do not invent an employee, an alumni link, a hiring pattern, a program, or a donation.",
    "Return JSON only.",
  ].join(" ");
  const userPrompt = [
    `Company: ${companyName}`,
    `Contact: ${contact.name}, ${contact.title}`,
    `Current-employment evidence: ${contact.currentEmploymentEvidence}`,
    sfuAllowed && contact.sfuEvidence
      ? `Verified SFU connection (${contact.sfuConnection}): ${contact.sfuEvidence}`
      : "Verified SFU connection: none.",
    "",
    `MISA events and audiences: ${misaEvents?.slice(0, 5_000) || "None provided"}`,
    `Partnership formats MISA can offer: ${partnershipFormats?.slice(0, 5_000) || "None provided"}`,
    "",
    "Evidence about the company (the only permitted basis for company statements):",
    evidencePacket(evidence),
    "",
    "The approved benefit bullets, which you may reorder and lightly reword but never replace:",
    ...CANONICAL_BULLETS.map((bullet) => `${bullet.id}: ${bullet.text}`),
    "",
    "Return one JSON object with exactly these fields:",
    '- subject: string, at most 90 characters, specific to this company, no exclamation marks, no "Re:" prefix',
    "- whyYouSentence: one sentence of at most 45 words stating why this company specifically, drawn only from the evidence, or null if the evidence does not support one",
    "- whyYouSourceIds: array of the source IDs (S1, S2, ...) that support whyYouSentence; required if whyYouSentence is not null",
    "- bullets: array of exactly 3 objects with id and text; use each supplied id exactly once, ordered most to least relevant to this company based on the evidence; keep each bullet's substance identical and reword only lightly",
    "",
    "Do not return the email body, a greeting, or a signature. Only the slots above.",
  ].join("\n");

  let slots: Record<string, unknown> | null = null;
  let violations: string[] = [];
  let body = "";
  let subject = FALLBACK_SUBJECT;
  let whyYou: { sentence: string | null; sourceIds: string[] } = {
    sentence: null,
    sourceIds: [],
  };
  let bullets: CanonicalBullet[] = [...CANONICAL_BULLETS];

  // One corrective retry when the output asserts something unsupported, mirroring how
  // research synthesis retries an uncited response before degrading.
  try {
    for (const attempt of [0, 1]) {
      slots = await requestDraftSlots({
        apiKey,
        model,
        systemPrompt:
          attempt === 0
            ? systemPrompt
            : `${systemPrompt} A previous attempt asserted something the evidence does not support (${violations.join("; ")}). Remove any such claim entirely.`,
        userPrompt,
      });

      subject = clamp(slots.subject, MAX_SUBJECT_LENGTH) ?? FALLBACK_SUBJECT;
      whyYou = resolveWhyYouSentence({
        sentence: clamp(slots.whyYouSentence, MAX_SENTENCE_LENGTH),
        sourceIds: slots.whyYouSourceIds,
        sources: evidence.sources,
      });
      bullets = validateBullets(slots.bullets) ?? [...CANONICAL_BULLETS];
      body = assembleEmailBody({
        contact,
        companyName,
        sender,
        slots: { whyYouSentence: whyYou.sentence, bullets },
      });
      violations = findUnsupportedClaims(body, { sfuAllowed });

      if (violations.length === 0) break;
    }
  } catch (error) {
    if (!(error instanceof OutreachDraftError)) throw error;

    // An auth or quota rejection is a real configuration problem worth surfacing. Any
    // other model failure degrades to the approved template, which stands on its own and
    // asserts nothing about the company — far more useful than failing the request.
    if (error.failure === "rejected") throw error;

    console.error("Outreach personalization failed; returning template only", {
      failure: error.failure,
      companyName,
    });

    return templateOnlyDraft(
      `Personalization was unavailable (${error.message}) so the approved template was produced without a personalized sentence or tailored bullet order.`,
    );
  }

  if (violations.length > 0) {
    limitations.push(
      "The draft still contains claims the evidence does not support. Review the flagged phrases before using it.",
    );
  }

  if (!whyYou.sentence) {
    limitations.push(
      "No personalized sentence survived citation checking, so the template was produced without one.",
    );
  }

  if (!validateBullets(slots?.bullets)) {
    limitations.push(
      "The tailored bullet order was rejected, so the approved bullets were used in their original order.",
    );
  }

  return {
    channel: "email",
    subject,
    body,
    recipientEmail,
    whyYouSourceIds: whyYou.sourceIds,
    bulletOrder: bullets.map((bullet) => bullet.id),
    personalized: Boolean(whyYou.sentence),
    violations,
    limitations,
  };
}

export async function generateLinkedInNote({
  companyName,
  research,
  contact,
  sender,
  profileUrl,
  misaEvents,
  partnershipFormats,
}: {
  companyName: string;
  research: unknown;
  contact: DraftContact;
  sender: OutreachSender;
  profileUrl: string | null;
  misaEvents: string | null;
  partnershipFormats: string | null;
}): Promise<LinkedInNoteDraft> {
  if (!isSameCompanyName(companyName, contact.currentCompany)) {
    throw new OutreachDraftError(
      `${contact.name} is not verified as a current ${companyName} employee, so no note was written.`,
      "mismatch",
    );
  }

  const sfuAllowed = sfuClaimAllowed(contact);
  // The compressed introduction makes no company-specific claim, so it is always safe to
  // send and serves as the degrade path for every failure below.
  const fallbackNote = (reason: string): LinkedInNoteDraft => ({
    channel: "linkedin_note",
    note: buildFallbackLinkedInNote({ contact, sender }),
    profileUrl,
    sourceIds: [],
    personalized: false,
    violations: [],
    limitations: [reason],
  });

  if (!hasPersonalizationEvidence(research)) {
    return fallbackNote(
      "The research for this account has no source-cited findings, so the note was produced without a personalized line.",
    );
  }

  const apiKey = requiredEnvironment("OPENROUTER_API_KEY");
  const model = draftModel();
  const evidence = buildDraftEvidence(research);
  const systemPrompt = [
    "You write short LinkedIn connection notes for Example Student Association, a student-led business technology group.",
    `The note must be at most ${LINKEDIN_NOTE_MAX_LENGTH} characters, including spaces. LinkedIn rejects anything longer.`,
    "Match the register of the reference email supplied below: professional and courteous, complete sentences, no contractions where the reference avoids them. Open with \"Hello \" and the contact's first name, as the reference does.",
    "Never state the sender's own name. LinkedIn displays it beside the request, so repeating it wastes characters the note cannot spare. Do state the sender's MISA role, because their profile headline shows their employer rather than their MISA position.",
    "Name a specific MISA event or partnership format from the supplied context — the concrete thing being proposed, not a general offer to collaborate.",
    "Use only the supplied evidence for statements about the company. Never state a company fact the evidence does not support.",
    "Never claim or imply an existing relationship, prior sponsorship, prior donation, or a previous conversation. This is a first approach.",
    sfuAllowed
      ? "This contact has a verified SFU connection. Acknowledge that shared connection early, in the terms of the supplied SFU evidence and nothing beyond it. It is the warmest opening available and should not be left out."
      : "This contact has NO verified SFU connection. Never suggest they attended SFU, are an alum, or share an alma mater with the sender.",
    // A first message that proposes a specific event reads as presumptuous and narrows
    // the conversation before it starts; the specifics belong in the reply.
    "Do not propose a specific event, workshop, office visit or format, and do not name one. Ask only to discuss partnership opportunities.",
    "No marketing language, no exclamation marks, no emoji.",
    "Return JSON only.",
  ].join(" ");
  // The approved email is supplied purely as a voice reference so the note sounds like the
  // same person wrote it. It is far too long for a connection note and must not be copied.
  const voiceReference = assembleEmailBody({
    contact,
    companyName,
    sender,
    slots: { whyYouSentence: null, bullets: [...CANONICAL_BULLETS] },
  });
  const userPrompt = [
    `Company: ${companyName}`,
    `Contact: ${contact.name}, ${contact.title}`,
    sfuAllowed && contact.sfuEvidence
      ? `Verified SFU connection (${contact.sfuConnection}): ${contact.sfuEvidence}`
      : "Verified SFU connection: none.",
    `Sender's MISA role: ${sender.role} (do not write the sender's name)`,
    "",
    "Reference email — match this tone and formality, do not reuse its length or structure:",
    voiceReference,
    "",
    "Background on MISA, for your understanding only — do not name any of these events or",
    "formats in the note, since a first message should not propose specifics:",
    misaEvents?.slice(0, 2_000) || "None provided",
    partnershipFormats?.slice(0, 2_000) || "None provided",
    "",
    "Evidence about the company (the only permitted basis for company statements):",
    evidencePacket(evidence),
    "",
    "Return one JSON object with exactly these fields:",
    `- note: the connection note, at most ${LINKEDIN_NOTE_MAX_LENGTH} characters. Structure it as: (1) "Hello " and the contact's first name; ${
      sfuAllowed
        ? "(2) one clause acknowledging the shared SFU connection; (3)"
        : "(2)"
    } the sender's role written so that MISA is the association and the sender is not — use the pattern "I am the ${sender.role} for Example Student Association, a student-led business technology group" and never a phrasing that makes the sender sound like the organisation itself; ${
      sfuAllowed ? "(4)" : "(3)"
    } one specific reason this company fits, drawn from the evidence; ${
      sfuAllowed ? "(5)" : "(4)"
    } a closing question asking whether they would be open to discussing partnership opportunities. No signature or sign-off line, and no specific event named.`,
    "- sourceIds: array of the source IDs (S1, S2, ...) supporting the company-specific reason. At least one is required.",
    "",
    "Do not return an email, a subject line, or any text outside the JSON.",
  ].join("\n");

  let violations: string[] = [];
  let note: string | null = null;
  let sourceIds: string[] = [];

  try {
    for (const attempt of [0, 1]) {
      const slots = await requestDraftSlots({
        apiKey,
        model,
        systemPrompt:
          attempt === 0
            ? systemPrompt
            : `${systemPrompt} A previous attempt failed validation (${[...violations, note === null ? "note missing or over the character limit" : ""].filter(Boolean).join("; ")}). Fix it and stay within the character limit.`,
        userPrompt,
      });
      const candidate = validateLinkedInNote(slots.note);
      // Reuse the email path's citation check: a note whose cited sources do not resolve
      // is treated as uncited and discarded rather than sent.
      const resolved = resolveWhyYouSentence({
        sentence: candidate,
        sourceIds: slots.sourceIds,
        sources: evidence.sources,
      });

      note = resolved.sentence;
      sourceIds = resolved.sourceIds;
      violations = note ? findUnsupportedClaims(note, { sfuAllowed }) : [];

      if (note && violations.length === 0) break;
      note = null;
    }
  } catch (error) {
    if (!(error instanceof OutreachDraftError)) throw error;
    if (error.failure === "rejected") throw error;

    console.error("LinkedIn note personalization failed; returning fallback", {
      failure: error.failure,
      companyName,
    });

    return fallbackNote(
      `Personalization was unavailable (${error.message}) so a general introduction was produced instead.`,
    );
  }

  if (!note) {
    return fallbackNote(
      violations.length > 0
        ? `The personalized note asserted something the evidence does not support (${violations.join("; ")}), so a general introduction was produced instead.`
        : "The personalized note was missing, uncited, or over the character limit, so a general introduction was produced instead.",
    );
  }

  return {
    channel: "linkedin_note",
    note,
    profileUrl,
    sourceIds,
    personalized: true,
    violations: [],
    limitations: [],
  };
}
