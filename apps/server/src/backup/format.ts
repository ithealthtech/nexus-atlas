import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { Transform, type Readable, type TransformCallback } from 'node:stream';
import type { KeyProvider } from '../crypto/keys.js';

/*
 * Atlas backup file (.atlasbak):
 *
 *   "ATLASBAK\n" + one JSON header line + a sequence of encrypted chunks.
 *
 * The header names the master key (by fingerprint) and carries a random salt and nonce prefix. The chunk key is
 * derived from that master key with HKDF, so a backup can only be read where the master key is available.
 * Each chunk is AES-256-GCM over at most 64 KiB, framed as [u32 length | final flag][ciphertext][16-byte tag].
 * The nonce is the prefix plus the chunk number, and the header, chunk number, and final flag are authenticated,
 * so reordered, dropped, or truncated chunks fail, as does any change to the header.
 */

const MAGIC = Buffer.from('ATLASBAK\n');
const CHUNK = 64 * 1024;
const FINAL = 0x8000_0000;
const TAG = 16;

export interface BackupHeader {
  v: 1;
  keyId: string;
  salt: string;
  nonce: string;
  createdAt: string;
  appVersion: string;
}

export class BackupFormatError extends Error {}

const deriveKey = (master: Buffer, salt: Buffer) =>
  Buffer.from(hkdfSync('sha256', master, salt, 'atlas backup v1', 32));

const nonceFor = (prefix: Buffer, index: number) => {
  const nonce = Buffer.alloc(12);
  prefix.copy(nonce, 0, 0, 8);
  nonce.writeUInt32BE(index, 8);
  return nonce;
};

const aadFor = (header: Buffer, index: number, final: boolean) => {
  const tail = Buffer.alloc(5);
  tail.writeUInt32BE(index, 0);
  tail[4] = final ? 1 : 0;
  return Buffer.concat([header, tail]);
};

/** Encrypts a byte stream into the backup format. */
export function encryptStream(keys: KeyProvider, appVersion: string): Transform {
  const salt = randomBytes(16);
  const prefix = randomBytes(8);
  const key = deriveKey(keys.key(keys.keyId), salt);
  const header: BackupHeader = {
    v: 1,
    keyId: keys.keyId,
    salt: salt.toString('base64url'),
    nonce: prefix.toString('base64url'),
    createdAt: new Date().toISOString(),
    appVersion,
  };
  const headerBytes = Buffer.concat([MAGIC, Buffer.from(`${JSON.stringify(header)}\n`)]);
  let index = 0;
  let pending: Buffer[] = [];
  let pendingSize = 0;
  const seal = (plain: Buffer, final: boolean) => {
    if (index >= 0xffff_ffff) throw new BackupFormatError('Backup is too large.');
    const cipher = createCipheriv('aes-256-gcm', key, nonceFor(prefix, index));
    cipher.setAAD(aadFor(headerBytes, index, final));
    const body = Buffer.concat([cipher.update(plain), cipher.final()]);
    const frame = Buffer.alloc(4);
    frame.writeUInt32BE(body.length + (final ? FINAL : 0), 0);
    index++;
    return Buffer.concat([frame, body, cipher.getAuthTag()]);
  };
  let started = false;
  return new Transform({
    transform(chunk: Buffer, _encoding, done: TransformCallback) {
      if (!started) {
        this.push(headerBytes);
        started = true;
      }
      pending.push(chunk);
      pendingSize += chunk.length;
      if (pendingSize >= CHUNK) {
        let all = Buffer.concat(pending);
        while (all.length >= CHUNK) {
          this.push(seal(all.subarray(0, CHUNK), false));
          all = all.subarray(CHUNK);
        }
        pending = [all];
        pendingSize = all.length;
      }
      done();
    },
    flush(done: TransformCallback) {
      if (!started) this.push(headerBytes);
      // The last chunk is always marked final, even when empty, so a cut-off file is detected.
      this.push(seal(Buffer.concat(pending), true));
      done();
    },
  });
}

