// Relative import with the extension, matching the other unit-tested lib files: the
// "@/" alias is a bundler feature and does not resolve under plain `node --test`.
import {
  normalizeSourceReferences,
  type ResearchSourceReference,
} from "./research-synthesis.ts";

export type BulletId =
  | "community_impact"
  | "student_connection"
  | "talent_pipeline";

export type CanonicalBullet = {
  id: BulletId;
  text: string;
};

export type OutreachSender = {
  name: string;
  role: string;
};

export type DraftContact = {
  name: string;
  title: string;
  currentCompany: string;
  currentEmploymentEvidence: string;
  sfuConnection: "alumni" | "education" | null;
  sfuEvidence: string | null;
};

export type EmailSlots = {
  subject: string;
  whyYouSentence: string | null;
  whyYouSourceIds: string[];
  bullets: CanonicalBullet[];
};

// The user's approved outreach copy. Everything outside the personalization slots is
// reproduced verbatim, so the model cannot alter the value proposition or the voice.
export const CANONICAL_BULLETS: readonly CanonicalBullet[] = [
  {
    id: "community_impact",
    text: "Deepen your community impact by supporting initiatives that foster the next generation of business and technology professionals.",
  },
  {
    id: "student_connection",
    text: "Build meaningful connections with students through in-person engagement, networking opportunities, workshops, and experiential learning.",
  },
  {
    id: "talent_pipeline",
    text: "Strengthen your talent pipeline by connecting with motivated MIS students developing skills across technology, analytics, and business.",
  },
];

export const DEFAULT_SENDER: OutreachSender = {
  name: "Alex Example",
  role: "Director of Corporate Relations",
};

export const LINKEDIN_NOTE_MAX_LENGTH = 300;

function firstName(fullName: string) {
  return fullName.trim().split(/\s+/)[0] || fullName.trim();
}

/**
 * Assembles the final email from the fixed template plus the validated slots. The model
 * never produces the whole body; it only fills these gaps.
 */
export function assembleEmailBody({
  contact,
  companyName,
  sender,
  slots,
}: {
  contact: Pick<DraftContact, "name">;
  companyName: string;
  sender: OutreachSender;
  slots: Pick<EmailSlots, "whyYouSentence" | "bullets">;
}) {
  const bullets = slots.bullets.map((bullet) => `• ${bullet.text}`).join("\n");

  return [
    `Hello ${firstName(contact.name)},`,
    "",
    `My name is ${sender.name}, and I am the ${sender.role} for Example Student Association, a student-led business technology group.`,
    "",
    "Our mission is to provide students with workshops, networking events, and case competitions that support their professional development within Management Information Systems (MIS).",
    "",
    `We are currently exploring partnership opportunities with organizations like ${companyName} that share our commitment to investing in students, supporting professional development, and creating a lasting impact within the community.`,
    ...(slots.whyYouSentence ? ["", slots.whyYouSentence] : []),
    "",
    "Partnering with Example Student Association provides an opportunity to:",
    bullets,
    "",
    "I would appreciate the opportunity to discuss how we can create a mutually beneficial partnership and explore ways to collaborate. Alternatively, if there is another contact I should reach out to instead, please let me know.",
    "",
    "I look forward to hearing from you soon.",
    "",
    "Best regards,",
    sender.name,
  ].join("\n");
}

/**
 * A connection note has no room for the full template, so this is the compressed
 * equivalent: same introduction and same ask, no company-specific claim. It is always
 * safe to send and is what the caller falls back to when personalization is unavailable
 * or fails validation.
 */
