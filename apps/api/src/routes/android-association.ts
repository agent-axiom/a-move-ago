import { Hono } from "hono";
import type { AppEnv, Env } from "../env";
import { ApiError } from "../http/api-error";

const packageNamePattern = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/;
const fingerprintPattern = /^(?:[0-9A-F]{2}:){31}[0-9A-F]{2}$/;
const callbackHtml =
  '<!doctype html><html lang="en"><head><meta charset="utf-8"></head><body>Return to A MOVE AGO on your Android device.</body></html>';
const callbackCsp =
  "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'";

function configurationError(): ApiError {
  return new ApiError(503, "CONFIGURATION_ERROR", "Android association is not configured.");
}

function associationConfiguration(env: Env): {
  packageName: string;
  fingerprints: string[];
} {
  if (
    typeof env.ANDROID_PACKAGE_NAME !== "string" ||
    !packageNamePattern.test(env.ANDROID_PACKAGE_NAME) ||
    typeof env.ANDROID_SHA256_CERT_FINGERPRINTS !== "string"
  ) {
    throw configurationError();
  }

  const fingerprints = env.ANDROID_SHA256_CERT_FINGERPRINTS.split(",").map((value) => value.trim());
  if (fingerprints.some((fingerprint) => !fingerprintPattern.test(fingerprint))) {
    throw configurationError();
  }

  return {
    packageName: env.ANDROID_PACKAGE_NAME,
    fingerprints: [...new Set(fingerprints)].sort(),
  };
}

export const androidAssociationRoutes = new Hono<AppEnv>();

androidAssociationRoutes.get("/.well-known/assetlinks.json", (context) => {
  const configuration = associationConfiguration(context.env);
  context.header("cache-control", "public, max-age=300");
  return context.json([
    {
      relation: ["delegate_permission/common.handle_all_urls"],
      target: {
        namespace: "android_app",
        package_name: configuration.packageName,
        sha256_cert_fingerprints: configuration.fingerprints,
      },
    },
  ]);
});

androidAssociationRoutes.get("/auth/android", (context) => {
  context.header("content-security-policy", callbackCsp);
  context.header("referrer-policy", "no-referrer");
  context.header("cache-control", "no-store");
  context.header("x-content-type-options", "nosniff");
  return context.html(callbackHtml);
});
