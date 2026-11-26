export const IN_KIND_ASK_SLOT = "{inKindAsk}";

export const DEFAULT_IN_KIND_ASK_PARAGRAPH =
  "We are kindly requesting in-kind donations, such as [insert—gift cards, merchandise, vouchers, etc.], which will be used as raffle prizes for our event attendees or as internal prizes for association members.";

const PAST_SPONSOR_ACKNOWLEDGMENT =
  "We noticed that your organization has supported student clubs in the past, and we appreciate your commitment to student initiatives.";

const IN_KIND_ASKS = {
  warm: "We would be grateful to receive an in-kind contribution, such as [insert—gift cards, merchandise, vouchers, etc.], to use as raffle prizes for event attendees or internal prizes for association members.",
  direct:
    "We are requesting an in-kind donation, such as [insert—gift cards, merchandise, vouchers, etc.], for raffle prizes at our events or internal prizes for association members.",
  concise:
    "We are seeking an in-kind contribution of [insert—gift cards, merchandise, vouchers, etc.] for event raffles or internal association member prizes.",
} satisfies Record<string, string>;

export type InKindAskVariant = keyof typeof IN_KIND_ASKS;

export function isInKindAskVariant(
  value: unknown,
): value is InKindAskVariant {
  return value === "warm" || value === "direct" || value === "concise";
}

export function getInKindAskParagraph(variant: InKindAskVariant) {
  return IN_KIND_ASKS[variant];
}

export function hasExactlyOneInKindAskSlot(template: string) {
  return template.split(IN_KIND_ASK_SLOT).length - 1 === 1;
}

export function insertPastSponsorAcknowledgment(body: string) {
  if (/supported student clubs in the past/i.test(body)) return body;
  if (!body.includes(DEFAULT_IN_KIND_ASK_PARAGRAPH)) {
    throw new Error("The in-kind ask paragraph could not be located.");
  }
  return body.replace(
    DEFAULT_IN_KIND_ASK_PARAGRAPH,
    PAST_SPONSOR_ACKNOWLEDGMENT +
      "\n\n" +
      DEFAULT_IN_KIND_ASK_PARAGRAPH,
  );
}

export function assembleInKindDraftBody({
  filledTemplate,
  askParagraph,
  pastStudentClubSponsor,
}: {
  filledTemplate: string;
  askParagraph: string;
  pastStudentClubSponsor: boolean;
}) {
  if (!hasExactlyOneInKindAskSlot(filledTemplate)) {
    throw new Error(
      "The editable template must contain exactly one {inKindAsk} slot.",
    );
  }

  const replacement = pastStudentClubSponsor
    ? PAST_SPONSOR_ACKNOWLEDGMENT + "\n\n" + askParagraph
    : askParagraph;
  return filledTemplate.replace(IN_KIND_ASK_SLOT, replacement);
}
