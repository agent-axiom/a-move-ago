export function nextUnsolvedIndex(
  puzzleIds: readonly string[],
  solved: ReadonlySet<string>,
): number | null {
  const index = puzzleIds.findIndex((id) => !solved.has(id));
  return index === -1 ? null : index;
}
