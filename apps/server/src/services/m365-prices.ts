/**
 * Microsoft's published list prices for common subscriptions, in US cents per user per month with an annual
 * commitment. GDAP gives seat counts but no prices, so these estimate what an unused seat costs. A subscription
 * tracked in Atlas with its own unit cost overrides them. Anything not listed is "not priced", never guessed.
 */
const LIST_PRICE_CENTS: Record<string, number> = {
  O365_BUSINESS_ESSENTIALS: 600, // Microsoft 365 Business Basic
  O365_BUSINESS_PREMIUM: 1250, // Microsoft 365 Business Standard
  SPB: 2200, // Microsoft 365 Business Premium
  O365_BUSINESS: 825, // Microsoft 365 Apps for business
  OFFICESUBSCRIPTION: 1200, // Microsoft 365 Apps for enterprise
  SPE_E3: 3600, // Microsoft 365 E3
  SPE_E5: 5700, // Microsoft 365 E5
  SPE_F1: 800, // Microsoft 365 F3
  STANDARDPACK: 1000, // Office 365 E1
  ENTERPRISEPACK: 2300, // Office 365 E3
  ENTERPRISEPREMIUM: 3800, // Office 365 E5
  EXCHANGESTANDARD: 400, // Exchange Online (Plan 1)
  EXCHANGEENTERPRISE: 800, // Exchange Online (Plan 2)
  EXCHANGEARCHIVE_ADDON: 300, // Exchange Online Archiving
  AAD_PREMIUM: 600, // Microsoft Entra ID P1
  AAD_PREMIUM_P2: 900, // Microsoft Entra ID P2
  VISIOCLIENT: 1500, // Visio Plan 2
  PROJECTPROFESSIONAL: 3000, // Project Plan 3
  MDE_SMB: 300, // Microsoft Defender for Business
};
/** Free, trial and viral subscriptions: seats that cost nothing. */
const FREE = [/FREE/, /TRIAL/, /EXPLORATORY/, /^POWER_BI_STANDARD$/, /^FLOW_FREE$/, /^STREAM$/, /^WINDOWS_STORE$/];

/** A subscription's monthly list price per seat in US cents: 0 when free, null when Atlas doesn't know it. */
export function microsoftListPrice(part: string): number | null {
  if (FREE.some((p) => p.test(part))) return 0;
  return LIST_PRICE_CENTS[part] ?? null;
}
