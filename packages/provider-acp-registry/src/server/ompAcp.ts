import type { OrchestrationV2UserInputQuestion } from "@t3tools/contracts";
import type { AcpAdapterV2Flavor } from "@t3tools/provider-acp/server/adapter";
import { unknownRecord } from "@t3tools/provider-acp/server/clientPolicy";
import { parseElicitationForm } from "@t3tools/provider-acp/server/elicitationForm";
import * as Predicate from "effect/Predicate";

interface Pair {
  readonly choiceId: string;
  readonly otherId: string;
  readonly property: Readonly<Record<string, unknown>>;
}

const text = (value: unknown) =>
  Predicate.isString(value) && value.trim().length > 0 ? value.trim() : undefined;

const hasChoices = (property: Readonly<Record<string, unknown>>) =>
  (property.enum ?? property.oneOf ?? undefined) !== undefined;

const isOmpOther = (property: Readonly<Record<string, unknown>> | undefined) =>
  property?.type === "string" &&
  !hasChoices(property) &&
  Predicate.isString(property.title) &&
  // oxlint-disable-next-line t3code/no-em-dash-copy -- Matches the title omp writes, not copy.
  (property.title === "Other (type your own)" || property.title.endsWith(" — Other"));

/** `<id>__other` (askDialog), then `<id>_other` plus any `_` omp adds on collisions, longest first. */
function otherCandidates(id: string, properties: Readonly<Record<string, unknown>>) {
  const prefix = `${id}_other`;
  const suffixed = Object.keys(properties)
    .filter((key) => key.startsWith(prefix) && /^_*$/.test(key.slice(prefix.length)))
    .toSorted((left, right) => right.length - left.length);
  return [`${id}__other`, ...suffixed];
}

// omp pairs each choice with an optional `_other`/`__other` text field and reads
// non-blank text there as the user's own answer, so show one question per pair.
export const extractOmpElicitationForm: NonNullable<
  AcpAdapterV2Flavor["extractElicitationForm"]
> = (request) => {
  if (request.mode !== "form" || !("requestedSchema" in request)) return undefined;
  const schema = unknownRecord(request.requestedSchema);
  const properties = unknownRecord(schema?.properties);
  if (schema === undefined || properties === undefined) return undefined;
  const required = new Set(
    Array.isArray(schema.required) ? schema.required.filter(Predicate.isString) : [],
  );
  const pairs: Array<Pair> = [];
  const otherIds = new Set<string>();
  for (const [choiceId, value] of Object.entries(properties)) {
    const property = unknownRecord(value);
    if (
      property === undefined ||
      !(property.type === "array" || (property.type === "string" && hasChoices(property)))
    ) {
      continue;
    }
    const otherId = otherCandidates(choiceId, properties).find(
      (candidate) =>
        Object.hasOwn(properties, candidate) &&
        !required.has(candidate) &&
        !otherIds.has(candidate) &&
        isOmpOther(unknownRecord(properties[candidate])),
    );
    if (otherId === undefined) continue;
    otherIds.add(otherId);
    pairs.push({ choiceId, otherId, property });
  }
  if (pairs.length === 0) return undefined;

  const pairByChoice = new Map(pairs.map((pair) => [pair.choiceId, pair]));
  // The pair's counts and required flag are checked in `respond`, where "Other" text is known.
  const parsed = parseElicitationForm(
    {
      ...schema,
      properties: Object.fromEntries(
        Object.entries(properties).flatMap(([id, value]): Array<[string, unknown]> => {
          if (otherIds.has(id)) return [];
          const pair = pairByChoice.get(id);
          if (pair === undefined) return [[id, value]];
          const property = { ...pair.property };
          delete property.minItems;
          delete property.maxItems;
          return [[id, property]];
        }),
      ),
      required: [...required].filter((id) => !pairByChoice.has(id)),
    },
    request.message,
  );
  if (parsed === undefined) return undefined;

  const questions = parsed.questions.map((question): OrchestrationV2UserInputQuestion => {
    const pair = pairByChoice.get(question.id);
    if (pair === undefined) return question;
    const { allowCustomAnswer: _allowCustomAnswer, ...rest } = question;
    return {
      ...rest,
      question: text(pair.property.title) ?? question.question,
      header: text(pair.property.description) ?? question.header,
    };
  });
  const valuesByChoice = new Map(
    questions.map((question) => [
      question.id,
      new Set(question.options.map((option) => option.value ?? option.label)),
    ]),
  );

  return {
    questions,
    respond: (answers) => {
      const routed = new Map(Object.entries(answers));
      const otherEntries: Array<[string, string]> = [];
      for (const { choiceId, otherId, property } of pairs) {
        const values = valuesByChoice.get(choiceId) ?? new Set<string>();
        const answer = routed.get(choiceId);
        const entries = [
          ...new Set((Array.isArray(answer) ? answer : [answer]).filter(Predicate.isString)),
        ];
        const picks = entries.filter((entry) => values.has(entry));
        const other = entries
          .filter((entry) => !values.has(entry))
          .map((entry) => entry.trim())
          .filter((entry) => entry.length > 0)
          .join(", ");
        routed.delete(choiceId);
        if (other !== "") otherEntries.push([otherId, other]);
        if (property.type === "array") {
          const minItems = typeof property.minItems === "number" ? property.minItems : 0;
          const maxItems = typeof property.maxItems === "number" ? property.maxItems : Infinity;
          // omp does not check counts, so typed text lifts them, as omp's own form does.
          const inRange = other !== "" || (picks.length >= minItems && picks.length <= maxItems);
          if (picks.length > 0 && inRange) routed.set(choiceId, picks);
          else if (required.has(choiceId) && other === "") return { action: "cancel" };
        } else if (other === "" && picks[0] !== undefined) {
          routed.set(choiceId, picks[0]);
        } else if (required.has(choiceId) && other === "") {
          return { action: "cancel" };
        }
      }
      const content = parsed.content(Object.fromEntries(routed));
      return content === undefined
        ? { action: "cancel" }
        : {
            action: "accept",
            content: Object.fromEntries([...Object.entries(content), ...otherEntries]),
          };
    },
  };
};
