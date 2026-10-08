// Email/password sign-in and dashboard user management (OpenMsg). Kept apart from api.ts so
// upstream changes there merge without touching this fork's additions.
import { API_BASE_URL, request } from './api';
import type { UserRole } from '../types/role';

export interface DashboardUser {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  isActive: boolean;
  /** The password is temporary: the user sets their own at the next sign-in. */
  mustChangePassword: boolean;
  lastLoginAt?: string;
  createdAt: string;
}

export interface SignInResult {
  passwordChangeRequired: false;
  apiKey: string;
  expiresAt: string;
  role: UserRole;
  engineType: string;
  scoped: boolean;
  user: DashboardUser;
}

/** The password is temporary: repeat the sign-in with the user's own new password. */
export interface PasswordChangeRequired {
  passwordChangeRequired: true;
}

/** Why a sign-in failed: the gateway's machine code, or 'NETWORK' when it was never reached. */
export type SignInErrorCode = 'INVALID_CREDENTIALS' | 'TOO_MANY_ATTEMPTS' | 'SAME_PASSWORD' | 'NETWORK';

export class SignInError extends Error {
  readonly code: SignInErrorCode;

  constructor(code: SignInErrorCode) {
    super(code);
    this.code = code;
  }
}

const USER_KEY = 'openmsg_user';

export async function signIn(
  email: string,
  password: string,
  newPassword?: string,
): Promise<SignInResult | PasswordChangeRequired> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(newPassword ? { email, password, newPassword } : { email, password }),
    });
  } catch {
    throw new SignInError('NETWORK');
  }
  if (response.ok) return (await response.json()) as SignInResult | PasswordChangeRequired;
  if (response.status === 400) {
    const body = (await response.json().catch(() => ({}))) as { code?: unknown };
    if (body.code === 'SAME_PASSWORD') throw new SignInError('SAME_PASSWORD');
  }
  if (response.status === 401) throw new SignInError('INVALID_CREDENTIALS');
  if (response.status === 429) throw new SignInError('TOO_MANY_ATTEMPTS');
  // A 5xx or a proxy error page says nothing about the credentials.
  throw new SignInError('NETWORK');
}

/** Delete the sign-in key on the gateway. Best effort: the tab forgets the key either way. */
export async function signOut(apiKey: string): Promise<void> {
  try {
    await fetch(`${API_BASE_URL}/auth/logout`, { method: 'POST', headers: { 'X-API-Key': apiKey } });
  } catch {
    // Offline: the key still expires on the server.
  }
}

export function storeSignedInUser(user: DashboardUser): void {
  sessionStorage.setItem(USER_KEY, JSON.stringify(user));
}

export function getSignedInUser(): DashboardUser | null {
  try {
    const raw = sessionStorage.getItem(USER_KEY);
    return raw ? (JSON.parse(raw) as DashboardUser) : null;
  } catch {
    return null;
  }
}

export function clearSignedInUser(): void {
  sessionStorage.removeItem(USER_KEY);
}

export interface UserInput {
  name?: string;
  email?: string;
  password?: string;
  role?: UserRole;
  isActive?: boolean;
}

/** Change the signed-in user's password; errors carry the gateway code (WRONG_PASSWORD, SAME_PASSWORD). */
export function changeOwnPassword(currentPassword: string, newPassword: string): Promise<void> {
  return request<void>('/auth/me/password', {
    method: 'POST',
    body: JSON.stringify({ currentPassword, newPassword }),
  });
}

export const usersApi = {
  list: () => request<DashboardUser[]>('/users'),
  create: (data: Required<Pick<UserInput, 'name' | 'email' | 'password' | 'role'>>) =>
    request<DashboardUser>('/users', { method: 'POST', body: JSON.stringify(data) }),
  update: (id: string, data: Omit<UserInput, 'email'>) =>
    request<DashboardUser>(`/users/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  delete: (id: string) => request<void>(`/users/${id}`, { method: 'DELETE' }),
};
