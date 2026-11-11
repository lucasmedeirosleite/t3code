import type { AcpAdapterV2Flavor } from "@t3tools/provider-acp/server/adapter";
import { unknownRecord } from "@t3tools/provider-acp/server/clientPolicy";
import { parseElicitationForm } from "@t3tools/provider-acp/server/elicitationForm";

type Pair = {
  readonly otherId: string;
  readonly property: Record<string, unknown>;
};

// omp pairs each choice with optional _other/__other text and reads non-blank text there as the user's own answer.
export const extractOmpElicitationForm: NonNullable<
  AcpAdapterV2Flavor["extractElicitationForm"]
> = (request) => {
  if (request.mode !== "form" || !("requestedSchema" in request)) return undefined;
  const schema = unknownRecord(request.requestedSchema);
  const properties = unknownRecord(schema?.properties);
  if (properties === undefined) return undefined;
  const required = new Set(
    Array.isArray(schema?.required)
      ? schema.required.filter((id): id is string => typeof id === "string")
      : [],
  );
  const pairs = new Map<string, Pair>();
  const pairedOtherIds = new Set<string>();
  const propertyIds = Object.keys(properties);
  for (const [id, value] of Object.entries(properties)) {
    const property = unknownRecord(value);
    if (
      property === undefined ||
      (property.type !== "array" &&
        !(property.type === "string" && (property.enum ?? property.oneOf) != null))
    )
      continue;
    const prefix = `${id}_other`;
    const candidates = [
      `${id}__other`,
      ...propertyIds
        .filter((key) => key.startsWith(prefix) && /^_*$/.test(key.slice(prefix.length)))
        .sort((a, b) => b.length - a.length),
    ];
    for (const otherId of candidates) {
      const other = Object.hasOwn(properties, otherId)
        ? unknownRecord(properties[otherId])
        : undefined;
      if (
        other?.type !== "string" ||
        other.enum != null ||
        other.oneOf != null ||
        required.has(otherId) ||
        pairedOtherIds.has(otherId) ||
        typeof other.title !== "string"
      )
        continue;
      if (
        other.title !== "Other (type your own)" &&
        // oxlint-disable-next-line t3code/no-em-dash-copy -- Matches the title omp writes, not copy.
        !other.title.endsWith(" — Other")
      )
        continue;
      pairs.set(id, { otherId, property });
      pairedOtherIds.add(otherId);
      break;
    }
  }
  if (pairs.size === 0) return undefined;
  const reducedProperties = Object.entries(properties)
    .filter(([id]) => !pairedOtherIds.has(id))
    .map(([id, value]) => {
      const pair = pairs.get(id);
      if (pair === undefined) return [id, value];
      const property = { ...pair.property };
      delete property.minItems;
      delete property.maxItems;
      return [id, property];
    });
  const parsed = parseElicitationForm(
    {
      ...schema,
      properties: Object.fromEntries(reducedProperties),
      required: [...required].filter((id) => !pairs.has(id)),
    },
    request.message,
  );
  if (parsed === undefined) return undefined;
  const questions = parsed.questions.map((question) => {
    const pair = pairs.get(question.id);
    if (pair === undefined) return question;
    const title = pair.property.title;
    const description = pair.property.description;
    const merged = {
      ...question,
      question: typeof title === "string" && title.trim() !== "" ? title.trim() : question.question,
      header:
        typeof description === "string" && description.trim() !== ""
          ? description.trim()
          : question.header,
    };
    delete merged.allowCustomAnswer;
    return merged;
  });
  return {
    questions,
    respond: (answers) => {
      const routed = new Map(Object.entries(answers));
      const otherEntries: Array<[string, string]> = [];
      for (const question of questions) {
        const pair = pairs.get(question.id);
        if (pair === undefined) continue;
        const answer = Object.hasOwn(answers, question.id) ? answers[question.id] : undefined;
        const entries = [
          ...new Set(
            (Array.isArray(answer) ? answer : [answer]).filter(
              (entry): entry is string => typeof entry === "string",
            ),
          ),
        ];
        const values = new Set(question.options.map((option) => option.value ?? option.label));
        const picks = entries.filter((entry) => values.has(entry));
        const otherText = entries
          .filter((entry) => !values.has(entry))
          .map((entry) => entry.trim())
          .filter((entry) => entry !== "")
          .join(", ");
        routed.delete(question.id);
        const minItems = typeof pair.property.minItems === "number" ? pair.property.minItems : 0;
        const maxItems =
          typeof pair.property.maxItems === "number" ? pair.property.maxItems : Infinity;
        const outOfRange =
          question.multiSelect === true && (picks.length < minItems || picks.length > maxItems);
        if (otherText === "" && (picks.length === 0 || outOfRange)) {
          if (required.has(question.id)) return { action: "cancel" };
          continue;
        }
        if (otherText !== "") otherEntries.push([pair.otherId, otherText]);
        if (question.multiSelect === true) {
          if (picks.length > 0) routed.set(question.id, picks);
        } else if (otherText === "" && picks[0] !== undefined) {
          routed.set(question.id, picks[0]);
        }
      }
      const content = parsed.content(Object.fromEntries(routed));
      return content === undefined
        ? { action: "cancel" }
        : { action: "accept", content: { ...content, ...Object.fromEntries(otherEntries) } };
    },
  };
};
