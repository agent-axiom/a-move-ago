export interface EntryQuery {
  caseDate: string | null;
  handoff: string | null;
  authError: "access_denied" | null;
}

function validDate(value: string | null): value is string {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

function oneValue(url: URL, name: string): string | null {
  const values = url.searchParams.getAll(name);
  return values.length === 1 ? (values[0] ?? null) : null;
}

export function parseEntryQuery(url: URL): EntryQuery {
  const caseDate = oneValue(url, "case");
  const handoff = oneValue(url, "handoff");
  const authError = oneValue(url, "authError");
  return {
    caseDate: validDate(caseDate) ? caseDate : null,
    handoff: handoff && /^[A-Za-z0-9_-]{43}$/.test(handoff) ? handoff : null,
    authError: authError === "access_denied" ? authError : null,
  };
}

export function stripAuthReturn(source: URL): string {
  const url = new URL(source);
  url.searchParams.delete("handoff");
  url.searchParams.delete("authError");
  return `${url.pathname}${url.search}${url.hash}`;
}
