export function canResetSavedLogin(error) {
  return ["credentials_invalid", "credentials_version_unsupported"].includes(error?.code);
}

export function isLoginStorageError(error) {
  return canResetSavedLogin(error) || [
    "credentials_too_large", "registration_invalid", "storage_unavailable", "storage_unsafe", "storage_busy",
  ].includes(error?.code);
}

export function requiresReauthentication(error) {
  return [
    "sign_in_required", "reauth_required",
    "invalid_grant", "invalid_refresh_token", "token_expired", "refresh_token_expired",
    "refresh_token_invalidated", "refresh_token_reused", "invalid_id_token", "invalid_token_response", "account_mismatch",
  ].includes(error?.code);
}
