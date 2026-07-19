// Central place for backend/WebSocket URL resolution and authenticated API calls.
// Consolidates what used to be duplicated fetch() calls scattered across App.jsx.

const DEFAULT_API_URL = import.meta.env.DEV
  ? 'http://localhost:5000'
  : (typeof window !== 'undefined' ? window.location.origin : 'http://localhost:5000');

export const BACKEND_URL = (import.meta.env.VITE_API_URL || DEFAULT_API_URL).replace(/\/$/, '');
export const WS_URL = (import.meta.env.VITE_WS_URL || BACKEND_URL.replace(/^http/, 'ws')).replace(/\/$/, '');

export class AuthError extends Error {}

/**
 * Fetch wrapper that attaches the bearer token (when provided), parses JSON responses,
 * and throws a typed AuthError on 401 so callers can force a logout instead of silently
 * failing or showing a confusing generic error.
 */
export async function apiFetch(path, { token, method = 'GET', body, headers } = {}) {
  const res = await fetch(`${BACKEND_URL}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(headers || {})
    },
    body: body !== undefined ? JSON.stringify(body) : undefined
  });

  let data = null;
  try {
    data = await res.json();
  } catch {
    // Some endpoints may not return a body - that's fine.
  }

  if (res.status === 401) {
    throw new AuthError(data?.error || 'Session expired. Please log in again.');
  }

  if (!res.ok) {
    throw new Error(data?.error || `Request failed (${res.status})`);
  }

  return data;
}
