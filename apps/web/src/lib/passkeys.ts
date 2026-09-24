import {
  browserSupportsWebAuthn,
  startAuthentication,
  startRegistration,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
} from '@simplewebauthn/browser';
import type { SessionView } from '@atlas/shared';
import { api } from './api';
import { DEMO } from './demo';

export const passkeysSupported = () => DEMO || browserSupportsWebAuthn();
// The demo skips the browser's passkey prompt; the sample backend accepts any response.
const ceremony = <T>(run: () => Promise<T>) => (DEMO ? Promise.resolve({} as T) : run());

/** The browser's message when someone closes the passkey prompt isn't useful; say what happened instead. */
function friendly(error: unknown): never {
  if (error instanceof Error && (error.name === 'NotAllowedError' || error.name === 'AbortError'))
    throw new Error('The passkey request was cancelled or timed out. Try again.');
  if (error instanceof Error && error.name === 'InvalidStateError')
    throw new Error('This passkey is already registered with your account.');
  throw error;
}

export async function addPasskey(name: string): Promise<SessionView & { recoveryCodes: string[] }> {
  const options = await api<PublicKeyCredentialCreationOptionsJSON>('/account/passkeys/options', {
    method: 'POST',
    body: {},
  });
  const response = await ceremony(() => startRegistration({ optionsJSON: options })).catch(friendly);
  return api('/account/passkeys', { method: 'POST', body: { name, response } });
}

/** Second step after the password. */
export async function verifyWithPasskey(remember: boolean): Promise<SessionView> {
  const options = await api<PublicKeyCredentialRequestOptionsJSON>('/session/passkey/options', {
    method: 'POST',
    body: {},
  });
  const response = await ceremony(() => startAuthentication({ optionsJSON: options })).catch(friendly);
  return api('/session/passkey', { method: 'POST', body: { response, remember } });
}

/** Passwordless sign-in. */
export async function signInWithPasskey(): Promise<SessionView> {
  const { challengeId, options } = await api<{
    challengeId: string;
    options: PublicKeyCredentialRequestOptionsJSON;
  }>('/passkey/options', { method: 'POST', body: {} });
  const response = await ceremony(() => startAuthentication({ optionsJSON: options })).catch(friendly);
  return api('/passkey/sign-in', { method: 'POST', body: { challengeId, response } });
}
