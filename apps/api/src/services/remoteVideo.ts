import { createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { lookup } from 'node:dns/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { LIMITS } from '@aiedit/shared';
import { logger } from '../config/logger';
import { badRequest } from '../utils/errors';

export interface RemoteVideo {
  filePath: string;
  filename: string;
  mimeType: string;
  bytes: number;
}

const FETCH_TIMEOUT_MS = 120_000;
const MAX_REDIRECTS = 3;

/**
 * Reject addresses inside the private ranges so a user-supplied URL cannot be
 * used to probe the internal network (SSRF).
 */
function isPrivateAddress(address: string): boolean {
  if (net.isIPv4(address)) {
    const parts = address.split('.').map(Number) as [number, number, number, number];
    const [a, b] = parts;
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    if (a >= 224) return true; // multicast and reserved
    return false;
  }

  if (net.isIPv6(address)) {
    const lower = address.toLowerCase();
    if (lower === '::1' || lower === '::') return true;
    if (lower.startsWith('fe80') || lower.startsWith('fc') || lower.startsWith('fd')) return true;
    // IPv4-mapped addresses inherit the IPv4 rules.
    const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateAddress(mapped[1]!);
    return false;
  }

  return true;
}

async function assertPublicHost(hostname: string): Promise<void> {
  let records: Array<{ address: string }>;
  try {
    records = await lookup(hostname, { all: true });
  } catch {
    throw badRequest(`Could not resolve ${hostname}.`);
  }
  if (records.length === 0) throw badRequest(`Could not resolve ${hostname}.`);
  if (records.some((record) => isPrivateAddress(record.address))) {
    throw badRequest('That URL resolves to a private network address and cannot be fetched.');
  }
}

/**
 * Download a reference video by URL.
 *
 * This handles direct media URLs. Platform watch pages (YouTube, TikTok, …)
 * serve HTML rather than a media stream and are rejected with a clear message
 * — extracting streams from those platforms is a licensing decision, not a
 * technical one, so it is deliberately not attempted here.
 */
export async function fetchRemoteVideo(rawUrl: string): Promise<RemoteVideo> {
  let url = new URL(rawUrl);
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw badRequest('Only http and https URLs are accepted.');
  }

  const dir = await mkdtemp(path.join(os.tmpdir(), 'aiedit-url-'));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    let response: Response | null = null;

    for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
      await assertPublicHost(url.hostname);

      response = await fetch(url, {
        redirect: 'manual',
        signal: controller.signal,
        headers: { accept: 'video/*,application/octet-stream;q=0.9,*/*;q=0.5' },
      });

      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        if (!location) throw badRequest('The URL redirected without a destination.');
        // Every hop is re-validated, so a redirect cannot escape into a
        // private address range.
        url = new URL(location, url);
        continue;
      }
      break;
    }

    if (!response || !response.ok) {
      throw badRequest(`The URL responded with ${response?.status ?? 'no response'}.`);
    }

    const contentType = (response.headers.get('content-type') ?? '').split(';')[0]!.trim();
    if (contentType.startsWith('text/html')) {
      throw badRequest(
        'That link points to a web page rather than a video file. Download the video and upload the file instead.',
      );
    }

    const declaredLength = Number(response.headers.get('content-length') ?? 0);
    if (declaredLength > LIMITS.maxVideoBytes) {
      throw badRequest('That video is larger than this server accepts.');
    }
    if (!response.body) throw badRequest('The URL returned an empty response.');

    const filename = decodeURIComponent(path.basename(url.pathname)) || 'reference-video.mp4';
    const filePath = path.join(dir, filename.replace(/[^\w.-]/g, '-').slice(0, 120) || 'reference.mp4');

    let bytes = 0;
    const counter = new TransformStreamCounter(LIMITS.maxVideoBytes, (n) => {
      bytes = n;
    });

    await pipeline(
      Readable.fromWeb(response.body as never),
      counter.transform(),
      createWriteStream(filePath),
    );

    logger.info({ url: url.toString(), bytes }, 'Fetched a competitor reference by URL');

    return {
      filePath,
      filename,
      mimeType: contentType || 'video/mp4',
      bytes,
    };
  } catch (err) {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    if (err instanceof Error && err.name === 'AbortError') {
      throw badRequest('Fetching that URL took too long.');
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** Counts bytes as they stream through and aborts once the cap is crossed. */
class TransformStreamCounter {
  private total = 0;

  constructor(
    private readonly limit: number,
    private readonly onCount: (bytes: number) => void,
  ) {}

  transform(): NodeJS.ReadWriteStream {
    const { Transform } = require('node:stream') as typeof import('node:stream');
    const limit = this.limit;
    const onCount = this.onCount;
    let total = 0;

    return new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        total += chunk.length;
        if (total > limit) {
          callback(new Error('The remote video exceeded the maximum accepted size.'));
          return;
        }
        onCount(total);
        callback(null, chunk);
      },
    });
  }
}
