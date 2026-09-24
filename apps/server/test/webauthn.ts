import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';
import { isoCBOR } from '@simplewebauthn/server/helpers';

const b64 = (bytes: Uint8Array | Buffer) => Buffer.from(bytes).toString('base64url');
const sha256 = (data: Buffer | string) => createHash('sha256').update(data).digest();

/**
 * A minimal software passkey (ES256, "none" attestation), enough to exercise the server's WebAuthn checks
 * the way a browser and security key would.
 */
export class SoftAuthenticator {
  readonly id = randomBytes(16);
  private readonly privateKey: KeyObject;
  private readonly publicJwk: { x: string; y: string };
  private counter = 0;

  constructor(
    readonly origin = 'http://localhost',
    readonly rpId = 'localhost',
  ) {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    this.privateKey = privateKey;
    this.publicJwk = publicKey.export({ format: 'jwk' }) as { x: string; y: string };
  }

  private authData(flags: number, attested?: Buffer) {
    const count = Buffer.alloc(4);
    count.writeUInt32BE(this.counter);
    return Buffer.concat([sha256(this.rpId), Buffer.from([flags]), count, ...(attested ? [attested] : [])]);
  }

  private clientData(type: string, challenge: string, origin = this.origin) {
    return Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
  }

  /** Answers navigator.credentials.create() options. */
  register(options: { challenge: string }) {
    const cose = new Map<number, number | Uint8Array>([
      [1, 2],
      [3, -7],
      [-1, 1],
      [-2, new Uint8Array(Buffer.from(this.publicJwk.x, 'base64url'))],
      [-3, new Uint8Array(Buffer.from(this.publicJwk.y, 'base64url'))],
    ]);
    const idLength = Buffer.alloc(2);
    idLength.writeUInt16BE(this.id.length);
    const attested = Buffer.concat([Buffer.alloc(16), idLength, this.id, Buffer.from(isoCBOR.encode(cose))]);
    const authData = this.authData(0x01 | 0x04 | 0x40, attested);
    const attestationObject = isoCBOR.encode(
      new Map<string, string | Map<string, never> | Uint8Array>([
        ['fmt', 'none'],
        ['attStmt', new Map()],
        ['authData', new Uint8Array(authData)],
      ]),
    );
    return {
      id: b64(this.id),
      rawId: b64(this.id),
      type: 'public-key',
      response: {
        clientDataJSON: b64(this.clientData('webauthn.create', options.challenge)),
        attestationObject: b64(attestationObject),
        transports: ['internal'],
      },
      clientExtensionResults: {},
    };
  }

  /** Answers navigator.credentials.get() options. `verified` controls the user-verification flag. */
  assert(options: { challenge: string }, { verified = true, origin = this.origin } = {}) {
    this.counter++;
    const authData = this.authData(0x01 | (verified ? 0x04 : 0));
    const clientDataJSON = this.clientData('webauthn.get', options.challenge, origin);
    const signature = sign('sha256', Buffer.concat([authData, sha256(clientDataJSON)]), this.privateKey);
    return {
      id: b64(this.id),
      rawId: b64(this.id),
      type: 'public-key',
      response: {
        authenticatorData: b64(authData),
        clientDataJSON: b64(clientDataJSON),
        signature: b64(signature),
      },
      clientExtensionResults: {},
    };
  }
}
