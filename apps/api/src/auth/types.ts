export type VerifiedTelegramIdentity = {
  telegramUserId: string;
  displayName: string;
  username: string | null;
  avatarUrl: string | null;
  oidc?: {
    issuer: "https://oauth.telegram.org";
    subject: string;
    audience: string;
  };
};