export function buildFallbackLinkedInNote({
  contact,
  sender,
}: {
  contact: Pick<DraftContact, "name">;
  sender: OutreachSender;
}) {
  // The sender's name is omitted deliberately: LinkedIn shows it beside the request, so
  // repeating it spends characters the note cannot spare. The MISA role is kept because
  // the sender's profile headline reflects their employer, not their MISA position.
  const greeting = `Hello ${firstName(contact.name)}, I am the ${sender.role} for Example Student Association, a student-led business technology group.`;
  const ask =
    "Would you be open to discussing partnership opportunities with us this year?";
  const full = `${greeting} ${ask}`;

  if (full.length <= LINKEDIN_NOTE_MAX_LENGTH) return full;

  // A long role or company name can overrun the cap, so shed detail in order of
  // importance rather than truncating mid-sentence.
  // Shed the role, then the description, rather than truncating mid-sentence.
  const withoutRole = `Hello ${firstName(contact.name)}, I am with Example Student Association, a student-led business technology group. ${ask}`;
  if (withoutRole.length <= LINKEDIN_NOTE_MAX_LENGTH) return withoutRole;

  return `Hello ${firstName(contact.name)}, I am with Example Student Association. ${ask}`.slice(
    0,
    LINKEDIN_NOTE_MAX_LENGTH,
  );
}

/**
 * A note over the cap is unusable rather than merely imperfect, so it is rejected
 * outright instead of being truncated into a sentence fragment.
 */
export function validateLinkedInNote(value: unknown): string | null {
  const note = typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
  if (!note || note.length > LINKEDIN_NOTE_MAX_LENGTH) return null;
  return note;
}

/**
 * True when the research object carries at least one source-cited item worth
 * personalizing from. When false the caller should still send the template, just without
 * a "why you" sentence — the boilerplate asserts nothing about the company, so a failed
 * synthesis degrades the draft rather than blocking it.
 */
export function hasPersonalizationEvidence(research: unknown): boolean {
  const evidence = buildDraftEvidence(research);
  return evidence.claims.length > 0 || evidence.opportunities.length > 0;
}

export type DraftEvidence = {
  alignmentSummary: string | null;
  pitchAngle: string | null;
  claims: Array<{ claim: string; evidence: string; sourceIds: string[] }>;
  opportunities: Array<{ title: string; rationale: string; sourceIds: string[] }>;
  sources: ResearchSourceReference[];
};

function stringField(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function citedList<T>(
  value: unknown,
  map: (item: Record<string, unknown>) => T | null,
): T[] {
  if (!Array.isArray(value)) return [];

  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const item = entry as Record<string, unknown>;
    const sourceIds = Array.isArray(item.sourceIds)
      ? item.sourceIds.filter((id): id is string => typeof id === "string")
      : [];
    if (sourceIds.length === 0) return [];
    const mapped = map(item);
    return mapped ? [mapped] : [];
  });
}

/**
 * Narrows a research object down to the only facts the model is allowed to draw on:
 * items that already carry source citations. Anything uncited is withheld from the prompt
 * entirely rather than being offered and policed later.
 */
export function buildDraftEvidence(research: unknown): DraftEvidence {
  const value =
    research && typeof research === "object" && !Array.isArray(research)
      ? (research as Record<string, unknown>)
      : {};
  const sources = Array.isArray(value.sources)
    ? value.sources.flatMap((entry) => {
        if (!entry || typeof entry !== "object") return [];
        const source = entry as Record<string, unknown>;
        return typeof source.id === "string" && typeof source.url === "string"
          ? [{ id: source.id, url: source.url }]
          : [];
      })
    : [];

  return {
    alignmentSummary: stringField(value.alignmentSummary),
    pitchAngle: stringField(value.pitchAngle),
    claims: citedList(value.claims, (item) => {
      const claim = stringField(item.claim);
      const evidence = stringField(item.evidence);
      return claim && evidence
        ? { claim, evidence, sourceIds: item.sourceIds as string[] }
        : null;
    }),
    opportunities: citedList(value.partnershipOpportunities, (item) => {
      const title = stringField(item.title);
      const rationale = stringField(item.rationale);
      return title && rationale
        ? { title, rationale, sourceIds: item.sourceIds as string[] }
        : null;
    }),
    sources,
  };
}

export function sfuClaimAllowed(contact: Pick<DraftContact, "sfuConnection">) {
  return contact.sfuConnection !== null;
}

/**
 * Model output may reorder and lightly reword the benefit bullets, but must map onto the
 * canonical three exactly once each. This stops tailoring from drifting into a promise
 * MISA never made.
 */
