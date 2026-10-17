export const tutorialPreferenceKey = "a-move-ago.tutorial.v1";

type TutorialStatus = "dismissed" | "completed";

function readStatus(): TutorialStatus | null {
  try {
    if (typeof window === "undefined") return null;
    const status = window.localStorage.getItem(tutorialPreferenceKey);
    return status === "dismissed" || status === "completed" ? status : null;
  } catch {
    return null;
  }
}

function rememberStatus(status: TutorialStatus): void {
  try {
    if (typeof window === "undefined") return;
    // Replaying or closing a finished lesson must not erase its completion.
    if (status === "dismissed" && readStatus() === "completed") return;
    window.localStorage.setItem(tutorialPreferenceKey, status);
  } catch {
    // The lesson stays usable when storage is blocked or full.
  }
}

export function shouldOfferTutorial(): boolean {
  return readStatus() === null;
}

export function dismissTutorialInvitation(): void {
  rememberStatus("dismissed");
}

export function completeTutorial(): void {
  rememberStatus("completed");
}
