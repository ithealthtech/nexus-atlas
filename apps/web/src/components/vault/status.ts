import { type PasswordView } from '@atlas/shared';

// When a password is due for rotation or has expired, for badges in the list and on the detail page.
const today = () => new Date().toISOString().slice(0, 10);
export const rotationOverdue = (p: PasswordView) => !!p.rotationDue && p.rotationDue <= today();
export const expired = (p: PasswordView) => !!p.expiresOn && p.expiresOn <= today();
