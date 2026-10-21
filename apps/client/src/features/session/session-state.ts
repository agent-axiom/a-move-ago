import type { MeResponseSchema } from "@a-move-ago/api-contract";
import type { z } from "zod";

export type Me = z.infer<typeof MeResponseSchema>;

export type SessionState =
  | { tag: "booting" }
  | { tag: "ready"; me: Me }
  | { tag: "authenticating"; me: Me }
  | { tag: "handoff-retry"; me: Me; handoffCode: string; message: string }
  | { tag: "auth-error"; me: Me; message: string; requestId?: string; errorCode?: string }
  | { tag: "fatal"; message: string; requestId?: string };
