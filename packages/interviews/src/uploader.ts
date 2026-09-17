/**
 * The uploader lives in `@rescript/storage/uploader` since the Studio and the
 * survey runtime adopted it too — one network client for every product. This
 * module keeps the interviews app's import path and its two endpoint sets.
 */
export * from "@rescript/storage/uploader";
import type { UploaderEndpoints } from "@rescript/storage/uploader";

export const CANDIDATE_ENDPOINTS: UploaderEndpoints = {
  begin: "/api/candidate/upload/begin",
  parts: "/api/candidate/upload/parts",
  complete: "/api/candidate/upload/complete",
};

export const SESSION_ENDPOINTS: UploaderEndpoints = {
  begin: "/api/sessions/upload/begin",
  parts: "/api/sessions/upload/parts",
  complete: "/api/sessions/upload/complete",
};
