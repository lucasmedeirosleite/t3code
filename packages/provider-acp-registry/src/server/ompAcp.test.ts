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
    assert.isDefined(form);
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
    { name: "required single", field: single, multiSelect: undefined },
    { name: "multi with minItems", field: { ...multi, minItems: 1 }, multiSelect: true },
  ])("merges the HTML form <name>_other field for $name", ({ field, multiSelect }) => {
    const form = extractOmpElicitationForm(
      request({ install: field, install_other: singleOther }, ["install"]),
    );
    assert.isDefined(form);
    assert.deepStrictEqual(
      form.questions.map(({ id, question, allowCustomAnswer, multiSelect }) => ({
        id,
        question,
        allowCustomAnswer,
        multiSelect,
      })),
      [
        {
          id: "install",
          question: "What should I install?",
          allowCustomAnswer: undefined,
          multiSelect,
        },
      ],
    );
  });

  it("pairs a choice with the collision-suffixed field, leaving a real field of the same name", () => {
    const form = extractOmpElicitationForm(
      request({
        install: single,
        install_other: { type: "string", title: "Install other tools" },
        install_other_: singleOther,
      }),
    );
    assert.isDefined(form);
    assert.deepStrictEqual(
      form.questions.map(({ id, allowCustomAnswer }) => [id, allowCustomAnswer]),
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
      name: "Droid",
      properties: {
        question_1: {
          type: "string",
          oneOf: [
            { const: "option_1", title: "One" },
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
      name: "enumerated companion",
      properties: { install: single, install_other: { ...singleOther, enum: ["x"] } },
    },
    { name: "choice alone", properties: { install: single } },
  ] satisfies Array<{ name: string; properties: Properties; required?: ReadonlyArray<string> }>)(
    "steps aside for forms that are not omp's: $name",
    ({ properties, required }) => {
      assert.isUndefined(extractOmpElicitationForm(request(properties, required)));
    },
  );

  it("gives a shared companion to the first choice in property order", () => {
    const form = extractOmpElicitationForm(
      request({ a: single, a_: single, a__other: legacyOther }),
    );
    assert.isDefined(form);
    assert.deepStrictEqual(
      form.questions.map(({ id, allowCustomAnswer }) => [id, allowCustomAnswer]),
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
    assert.isDefined(form);
    assert.deepStrictEqual(
      form.questions.map(({ id, header, options }) => [id, header, options.length]),
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

  it("routes two pairs in one form independently", () => {
    const form = extractOmpElicitationForm(
      request({
        install: single,
        install_other: singleOther,
        tools: { ...multi, title: "Which tools?" },
        tools_other: { type: "string", title: "Which tools? — Other" },
      }),
    );
    assert.isDefined(form);
    assert.deepStrictEqual(
      form.questions.map(({ id }) => id),
      ["install", "tools"],
    );
    assert.deepStrictEqual(form.respond({ install: "x", tools: ["A", "y"] }), {
      action: "accept",
      content: { install_other: "x", tools: ["A"], tools_other: "y" },
    });
  });

  it("pairs an Other field that precedes its choice", () => {
    const form = extractOmpElicitationForm(
      request({ install_other: singleOther, install: single }),
    );
    assert.isDefined(form);
    assert.deepStrictEqual(
      form.questions.map(({ id }) => id),
      ["install"],
    );
  });

  it("matches candidate names literally", () => {
    const form = extractOmpElicitationForm(
      request({ "a.b": single, "a.b_other": singleOther, axb_other: singleOther }),
    );
    assert.isDefined(form);
    assert.deepStrictEqual(
      form.questions.map(({ id }) => id),
      ["a.b", "axb_other"],
    );
    assert.deepStrictEqual(form.respond({ "a.b": "x" }), {
      action: "accept",
      content: { "a.b_other": "x" },
    });
  });

  it("numbers fallback headers over shown questions", () => {
    const form = extractOmpElicitationForm(
      request({
        q0: { type: "string", oneOf: options },
        q0__other: legacyOther,
        notes: { type: "string" },
      }),
    );
    assert.isDefined(form);
    assert.deepStrictEqual(
      form.questions.map(({ header }) => header),
      ["Question 1", "Question 2"],
    );
  });

  it.each([
    {
      name: "askDialog first",
      companions: { install_other___: singleOther, install__other: legacyOther },
      otherId: "install__other",
    },
    {
      name: "longest suffix first",
      companions: {
        install_other: singleOther,
        install_other__: singleOther,
        install_other_: singleOther,
      },
      otherId: "install_other__",
    },
  ])("prefers candidates in omp order: $name", ({ companions, otherId }) => {
    const form = extractOmpElicitationForm(request({ install: single, ...companions }));
    assert.isDefined(form);
    assert.deepStrictEqual(form.respond({ install: "x" }), {
      action: "accept",
      content: { [otherId]: "x" },
    });
  });

  it("leaves unsupported reduced schemas to the shared fallback", () => {
    assert.isUndefined(
      extractOmpElicitationForm(
        request({
          install: single,
          install_other: singleOther,
          unsupported: { type: "array", items: { type: "string" } },
        }),
      ),
    );
  });

  it("trims paired titles and descriptions", () => {
    const form = extractOmpElicitationForm(
      request({
        install: { ...single, title: "  Install?  ", description: "  Tools  " },
        install_other: singleOther,
      }),
    );
    assert.isDefined(form);
    assert.strictEqual(form.questions[0]?.question, "Install?");
    assert.strictEqual(form.questions[0]?.header, "Tools");
  });
});

describe("extractOmpElicitationForm answers", () => {
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
      answer: 'B\n\nAttached image "a.png": "/p"',
      content: { install_other: 'B\n\nAttached image "a.png": "/p"' },
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
      answer: ["A", "B", 'Attached image "a.png": "/p"'],
      content: { install: ["A", "B"], install_other: 'Attached image "a.png": "/p"' },
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
    {
      name: "multi below minItems without text",
      field: { ...multi, minItems: 2 },
      answer: ["A"],
      content: {},
    },
    {
      name: "single text takes precedence over pick",
      field: single,
      answer: ["B", " x "],
      content: { install_other: "x" },
    },
    { name: "single first pick", field: single, answer: ["B", "A"], content: { install: "B" } },
    {
      name: "multi deduplicates and joins text",
      field: multi,
      answer: [" x ", " x ", "y", false],
      content: { install_other: "x, y" },
    },
    { name: "optional empty choice", field: single, answer: "  ", content: {} },
  ])("routes $name", ({ field, answer, content }) => {
    const form = extractOmpElicitationForm(
      request({ install: field, install_other: field.type === "array" ? multiOther : singleOther }),
    );
    assert.isDefined(form);
    assert.deepStrictEqual(form.respond({ install: answer }), { action: "accept", content });
  });

  it("routes the askDialog shape the same way", () => {
    const form = extractOmpElicitationForm(request({ q0: multi, q0__other: legacyOther }));
    assert.isDefined(form);
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
      request(
        { install: field, install_other: field.type === "array" ? multiOther : singleOther },
        ["install"],
      ),
    );
    assert.isDefined(form);
    assert.deepStrictEqual(form.respond({ install: answer }), { action: "accept", content });
  });

  it.each([{ install: "  " }, {}, { install: ["  "] }])(
    "cancels a required choice with no pick and no text: %j",
    (answers) => {
      const form = extractOmpElicitationForm(
        request({ install: single, install_other: singleOther }, ["install"]),
      );
      assert.isDefined(form);
      assert.deepStrictEqual(form.respond(answers), { action: "cancel" });
    },
  );

  it.each([
    { name: "above maxItems", field: { ...multi, maxItems: 1 }, answer: ["A", "B"] },
    { name: "below minItems", field: { ...multi, minItems: 2 }, answer: ["A"] },
  ])("cancels a required multi $name without text", ({ field, answer }) => {
    const form = extractOmpElicitationForm(
      request({ install: field, install_other: multiOther }, ["install"]),
    );
    assert.isDefined(form);
    assert.deepStrictEqual(form.respond({ install: answer }), { action: "cancel" });
  });

  it("cancels when an unpaired required field has no valid answer", () => {
    const form = extractOmpElicitationForm(
      request(
        {
          install: single,
          install_other: singleOther,
          count: { type: "integer" },
        },
        ["count"],
      ),
    );
    assert.isDefined(form);
    assert.deepStrictEqual(form.respond({ install: "x", count: "not a number" }), {
      action: "cancel",
    });
  });
});
