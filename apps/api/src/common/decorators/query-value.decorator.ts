import { Transform } from "class-transformer";

export function OptionalTrimmedString() {
  return Transform(({ value }: { value: unknown }) => {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== "string") return value;
    const trimmed = value.trim();
    return trimmed ? trimmed : undefined;
  });
}

export function OptionalStringArrayQuery() {
  return Transform(({ value }: { value: unknown }) => {
    if (value === undefined || value === null || value === "") {
      return undefined;
    }
    const values: unknown[] = Array.isArray(value) ? value : [value];
    const strings = values.filter(
      (item): item is string => typeof item === "string"
    );
    if (strings.length !== values.length) {
      return value;
    }
    const normalized = strings
      .flatMap((item) => item.split(","))
      .map((item) => item.trim())
      .filter(Boolean);
    return normalized.length > 0 ? normalized : undefined;
  });
}
