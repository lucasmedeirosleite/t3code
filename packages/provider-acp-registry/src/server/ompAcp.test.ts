import { assert, describe, it } from "@effect/vitest";
import type { CreateElicitationRequest } from "effect-acp/compat";

import { extractOmpElicitationForm } from "./ompAcp.ts";

type FormRequest = Extract<CreateElicitationRequest, { readonly mode: "form" }>;
type Properties = NonNullable<FormRequest["requestedSchema"]["properties"]>;

const request = (properties: Properties, required?: ReadonlyArray<string>): FormRequest => ({
  mode: "form",
  message: "omp asks",
  requestId: 1,
  requestedSchema: { type: "object", properties, ...(required ? { required } : {}) },
});

const options = [
  { const: "A", title: "Alpha" },
  { const: "B", title: "Beta" },
];
const single = { type: "string", title: "What should I install?", oneOf: options } as const;
const multi = {
  type: "array",
  title: "What should I install?",
  items: { anyOf: options },
} as const;
const htmlOther = (description: string) =>
  ({ type: "string", title: "What should I install? — Other", description }) as const;
const singleOther = htmlOther("Your own answer instead");
const multiOther = htmlOther("Another answer, added to those checked");
const legacyOther = { type: "string", title: "Other (type your own)" } as const;

describe("extractOmpElicitationForm questions", () => {
  it("merges the askDialog q0__other field into its question", () => {
    const form = extractOmpElicitationForm(
      request({
        q0: { ...single, title: "Which format?", description: "Format" },
        q0__other: legacyOther,
      }),
    );
    assert(form !== undefined);
    assert.deepStrictEqual(
      form.questions.map(({ id, header, question, allowCustomAnswer }) => ({
        id,
        header,
        question,
        allowCustomAnswer,
      })),
      [{ id: "q0", header: "Format", question: "Which format?", allowCustomAnswer: undefined }],
    );
    assert.deepStrictEqual(
      form.questions[0]?.options.map((option) => option.value),
      ["A", "B"],
    );
  });

  it.each([
    {
      name: "required single choice",
      properties: { install: single, install_other: singleOther },
      multiSelect: undefined,
    },
    {
      name: "multi-select with minItems",
      properties: { install: { ...multi, minItems: 1 }, install_other: multiOther },
      multiSelect: true,
    },
  ])("merges the HTML form <name>_other field: $name", ({ properties, multiSelect }) => {
    const form = extractOmpElicitationForm(request(properties, ["install"]));
    assert(form !== undefined);
    assert.strictEqual(form.questions.length, 1);
    const [question] = form.questions;
    assert.strictEqual(question?.id, "install");
    assert.strictEqual(question?.question, "What should I install?");
    assert.strictEqual(question?.allowCustomAnswer, undefined);
    assert.strictEqual(question?.multiSelect, multiSelect);
  });

  it("pairs a choice with the collision-suffixed field, leaving a real field of the same name", () => {
    const form = extractOmpElicitationForm(
      request({
        install: single,
        install_other: { type: "string", title: "Install other tools" },
        install_other_: singleOther,
      }),
    );
    assert(form !== undefined);
    assert.deepStrictEqual(
      form.questions.map((question) => [question.id, question.allowCustomAnswer]),
      [
        ["install", undefined],
        ["install_other", undefined],
      ],
    );
    assert.deepStrictEqual(form.respond({ install: "x", install_other: "tools" }), {
      action: "accept",
      content: { install_other: "tools", install_other_: "x" },
    });
  });

  it.each([
    {
      name: "decoy title",
      properties: { foo: single, foo_other: { type: "string", title: "Foo notes" } },
    },
    {
      name: "Droid's untitled companion",
      properties: {
        question_1: {
          type: "string",
          title: "Format",
          description: "Which?",
          oneOf: [
            { const: "option_1", title: "JSON" },
            { const: "other", title: "Other" },
          ],
        },
        question_1_other: { type: "string" },
      },
      required: ["question_1"],
    },
    {
      name: "required companion",
      properties: { install: single, install_other: singleOther },
      required: ["install_other"],
    },
    {
      name: "companion with enum",
      properties: { install: single, install_other: { ...singleOther, enum: ["x"] } },
    },
    { name: "no companion", properties: { install: single } },
  ])("steps aside for forms that are not omp's: $name", ({ properties, required }) => {
    assert.strictEqual(extractOmpElicitationForm(request(properties, required)), undefined);
  });

  it("gives a shared companion to the first choice in property order", () => {
    const form = extractOmpElicitationForm(
      request({ a: single, a_: single, a__other: legacyOther }),
    );
    assert(form !== undefined);
    assert.deepStrictEqual(
      form.questions.map((question) => [question.id, question.allowCustomAnswer]),
      [
        ["a", undefined],
        ["a_", false],
      ],
    );
  });

  it("reads unpaired fields of an omp form as the shared reader does", () => {
    const form = extractOmpElicitationForm(
      request({
        install: single,
        install_other: singleOther,
        notes: { type: "string", title: "Notes" },
      }),
    );
    assert(form !== undefined);
    assert.deepStrictEqual(
      form.questions.map((question) => [question.id, question.header, question.options.length]),
      [
        ["install", "What should I install?", 2],
        ["notes", "Notes", 0],
      ],
    );
    assert.deepStrictEqual(form.respond({ install: "A", notes: "n" }), {
      action: "accept",
      content: { install: "A", notes: "n" },
    });
  });
});