/** Reads just the header of a backup file, without decrypting it. */
export async function readHeader(source: Readable): Promise<BackupHeader> {
  let buffer = Buffer.alloc(0);
  for await (const chunk of source) {
    buffer = Buffer.concat([buffer, chunk as Buffer]);
    const end = buffer.indexOf(0x0a, MAGIC.length);
    if (end >= 0) {
      source.destroy();
      return parseHeader(buffer, end).header;
    }
    if (buffer.length > 4096) break;
  }
  throw new BackupFormatError('This is not an Atlas backup file.');
}

function parseHeader(buffer: Buffer, end: number) {
  if (!buffer.subarray(0, MAGIC.length).equals(MAGIC)) throw new BackupFormatError('This is not an Atlas backup file.');
  let header: BackupHeader;
  try {
    header = JSON.parse(buffer.subarray(MAGIC.length, end).toString('utf8')) as BackupHeader;
  } catch {
    throw new BackupFormatError('The backup header is damaged.');
  }
  if (header.v !== 1) throw new BackupFormatError(`Backup format version ${String(header.v)} isn't supported.`);
  return { header, headerBytes: buffer.subarray(0, end + 1), rest: buffer.subarray(end + 1) };
}

/** Decrypts a backup stream, failing on any change, reordering, or truncation. */
export function decryptStream(keys: KeyProvider): Transform & { header: Promise<BackupHeader> } {
  let buffer: Buffer = Buffer.alloc(0);
  let headerBytes: Buffer | null = null;
  let key: Buffer;
  let prefix: Buffer;
  let index = 0;
  let finished = false;
  let resolveHeader!: (h: BackupHeader) => void;
  let rejectHeader!: (e: Error) => void;
  const header = new Promise<BackupHeader>((resolve, reject) => {
    resolveHeader = resolve;
    rejectHeader = reject;
  });
  header.catch(() => undefined);

  const stream = new Transform({
    transform(chunk: Buffer, _encoding, done: TransformCallback) {
      try {
        buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
        if (!headerBytes) {
          const end = buffer.indexOf(0x0a, MAGIC.length);
          if (end < 0) {
            if (buffer.length > 4096) throw new BackupFormatError('This is not an Atlas backup file.');
            return done();
          }
          const parsed = parseHeader(buffer, end);
          headerBytes = Buffer.from(parsed.headerBytes);
          let master: Buffer;
          try {
            master = keys.key(parsed.header.keyId);
          } catch {
            throw new BackupFormatError(
              `This backup was made with master key ${parsed.header.keyId}, which isn't loaded. Add that key to the key file and try again.`,
            );
          }
          key = deriveKey(master, Buffer.from(parsed.header.salt, 'base64url'));
          prefix = Buffer.from(parsed.header.nonce, 'base64url');
          buffer = parsed.rest;
          resolveHeader(parsed.header);
        }
        while (buffer.length >= 4) {
          if (finished) throw new BackupFormatError('The backup has data after its end.');
          const word = buffer.readUInt32BE(0);
          const final = word >= FINAL;
          const length = final ? word - FINAL : word;
          if (length > CHUNK + 1024) throw new BackupFormatError('The backup is damaged.');
          if (buffer.length < 4 + length + TAG) break;
          const decipher = createDecipheriv('aes-256-gcm', key, nonceFor(prefix, index));
          decipher.setAAD(aadFor(headerBytes, index, final));
          decipher.setAuthTag(buffer.subarray(4 + length, 4 + length + TAG));
          let plain: Buffer;
          try {
            plain = Buffer.concat([decipher.update(buffer.subarray(4, 4 + length)), decipher.final()]);
          } catch {
            throw new BackupFormatError('The backup is damaged or was changed after it was made.');
          }
          buffer = buffer.subarray(4 + length + TAG);
          index++;
          finished = final;
          this.push(plain);
        }
        done();
      } catch (error) {
        rejectHeader(error as Error);
        done(error as Error);
      }
    },
    flush(done: TransformCallback) {
      if (!headerBytes) {
        const error = new BackupFormatError('This is not an Atlas backup file.');
        rejectHeader(error);
        return done(error);
      }
      if (!finished || buffer.length) return done(new BackupFormatError('The backup file is incomplete.'));
      done();
    },
  });
  return Object.assign(stream, { header });
}