export function validateBullets(value: unknown): CanonicalBullet[] | null {
  if (!Array.isArray(value) || value.length !== CANONICAL_BULLETS.length) return null;

  const allowed = new Map(CANONICAL_BULLETS.map((bullet) => [bullet.id, bullet]));
  const seen = new Set<BulletId>();
  const bullets: CanonicalBullet[] = [];

  for (const entry of value) {
    if (!entry || typeof entry !== "object") return null;
    const item = entry as Record<string, unknown>;
    const id = item.id;
    if (typeof id !== "string" || !allowed.has(id as BulletId)) return null;
    if (seen.has(id as BulletId)) return null;
    seen.add(id as BulletId);

    const text = stringField(item.text);
    bullets.push({
      id: id as BulletId,
      // Fall back to the approved wording if the model returned nothing usable.
      text: text ?? allowed.get(id as BulletId)!.text,
    });
  }

  return bullets.length === CANONICAL_BULLETS.length ? bullets : null;
}

const RELATIONSHIP_PATTERNS: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  { label: "asserts an existing partnership", pattern: /\bour\s+(existing|current|ongoing|long-?standing)?\s*partnership\s+with\b/i },
  { label: "asserts prior sponsorship", pattern: /\byour\s+(past|previous|continued|ongoing)?\s*(sponsorship|support)\s+of\s+(sfu|misa|our)/i },
  { label: "implies a returning partner", pattern: /\b(returning|existing|current|long-?standing)\s+partner\b/i },
  { label: "asserts prior support", pattern: /\byou(?:'ve|\s+have)?\s+(?:previously\s+)?(sponsored|supported|partnered\s+with)\b/i },
  { label: "implies continued support", pattern: /\b(continued|renewed)\s+(support|partnership)\b/i },
  { label: "implies a prior conversation", pattern: /\b(as\s+we\s+discussed|following\s+up\s+on\s+our|great\s+(?:speaking|meeting)\s+with\s+you)\b/i },
];

const SFU_CONNECTION_PATTERNS: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  { label: "claims an SFU alumni tie", pattern: /\balumn(?:us|a|i|ae)\b/i },
  { label: "claims a shared alma mater", pattern: /\b(fellow|as\s+a\s+fellow)\s+(sfu|beedie|simon\s+fraser)\b/i },
  { label: "claims the contact is an SFU graduate", pattern: /\b(your\s+time\s+at|you\s+graduated\s+from|since\s+your\s+days\s+at)\s+(sfu|simon\s+fraser|beedie)\b/i },
  { label: "claims a shared alma mater", pattern: /\bfellow\s+(graduate|grad|student)\b/i },
];

/**
 * Post-generation sweep for assertions the evidence does not support. Deliberately
 * conservative: it targets claims of an existing relationship or an SFU tie, which are
 * the two fabrications that would actually embarrass MISA in a real inbox.
 */
export function findUnsupportedClaims(
  draftText: string,
  { sfuAllowed }: { sfuAllowed: boolean },
): string[] {
  const checks = sfuAllowed
    ? RELATIONSHIP_PATTERNS
    : [...RELATIONSHIP_PATTERNS, ...SFU_CONNECTION_PATTERNS];

  return [
    ...new Set(
      checks.flatMap(({ label, pattern }) => {
        const match = draftText.match(pattern);
        return match ? [`${label}: "${match[0].trim()}"`] : [];
      }),
    ),
  ];
}

/**
 * The "why you" sentence is only kept when it cites a source that actually exists in the
 * research object, so a citation the model invented drops the sentence instead of
 * shipping it unsourced.
 */
export function resolveWhyYouSentence({
  sentence,
  sourceIds,
  sources,
}: {
  sentence: unknown;
  sourceIds: unknown;
  sources: readonly ResearchSourceReference[];
}): { sentence: string | null; sourceIds: string[] } {
  const text = stringField(sentence);
  const resolved = normalizeSourceReferences(sourceIds, sources);

  return text && resolved.length > 0
    ? { sentence: text, sourceIds: resolved }
    : { sentence: null, sourceIds: [] };
}
