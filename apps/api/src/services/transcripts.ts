import type { Transcript, TranscriptSegment } from '@aiedit/shared';
import { query, queryOne, withTransaction } from '../db/pool';
import { badRequest, notFound } from '../utils/errors';
import { countWords, escapeRegExp, normalizeWhitespace, segmentsToText } from '../utils/text';
import { normalizeSegments, realignWords, segmentsFromWords } from '../pipeline/align';
import { mapTranscript } from './mappers';

const COLUMNS = `id, project_id, asset_id, language, text, segments, word_count, duration_sec,
                 confidence, approved_at, version, created_at, updated_at`;

/** How many undo steps the editor keeps per transcript. */
const MAX_VERSIONS = 50;

export async function getTranscript(projectId: string): Promise<Transcript | null> {
  const row = await queryOne(`SELECT ${COLUMNS} FROM transcripts WHERE project_id = $1`, [projectId]);
  return row ? mapTranscript(row) : null;
}

export async function requireTranscript(projectId: string): Promise<Transcript> {
  const transcript = await getTranscript(projectId);
  if (!transcript) throw notFound('This project has no transcript yet. Upload a voiceover first.');
  return transcript;
}

export interface UpsertTranscriptData {
  projectId: string;
  assetId: string;
  language: string;
  text: string;
  segments: TranscriptSegment[];
  wordCount: number;
  durationSec: number;
  confidence: number;
}

export async function upsertTranscript(data: UpsertTranscriptData): Promise<Transcript> {
  const row = await queryOne(
    `INSERT INTO transcripts (project_id, asset_id, language, text, segments, word_count,
                              duration_sec, confidence, version)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,1)
     ON CONFLICT (project_id) DO UPDATE SET
       asset_id = EXCLUDED.asset_id,
       language = EXCLUDED.language,
       text = EXCLUDED.text,
       segments = EXCLUDED.segments,
       word_count = EXCLUDED.word_count,
       duration_sec = EXCLUDED.duration_sec,
       confidence = EXCLUDED.confidence,
       approved_at = NULL,
       version = transcripts.version + 1
     RETURNING ${COLUMNS}`,
    [
      data.projectId,
      data.assetId,
      data.language,
      data.text,
      JSON.stringify(data.segments),
      data.wordCount,
      data.durationSec,
      data.confidence,
    ],
  );
  const transcript = mapTranscript(row!);
  await snapshot(transcript, 'transcribed');
  return transcript;
}

/** Push the current state onto the undo stack. */
async function snapshot(transcript: Transcript, reason: string): Promise<void> {
  await query(
    `INSERT INTO transcript_versions (transcript_id, version, text, segments, reason)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (transcript_id, version) DO NOTHING`,
    [transcript.id, transcript.version, transcript.text, JSON.stringify(transcript.segments), reason],
  );

  await query(
    `DELETE FROM transcript_versions
      WHERE transcript_id = $1
        AND version <= (
          SELECT MAX(version) - $2 FROM transcript_versions WHERE transcript_id = $1
        )`,
    [transcript.id, MAX_VERSIONS],
  );
}

export interface EditTranscriptInput {
  text?: string;
  segments?: TranscriptSegment[];
  language?: string;
  reason?: string;
}

/**
 * Apply a user edit.
 *
 * A full-text edit is re-aligned against the original word timings so captions
 * and scene boundaries stay locked to the audio. Explicit segment edits are
 * trusted as-is, since the timeline editor supplies its own timings.
 */
