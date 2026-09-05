import type { AuthIdentity } from './crypto.ts';

export const AUTH_ERROR_CODES = [
  'INVALID_GRANT',
  'TOKEN_REUSED',
  'SESSION_REVOKED',
  'CLIENT_FORBIDDEN',
  'APPROVAL_REQUIRED',
  'POLICY_REQUIRED',
] as const;

export type AuthErrorCode = (typeof AUTH_ERROR_CODES)[number];

export type AuthenticationResult =
  | {
      ok: true;
      identity: AuthIdentity;
      sessionId: string;
      refreshToken: string;
    }
  | { ok: false; code: AuthErrorCode };

export type PasswordAuthenticationInput = {
  clientVersion?: string;
  tenantId: string;
  clientId: string;
  user: string;
  password: string;
};

export type RefreshAuthenticationInput = {
  clientVersion?: string;
  clientId: string;
  refreshToken: string;
  refreshRequestId: string;
};

export type RegistrationChallenge = { challengeId: string; code: string; expiresAt: Date };
export type RegistrationInput = {
  tenantId: string;
  account: string;
  realName: string;
  password: string;
  challengeId: string;
  verificationCode: string;
};
export type RegistrationResult =
  | { ok: true; registrationId: string }
  | { ok: false; code: 'INVALID_CHALLENGE' | 'ACCOUNT_EXISTS' };
export type LogoutInput = { clientId: string; refreshToken: string; clientRequestId: string };
export type PasswordChangeInput = LogoutInput & { currentPassword: string; newPassword: string };
export type MutationReceipt = { ok: true; receiptId: string } | { ok: false; code: AuthErrorCode };

export type AuthStore = {
  authenticatePassword(input: PasswordAuthenticationInput): Promise<AuthenticationResult>;
  rotateRefreshToken(input: RefreshAuthenticationInput): Promise<AuthenticationResult>;
  issueRegistrationChallenge(): Promise<RegistrationChallenge>;
  register(input: RegistrationInput): Promise<RegistrationResult>;
  logout(input: LogoutInput): Promise<MutationReceipt>;
  changePassword(input: PasswordChangeInput): Promise<MutationReceipt>;
};
