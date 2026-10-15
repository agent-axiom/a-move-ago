/** Date/position aliases keep composition themes out of public identifiers. */
export function publicPuzzleId(caseId: string, position: number, version: number): string {
  return `p-${caseId}-${position}-v${version}`;
}

export function puzzleAliasSql(caseId: string, position: string, version: string): string {
  return `('p-' || ${caseId} || '-' || ${position} || '-v' || ${version})`;
}
