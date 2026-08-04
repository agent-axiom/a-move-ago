import type { Env } from "../env";

export type OidcChannel = "web" | "android";
export type AuthReturnEnv = Pick<
  Env,
  | "ENVIRONMENT"
  | "ALLOWED_ORIGINS"
  | "API_ORIGIN"
  | "WEB_AUTH_RETURN_URL"
  | "ANDROID_AUTH_RETURN_URL"
>;

function productionAndroidTarget(env: AuthReturnEnv): string {
  let apiOrigin: URL;
  try {
    apiOrigin = new URL(env.API_ORIGIN);
  } catch {
    throw new Error("API_ORIGIN must be an HTTPS origin");
  }
  if (
    apiOrigin.protocol !== "https:" ||
    apiOrigin.username !== "" ||
    apiOrigin.password !== "" ||
    apiOrigin.pathname !== "/" ||
    apiOrigin.search !== "" ||
    apiOrigin.hash !== ""
  ) {
    throw new Error("API_ORIGIN must be an HTTPS origin");
  }
  return `${apiOrigin.origin}/auth/android`;
}

function webReturnTarget(env: AuthReturnEnv): URL {
  let target: URL;
  try {
    target = new URL(env.WEB_AUTH_RETURN_URL);
  } catch {
    throw new Error("Invalid Web auth return target");
  }
  const allowedOrigins = new Set(
    env.ALLOWED_ORIGINS.split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),
  );
  if (
    target.protocol !== "https:" ||
    target.username !== "" ||
    target.password !== "" ||
    target.search !== "" ||
    target.hash !== "" ||
    target.toString() !== env.WEB_AUTH_RETURN_URL ||
    !allowedOrigins.has(target.origin)
  ) {
    throw new Error("Invalid Web auth return target");
  }
  return target;
}

export function resolveAuthReturnTarget(env: AuthReturnEnv, channel: OidcChannel): URL {
  if (channel === "web") return webReturnTarget(env);

  const isDebug = env.ENVIRONMENT === "development" || env.ENVIRONMENT === "test";
  if (isDebug) {
    if (env.ANDROID_AUTH_RETURN_URL !== "amoveago-debug://auth") {
      throw new Error("Invalid debug Android auth return target");
    }
  } else if (env.ANDROID_AUTH_RETURN_URL !== productionAndroidTarget(env)) {
    throw new Error("Invalid production Android auth return target");
  }

  try {
    return new URL(env.ANDROID_AUTH_RETURN_URL);
  } catch {
    throw new Error("Invalid Android auth return target");
  }
}