describe("extractOmpElicitationForm answers", () => {
  const attachment = 'Attached image "a.png": "/p"';
  it.each([
    { name: "single pick", field: single, answer: "B", content: { install: "B" } },
    {
      name: "single typed text",
      field: single,
      answer: "something else",
      content: { install_other: "something else" },
    },
    {
      name: "single text equal to a listed value",
      field: single,
      answer: "A",
      content: { install: "A" },
    },
    {
      name: "single typed option label",
      field: single,
      answer: "Alpha",
      content: { install_other: "Alpha" },
    },
    {
      name: "single pick with attachment",
      field: single,
      answer: `B\n\n${attachment}`,
      content: { install_other: `B\n\n${attachment}` },
    },
    {
      name: "multi picks and text",
      field: multi,
      answer: ["A", "B", "also C"],
      content: { install: ["A", "B"], install_other: "also C" },
    },
    {
      name: "multi picks and attachment",
      field: multi,
      answer: ["A", "B", attachment],
      content: { install: ["A", "B"], install_other: attachment },
    },
    {
      name: "multi below minItems with text",
      field: { ...multi, minItems: 2 },
      answer: ["A", "x"],
      content: { install: ["A"], install_other: "x" },
    },
    {
      name: "multi above maxItems with text",
      field: { ...multi, maxItems: 1 },
      answer: ["A", "B", "x"],
      content: { install: ["A", "B"], install_other: "x" },
    },
    {
      name: "multi text only",
      field: { ...multi, minItems: 1 },
      answer: "x",
      content: { install_other: "x" },
    },
    {
      name: "multi picks with blank text",
      field: multi,
      answer: ["A", "  "],
      content: { install: ["A"] },
    },
    {
      name: "multi repeated picks",
      field: multi,
      answer: ["A", "A", 3],
      content: { install: ["A"] },
    },
    {
      name: "multi above maxItems without text",
      field: { ...multi, maxItems: 1 },
      answer: ["A", "B"],
      content: {},
    },
  ])("routes $name", ({ field, answer, content }) => {
    const form = extractOmpElicitationForm(
      request({ install: field, install_other: field.type === "array" ? multiOther : singleOther }),
    );
    assert(form !== undefined);
    assert.deepStrictEqual(form.respond({ install: answer }), { action: "accept", content });
  });

  it("routes the askDialog shape the same way", () => {
    const form = extractOmpElicitationForm(request({ q0: multi, q0__other: legacyOther }));
    assert(form !== undefined);
    assert.deepStrictEqual(form.respond({ q0: ["B", "also C"] }), {
      action: "accept",
      content: { q0: ["B"], q0__other: "also C" },
    });
  });

  it.each([
    {
      name: "single",
      field: single,
      answer: "something else",
      content: { install_other: "something else" },
    },
    {
      name: "multi",
      field: { ...multi, minItems: 1 },
      answer: ["x"],
      content: { install_other: "x" },
    },
  ])("answers a required $name choice with typed text alone", ({ field, answer, content }) => {
    const form = extractOmpElicitationForm(
      request({ install: field, install_other: singleOther }, ["install"]),
    );
    assert(form !== undefined);
    assert.deepStrictEqual(form.respond({ install: answer }), { action: "accept", content });
  });

  it.each([{ install: "  " }, {}, { install: ["  "] }])(
    "cancels a required choice with no pick and no text: %j",
    (answers) => {
      const form = extractOmpElicitationForm(
        request({ install: single, install_other: singleOther }, ["install"]),
      );
      assert(form !== undefined);
      assert.deepStrictEqual(form.respond(answers), { action: "cancel" });
    },
  );
});
