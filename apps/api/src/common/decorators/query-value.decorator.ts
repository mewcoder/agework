import { Transform } from "class-transformer";

export function OptionalTrimmedString() {
  return Transform(({ value }) => {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== "string") return value;
    const trimmed = value.trim();
    return trimmed ? trimmed : undefined;
  });
}

export function OptionalStringArrayQuery() {
  return Transform(({ value }) => {
    if (value === undefined || value === null || value === "") {
      return undefined;
    }
    const values = Array.isArray(value) ? value : [value];
    if (values.some((item) => typeof item !== "string")) {
      return value;
    }
    const items = values.flatMap((item) =>
      item.split(",")
    );
    const normalized = items
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter(Boolean);
    return normalized.length > 0 ? normalized : undefined;
  });
}
