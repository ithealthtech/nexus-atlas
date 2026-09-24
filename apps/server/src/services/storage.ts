import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export interface StoredFile {
  key: string;
  size: number;
  sha256: string;
  head: Buffer;
}

/** File storage for attachments. Local disk now; an S3-compatible implementation can replace it. */
export interface FileStorage {
  put(orgId: string, stream: Readable, maxBytes: number): Promise<StoredFile>;
  get(key: string): Promise<Readable>;
  size(key: string): Promise<number>;
  remove(key: string): Promise<void>;
  /** Writes a file back under its original key (restoring a backup). */
  restore(key: string, stream: Readable): Promise<void>;
}

export class TooLargeError extends Error {}

export class LocalStorage implements FileStorage {
  private readonly root: string;
  constructor(root: string) {
    this.root = resolve(root);
  }
  private path(key: string) {
    const full = resolve(this.root, key);
    // Keys are generated here, but never let one escape the storage folder.
    if (!full.startsWith(this.root + sep)) throw new Error('Invalid storage key.');
    return full;
  }
  async put(orgId: string, stream: Readable, maxBytes: number): Promise<StoredFile> {
    const key = join(orgId, randomUUID());
    const final = this.path(key);
    const temp = `${final}.part`;
    await mkdir(dirname(final), { recursive: true });
    const hash = createHash('sha256');
    let size = 0;
    let head = Buffer.alloc(0);
    const meter = new Transform({
      transform(chunk: Buffer, _enc, done) {
        size += chunk.length;
        if (size > maxBytes) return done(new TooLargeError());
        if (head.length < 16) head = Buffer.concat([head, chunk.subarray(0, 16 - head.length)]);
        hash.update(chunk);
        done(null, chunk);
      },
    });
    try {
      await pipeline(stream, meter, createWriteStream(temp, { mode: 0o600 }));
      await rename(temp, final);
    } catch (error) {
      await rm(temp, { force: true });
      throw error;
    }
    return { key, size, sha256: hash.digest('hex'), head };
  }
  async get(key: string) {
    await stat(this.path(key));
    return createReadStream(this.path(key));
  }
  async size(key: string) {
    return (await stat(this.path(key))).size;
  }
  async remove(key: string) {
    await rm(this.path(key), { force: true });
  }
  async restore(key: string, stream: Readable) {
    const final = this.path(key);
    const temp = `${final}.part`;
    await mkdir(dirname(final), { recursive: true });
    try {
      await pipeline(stream, createWriteStream(temp, { mode: 0o600 }));
      await rename(temp, final);
    } catch (error) {
      await rm(temp, { force: true });
      throw error;
    }
  }
}

/** Image types shown inline, confirmed by their first bytes rather than trusting the browser's claim. */
export function sniffImage(head: Buffer): string | null {
  if (head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image/jpeg';
  if (head.subarray(0, 6).toString('ascii') === 'GIF87a' || head.subarray(0, 6).toString('ascii') === 'GIF89a')
    return 'image/gif';
  if (head.subarray(0, 4).toString('ascii') === 'RIFF' && head.subarray(8, 12).toString('ascii') === 'WEBP')
    return 'image/webp';
  return null;
}
