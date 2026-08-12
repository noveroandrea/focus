// ─────────────────────────────────────────────────────────────────────────────
//  The pairing page's only configuration
// ─────────────────────────────────────────────────────────────────────────────
//  The same two values as src/extension/server/config.ts, and public for the same
//  reason: the anon key is a signed JWT saying "anonymous role", and the only thing
//  this page ever calls with it is claim_pairing() — which can do nothing except
//  fill in a subscription on a row whose 128-bit nonce the caller already knew.
//
//  Nothing else belongs here. The service_role key in particular would hand every
//  participant's data to anyone who opened this file, and this file is served to
//  phones.
// ─────────────────────────────────────────────────────────────────────────────
window.FOCUS_CONFIG = {
  SUPABASE_URL: 'https://zjdcanlogiidqqgkfutp.supabase.co',
  SUPABASE_ANON_KEY: 'sb_publishable_HHxAUdAbNabMNZwri-imLw_x2X2cSpR',
};
