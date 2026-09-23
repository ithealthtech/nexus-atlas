// Metadata-only integration. These fixtures are not live collection results.
// No recovery-password, ciphertext, enrollment token, or private key is accepted.
const samples = Object.freeze([
  { id: 'bl-hdg-dc', assetId: 'harbor-server', hostname: 'HDG-DC-01', volume: 'C:', protection: 'On', encryption: 'XTS-AES 256', encryptionPercentage: 100, collection: 'Not enrolled', recovery: 'Not collected' },
  { id: 'bl-nla-nas', assetId: 'northline-nas', hostname: 'NLA-NAS-01', volume: 'D:', protection: 'Unknown', encryption: 'Unverified', encryptionPercentage: null, collection: 'Not enrolled', recovery: 'Not collected' }
]);
export function bitlockerInventory(store, actor, clientId = '') {
  // Use Atlas's established scope; never accept identity/tenant headers from the imported app.
  const assets = new Map(store.listRecords(actor, clientId).filter(r => r.kind === 'asset').map(r => [r.id,r]));
  return samples.filter(row => assets.has(row.assetId)).map(row => ({ ...row, clientId: assets.get(row.assetId).client_id, clientName: assets.get(row.assetId).client_name, sample: true }));
}
