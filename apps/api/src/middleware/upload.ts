import { mkdirSync } from 'node:fs';
import path from 'node:path';
import multer from 'multer';
import {
  LIMITS,
  SUPPORTED_AUDIO_MIME,
  SUPPORTED_IMAGE_MIME,
  SUPPORTED_VIDEO_MIME,
} from '@aiedit/shared';
import { env } from '../config/env';
import { badRequest } from '../utils/errors';

const tmpDir = path.resolve(env.UPLOAD_TMP_DIR);
mkdirSync(tmpDir, { recursive: true });

// Uploads land on disk rather than in memory: a two-hour WAV would otherwise
// have to be buffered whole before it could be probed or forwarded.
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, tmpDir),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).slice(0, 12);
    cb(null, `${Date.now()}-${Math.random().toString(36).slice(2, 10)}${ext}`);
  },
});

function filterFor(allowed: readonly string[], label: string) {
  return (_req: unknown, file: Express.Multer.File, cb: multer.FileFilterCallback): void => {
    // Some browsers send application/octet-stream for uncommon audio types, so
    // the extension is accepted as a fallback signal.
    const ext = path.extname(file.originalname).toLowerCase();
    const extAllowed = ['.mp3', '.wav', '.aac', '.m4a', '.flac', '.mp4', '.mov', '.webm', '.mkv', '.png', '.jpg', '.jpeg', '.webp', '.heic'];

    if (allowed.includes(file.mimetype) || (file.mimetype === 'application/octet-stream' && extAllowed.includes(ext))) {
      cb(null, true);
      return;
    }
    cb(badRequest(`${file.originalname} is not a supported ${label} file (${file.mimetype}).`));
  };
}

export const uploadAudio = multer({
  storage,
  limits: { fileSize: Math.min(env.MAX_UPLOAD_BYTES, LIMITS.maxAudioBytes), files: 1 },
  fileFilter: filterFor(SUPPORTED_AUDIO_MIME, 'audio'),
});

export const uploadImages = multer({
  storage,
  limits: { fileSize: LIMITS.maxImageBytes, files: LIMITS.maxStyleReferences },
  fileFilter: filterFor(SUPPORTED_IMAGE_MIME, 'image'),
});

export const uploadVideo = multer({
  storage,
  limits: { fileSize: Math.min(env.MAX_UPLOAD_BYTES, LIMITS.maxVideoBytes), files: 1 },
  fileFilter: filterFor(SUPPORTED_VIDEO_MIME, 'video'),
});