export async function editTranscript(
  transcript: Transcript,
  input: EditTranscriptInput,
): Promise<Transcript> {
  if (input.text === undefined && input.segments === undefined && input.language === undefined) {
    throw badRequest('Nothing to update.');
  }

  let segments = transcript.segments;
  let text = transcript.text;

  if (input.segments) {
    segments = normalizeSegments(input.segments);
    text = segmentsToText(segments);
  } else if (input.text !== undefined) {
    text = normalizeWhitespace(input.text);
    if (!text.trim()) throw badRequest('The transcript cannot be empty.');

    const originalWords = transcript.segments.flatMap((s) => s.words);
    const realigned = realignWords(originalWords, text, transcript.durationSec);
    segments = segmentsFromWords(text, realigned);

    if (segments.length === 0) {
      throw badRequest('The edited transcript could not be split into sentences.');
    }
  }

  return withTransaction(async (client) => {
    await client.query(
      `INSERT INTO transcript_versions (transcript_id, version, text, segments, reason)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (transcript_id, version) DO NOTHING`,
      [
        transcript.id,
        transcript.version,
        transcript.text,
        JSON.stringify(transcript.segments),
        input.reason ?? 'edit',
      ],
    );

    const { rows } = await client.query(
      `UPDATE transcripts SET
         text = $2,
         segments = $3,
         word_count = $4,
         language = COALESCE($5, language),
         version = version + 1,
         approved_at = NULL
       WHERE id = $1
       RETURNING ${COLUMNS}`,
      [transcript.id, text, JSON.stringify(segments), countWords(text), input.language ?? null],
    );
    return mapTranscript(rows[0]!);
  });
}

export async function approveTranscript(transcriptId: string): Promise<Transcript> {
  const row = await queryOne(
    `UPDATE transcripts SET approved_at = now() WHERE id = $1 RETURNING ${COLUMNS}`,
    [transcriptId],
  );
  if (!row) throw notFound('Transcript not found');
  return mapTranscript(row);
}

export interface TranscriptVersionSummary {
  version: number;
  reason: string | null;
  createdAt: string;
}

export async function listVersions(transcriptId: string): Promise<TranscriptVersionSummary[]> {
  const rows = await query<{ version: number; reason: string | null; created_at: Date }>(
    `SELECT version, reason, created_at FROM transcript_versions
      WHERE transcript_id = $1 ORDER BY version DESC LIMIT $2`,
    [transcriptId, MAX_VERSIONS],
  );
  return rows.map((row) => ({
    version: row.version,
    reason: row.reason,
    createdAt: row.created_at.toISOString(),
  }));
}

/** Restore a stored version — the editor's undo and redo both land here. */
export async function restoreVersion(
  transcript: Transcript,
  version: number,
): Promise<Transcript> {
  const stored = await queryOne<{ text: string; segments: TranscriptSegment[] }>(
    'SELECT text, segments FROM transcript_versions WHERE transcript_id = $1 AND version = $2',
    [transcript.id, version],
  );
  if (!stored) throw notFound(`Version ${version} is no longer available.`);

  return editTranscript(transcript, {
    segments: stored.segments,
    reason: `restore v${version}`,
  });
}

export interface SearchReplaceResult {
  transcript: Transcript;
  replacements: number;
}

export async function searchAndReplace(
  transcript: Transcript,
  params: { search: string; replace: string; caseSensitive: boolean; wholeWord: boolean },
): Promise<SearchReplaceResult> {
  const flags = params.caseSensitive ? 'gu' : 'giu';
  const body = escapeRegExp(params.search);
  const pattern = new RegExp(params.wholeWord ? `(?<![\\p{L}\\p{N}])${body}(?![\\p{L}\\p{N}])` : body, flags);

  const matches = transcript.text.match(pattern);
  const replacements = matches?.length ?? 0;
  if (replacements === 0) return { transcript, replacements: 0 };

  const updated = await editTranscript(transcript, {
    text: transcript.text.replace(pattern, params.replace),
    reason: `replace "${params.search}"`,
  });
  return { transcript: updated, replacements };
}

export function transcriptStats(transcript: Transcript): {
  wordCount: number;
  durationSec: number;
  segmentCount: number;
  wordsPerMinute: number;
} {
  const minutes = transcript.durationSec / 60;
  return {
    wordCount: transcript.wordCount,
    durationSec: transcript.durationSec,
    segmentCount: transcript.segments.length,
    wordsPerMinute: minutes > 0 ? Math.round(transcript.wordCount / minutes) : 0,
  };
}
