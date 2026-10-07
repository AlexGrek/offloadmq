/** Returns null if `text` parses as a non-empty JSON object, else an error message. */
export function validateJsonObject(text: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return e instanceof Error ? e.message : "Invalid JSON";
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return "Must be a JSON object, e.g. {\"1\": {\"class_type\": \"...\", \"inputs\": {...}}, ...}";
  }
  if (Object.keys(parsed).length === 0) {
    return "JSON object is empty";
  }
  return null;
}
