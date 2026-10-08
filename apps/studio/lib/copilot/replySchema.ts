/**
 * THE COPILOT REPLY, AS A SCHEMA THE PROVIDER CAN HOLD TO (Phase 1).
 *
 * Deliberately loose: the actions are a union the engine's gate reads
 * (`coerceCopilotReply` → `coerceSurveyActions`), and a strict schema that
 * named every action's fields would be a second copy of that gate that
 * drifts. What the schema fixes is the frame — an object with `kind`, a
 * `reply` string, an `actions` array of objects with an `op` — which is
 * exactly what a provider without json mode gets wrong (prose, or a bare
 * array). Providers that refuse a schema fall back to json mode or nothing.
 */
export const COPILOT_REPLY_SCHEMA = {
  name: "rescript_copilot_reply",
  schema: {
    type: "object",
    properties: {
      kind: { type: "string", enum: ["proposal", "answer", "review", "clarify"] },
      reply: { type: "string" },
      actions: { type: "array", items: { type: "object", properties: { op: { type: "string" } }, required: ["op"], additionalProperties: true } },
      questions: { type: "array", items: { type: "string" } },
      memory: { type: "string" },
    },
    required: ["kind", "reply"],
    additionalProperties: true,
  } as Record<string, unknown>,
};
