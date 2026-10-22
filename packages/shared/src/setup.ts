// ---------- setting up a new installation ----------
/** Whether each part of Administration → Set up Atlas is done, as the server finds it. */
export interface SetupStatus {
  /** A brand name, logo, colour or favicon under Theme. */
  branding: boolean;
  /** An email server saved, so invitations, password resets and reports can be sent. */
  email: boolean;
  client: boolean;
  /** An import from Hudu, IT Glue or a spreadsheet that finished. */
  import: boolean;
  /** ConnectWise RMM connected. */
  rmm: boolean;
  /** Microsoft 365 connected. */
  microsoft: boolean;
  /** Someone besides the first administrator. */
  team: boolean;
  /** A backup that finished. */
  backup: boolean;
}