// ---------- the container inside the encryption (after gunzip) ----------
// Frames: 'M' manifest JSON, 'T' table name + JSON rows, 'F' file key + bytes, 'E' end summary JSON.

export type Frame =
  | { kind: 'M'; json: unknown }
  | { kind: 'T'; name: string; rows: unknown[] }
  | { kind: 'F'; key: string; size: number }
  | { kind: 'E'; json: unknown };

const u32 = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n, 0);
  return b;
};
const name16 = (name: string) => {
  const bytes = Buffer.from(name, 'utf8');
  if (bytes.length > 0xffff) throw new Error('Name too long.');
  const len = Buffer.alloc(2);
  len.writeUInt16BE(bytes.length, 0);
  return Buffer.concat([len, bytes]);
};

export const frames = {
  json(kind: 'M' | 'E', value: unknown) {
    const body = Buffer.from(JSON.stringify(value), 'utf8');
    return Buffer.concat([Buffer.from(kind), u32(body.length), body]);
  },
  table(name: string, rowsJson: string[]) {
    const body = Buffer.from(`[${rowsJson.join(',')}]`, 'utf8');
    return Buffer.concat([Buffer.from('T'), name16(name), u32(body.length), body]);
  },
  fileStart(key: string, size: number) {
    const sizeBytes = Buffer.alloc(8);
    sizeBytes.writeBigUInt64BE(BigInt(size), 0);
    return Buffer.concat([Buffer.from('F'), name16(key), sizeBytes]);
  },
};

/** Pulls exact byte counts from a stream, for reading frames. */
export class ByteReader {
  private buffer: Buffer = Buffer.alloc(0);
  private readonly iterator: AsyncIterator<Buffer>;
  private done = false;

  constructor(source: Readable) {
    this.iterator = source[Symbol.asyncIterator]() as AsyncIterator<Buffer>;
  }

  protected async fill(n: number) {
    while (this.buffer.length < n && !this.done) {
      const next = await this.iterator.next();
      if (next.done) this.done = true;
      else this.buffer = this.buffer.length ? Buffer.concat([this.buffer, next.value]) : next.value;
    }
  }

  /** True when the stream has nothing more. */
  async atEnd(): Promise<boolean> {
    await this.fill(1);
    return this.buffer.length === 0;
  }

  async exact(n: number): Promise<Buffer> {
    await this.fill(n);
    if (this.buffer.length < n) throw new BackupFormatError('The backup file is incomplete.');
    const out = this.buffer.subarray(0, n);
    this.buffer = this.buffer.subarray(n);
    return out;
  }

  /** Yields the next `size` bytes in pieces, for streaming a file to disk. */
  async *pieces(size: number): AsyncGenerator<Buffer> {
    let left = size;
    while (left > 0) {
      await this.fill(1);
      if (!this.buffer.length) throw new BackupFormatError('The backup file is incomplete.');
      const take = Math.min(left, this.buffer.length);
      yield this.buffer.subarray(0, take);
      this.buffer = this.buffer.subarray(take);
      left -= take;
    }
  }

  async frame(): Promise<Frame> {
    const kind = (await this.exact(1)).toString('latin1');
    const readName = async () => (await this.exact((await this.exact(2)).readUInt16BE(0))).toString('utf8');
    switch (kind) {
      case 'M':
      case 'E':
        return { kind, json: JSON.parse((await this.exact((await this.exact(4)).readUInt32BE(0))).toString('utf8')) };
      case 'T': {
        const name = await readName();
        const body = await this.exact((await this.exact(4)).readUInt32BE(0));
        return { kind, name, rows: JSON.parse(body.toString('utf8')) as unknown[] };
      }
      case 'F': {
        const key = await readName();
        const size = Number((await this.exact(8)).readBigUInt64BE(0));
        return { kind, key, size };
      }
      default:
        throw new BackupFormatError('The backup contents are damaged.');
    }
  }
}
