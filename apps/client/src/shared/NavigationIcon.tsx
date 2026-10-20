export function NavigationIcon({ name }: { name: "today" | "archive" | "progress" }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
      {name === "today" ? (
        <>
          <rect x="4" y="4" width="16" height="16" rx="3" />
          <path d="M4 12h16M12 4v16" />
          <path d="M4 12h8v8H7a3 3 0 0 1-3-3Z" fill="currentColor" stroke="none" />
        </>
      ) : name === "archive" ? (
        <>
          <rect x="4" y="7" width="16" height="13" rx="2" />
          <path d="M7 4h10M9 11h6" strokeLinecap="round" />
        </>
      ) : (
        <>
          <path d="M5 19V12M12 19V5M19 19V9" strokeLinecap="round" strokeWidth="2.2" />
          <path d="M3 22h18" strokeLinecap="round" />
        </>
      )}
    </svg>
  );
}
