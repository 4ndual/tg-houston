// Build-time constants, injected via `bun build --define`.
// Runtime env vars (TELEGRAM_API_ID / TELEGRAM_API_HASH) always take precedence
// over the embedded values, so power users can swap credentials without rebuilding.

declare const __TG_API_ID__: string;
declare const __TG_API_HASH__: string;
declare const __TG_VERSION__: string;

export const EMBEDDED_API_ID: string =
  typeof __TG_API_ID__ !== "undefined" ? __TG_API_ID__ : "";
export const EMBEDDED_API_HASH: string =
  typeof __TG_API_HASH__ !== "undefined" ? __TG_API_HASH__ : "";
export const VERSION: string =
  typeof __TG_VERSION__ !== "undefined" ? __TG_VERSION__ : "dev";
