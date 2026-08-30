/**
 * Every prompt the pipeline sends to Gemini lives here so the wording can be
 * tuned in one place. Prompts are deliberately explicit about JSON shape —
 * responses are parsed with `parseJsonLoose`, but a well-specified schema
 * removes most of the need for repair.
 */

export const TRANSCRIPTION_SYSTEM = `You are a professional transcriptionist producing broadcast-quality transcripts.

Rules:
- Transcribe every spoken word exactly. Never summarise, translate, or invent content.
- Preserve the speaker's original language. For mixed-language narration, keep each phrase in the language it was spoken.
- Apply correct punctuation, capitalisation and sentence boundaries for the language in question.
- Remove filler stutters only when they are clearly disfluencies (uh, um, repeated false starts). Keep all meaningful words.
- Timestamps must be in seconds relative to the start of the audio, accurate to 0.05s.
- Every word in a segment must have its own start/end timing, in order, non-overlapping, inside the segment bounds.
- If multiple speakers are audible, label them "Speaker 1", "Speaker 2", and so on. If there is only one voice, use null.
- Output nothing except the JSON object.`;

export function transcriptionPrompt(languageHint: string, durationSec: number): string {
  const language =
    languageHint === 'auto' || languageHint === 'mixed'
      ? 'Detect the spoken language(s) yourself.'
      : `The narration is expected to be in "${languageHint}", but trust the audio over this hint.`;

  return `Transcribe this ${durationSec.toFixed(1)} second narration audio.

${language}

Return JSON in exactly this shape:
{
  "language": "ISO-639-1 code of the dominant language",
  "confidence": 0.0-1.0,
  "segments": [
    {
      "text": "One sentence or natural phrase of narration.",
      "start": 0.0,
      "end": 3.42,
      "speaker": null,
      "words": [ { "text": "One", "start": 0.0, "end": 0.21 } ]
    }
  ]
}

Segment on natural sentence boundaries. Keep segments under 20 seconds each; split long sentences on clause boundaries rather than exceeding that.`;
}

export const SCRIPT_ENHANCEMENT_SYSTEM = `You are a careful copy editor working on a narration transcript.

Absolute rules:
- Never change the meaning, facts, names, numbers or order of ideas.
- Never add new sentences, opinions, or content that was not spoken.
- Never remove content. Never translate.
- Only correct grammar, punctuation, capitalisation, spelling and obvious transcription slips.
- Preserve the speaker's voice, register and word choice wherever it is already correct.
- Return the same number of segments in the same order.`;

export function scriptEnhancementPrompt(
  segments: Array<{ index: number; text: string }>,
  options: { fixGrammar: boolean; improvePunctuation: boolean; improveReadability: boolean; instructions?: string },
): string {
  const tasks = [
    options.fixGrammar ? 'fix grammatical errors' : null,
    options.improvePunctuation ? 'correct punctuation and capitalisation' : null,
    options.improveReadability ? 'improve readability without changing wording that is already clear' : null,
  ].filter(Boolean);

  return `Edit the following narration segments. Tasks: ${tasks.join(', ')}.
${options.instructions ? `\nAdditional instruction from the user: ${options.instructions}\n` : ''}
Return JSON: { "segments": [ { "index": 0, "text": "edited text" } ] }

Segments:
${JSON.stringify(segments, null, 2)}`;
}

export const STYLE_DNA_SYSTEM = `You are a cinematographer and colourist analysing reference frames to produce a reusable visual style specification.

Describe only what is visually observable. Be concrete and technical: name the lighting setup, the lens character, the grade, the composition rules. Your output is fed verbatim into an image generation model, so write in the language of image prompts — dense, specific, comma-separated descriptors — not in the language of art criticism.`;

export function styleDnaPrompt(imageCount: number): string {
  return `Analyse these ${imageCount} reference images as a single coherent visual style.

Return JSON:
{
  "name": "Short memorable name for this look",
  "summary": "2-3 sentences describing the overall look",
  "colorPalette": ["#RRGGBB", ...up to 8 dominant colours],
  "colorGrading": "Grade description: contrast, saturation, lift/gamma/gain, film emulation",
  "lighting": "Key/fill/rim setup, quality, direction, colour temperature, practicals",
  "composition": "Framing rules, subject placement, depth layering, negative space",
  "cameraLens": "Focal length range, aperture character, distortion, bokeh",
  "cameraStyle": "Camera height, movement language, shot sizes favoured",
  "mood": "Emotional register in 3-6 words",
  "realismLevel": "photoreal | stylised realism | illustrative | 3D render | anime | painterly",
  "artisticStyle": "Named influences and rendering approach",
  "textureDetail": "Grain, sharpness, surface detail, atmospheric particulates",
  "negativePrompt": "Comma-separated list of things that must never appear in this style",
  "promptSuffix": "A single dense comma-separated fragment (40-70 words) appended to every scene prompt to reproduce this exact look"
}`;
}

export const COMPETITOR_SYSTEM = `You are a short-form video editor reverse-engineering the editorial grammar of a reference video.

You extract structural and stylistic patterns only — pacing, rhythm, structure, caption treatment, transition vocabulary. You never reproduce or describe the reference's specific content, script, characters or branding, because the output is used to inform an entirely original production.`;

export const COMPETITOR_PROMPT = `Analyse this video's editing craft and return JSON:
{
  "editingPace": "one of: very fast | fast | moderate | slow, plus a short justification",
  "avgSceneDurationSec": number,
  "sceneDurationPattern": [array of 8-20 observed shot lengths in seconds],
  "storyStructure": "How the narrative is arranged: hook, setup, escalation, payoff, CTA...",
  "captionStyle": "Font weight, size, placement, colour, animation, word grouping",
  "transitionStyle": "Which transitions are used and where",
  "cameraMovement": "Dominant camera language",
  "hookStructure": "How the first 3 seconds capture attention (structurally, not verbatim)",
  "visualRhythm": "How cuts relate to the audio beat and narration cadence",
  "recommendations": ["3-6 specific, actionable techniques to apply to an original video"]
}

Describe technique only. Do not transcribe or paraphrase the video's script.`;

export const STORY_ANALYSIS_SYSTEM = `You are a story analyst and storyboard artist working in automated video production.

You turn a narration transcript into a precise scene-by-scene visual plan. Your output drives an image generation model, so every visual prompt must be self-contained, concrete and shootable: subject, action, environment, framing, lighting, mood. Never write abstractions like "a metaphor for hope" — write the picture.

Hard requirements:
- Scenes must tile the narration exactly: contiguous, no gaps, no overlaps.
- Every scene's narration text must be a verbatim contiguous slice of the transcript.
- Respect the requested scene count and duration bounds.
- Reuse the exact character names you are given; never invent a new name for the same person.`;

export interface StoryAnalysisParams {
  transcript: string;
  durationSec: number;
  targetSceneCount: number;
  minSceneSec: number;
  maxSceneSec: number;
  aspectRatio: string;
  language: string;
  styleSummary: string;
  pacingGuidance: string;
  brollCategories: string[];
}

export function storyAnalysisPrompt(p: StoryAnalysisParams): string {
  return `Break this narration into a complete visual scene plan.

NARRATION (${p.language}, ${p.durationSec.toFixed(1)}s total):
"""
${p.transcript}
"""

PRODUCTION BRIEF
- Aspect ratio: ${p.aspectRatio}
- Target scene count: ${p.targetSceneCount} (±15%)
- Scene duration bounds: ${p.minSceneSec}s to ${p.maxSceneSec}s
- Visual style to assume: ${p.styleSummary || 'cinematic, photoreal, filmic grade'}
- Pacing guidance: ${p.pacingGuidance}
- B-roll categories available: ${p.brollCategories.join(', ')}

Return JSON:
{
  "title": "Suggested video title",
  "logline": "One sentence summary",
  "storyArc": ["Act or beat labels in order"],
  "characters": [
    {
      "name": "Consistent name used across all scenes",
      "role": "protagonist | supporting | background",
      "age": "e.g. 'boy, around 10 years old'",
      "gender": "as described or implied; 'unspecified' if unknown",
      "skinTone": "specific descriptor",
      "hair": "colour, length, texture, style",
      "face": "face shape, eyes, nose, distinguishing features",
      "bodyShape": "build and height",
      "clothing": "complete outfit, worn in every scene unless the story changes it",
      "accessories": "props carried or worn",
      "canonicalPrompt": "A dense 40-60 word description used verbatim in every image prompt featuring this character"
    }
  ],
  "locations": [ { "name": "...", "description": "..." } ],
  "scenes": [
    {
      "index": 0,
      "narration": "Verbatim slice of the transcript covered by this scene",
      "visualPrompt": "Complete image prompt: subject, action, environment, framing, lens, lighting, mood. 30-60 words.",
      "emotion": "The dominant emotion",
      "location": "Location name from the list above",
      "characters": ["names of characters visible in this scene"],
      "cameraMotion": "one of: static, pan_left, pan_right, tilt_up, tilt_down, dolly_in, dolly_out, zoom_in, zoom_out, orbit, push_in, pull_out, handheld",
      "motionPrompt": "What moves in this shot over its duration — subject action and camera move, 15-30 words",
      "isBroll": true only when no character appears and the shot illustrates a mentioned object/place/concept,
      "brollSubject": "the concrete subject when isBroll is true, otherwise null",
      "weight": 1.0
    }
  ]
}

"weight" expresses how much screen time this beat deserves relative to its word count (0.7 = rush it, 1.5 = let it breathe). Timings are assigned by the system from the audio, not by you.`;
}

export function sceneImagePrompt(params: {
  visualPrompt: string;
  characterPrompts: string[];
  styleSuffix: string;
  aspectRatio: string;
  emotion: string;
  location: string;
}): string {
  const parts = [params.visualPrompt.trim()];

  if (params.characterPrompts.length) {
    parts.push(
      `CHARACTER CONSISTENCY (reproduce these people exactly, identical in every shot): ${params.characterPrompts.join(' | ')}`,
    );
  }
  if (params.location) parts.push(`Location: ${params.location}.`);
  if (params.emotion) parts.push(`Emotional tone: ${params.emotion}.`);
  if (params.styleSuffix) parts.push(`STYLE: ${params.styleSuffix}`);

  parts.push(
    `Composed for a ${params.aspectRatio} frame. Cinematic, high detail, professional colour grade. No text, no watermarks, no logos, no subtitles, no borders.`,
  );

  return parts.join('\n\n');
}

export function motionPromptFor(params: {
  motionPrompt: string | null;
  cameraMotion: string;
  emotion: string;
  narration: string;
}): string {
  const camera: Record<string, string> = {
    static: 'locked-off camera, no camera movement',
    pan_left: 'slow camera pan to the left',
    pan_right: 'slow camera pan to the right',
    tilt_up: 'smooth camera tilt upward',
    tilt_down: 'smooth camera tilt downward',
    dolly_in: 'dolly the camera forward toward the subject',
    dolly_out: 'dolly the camera backward away from the subject',
    zoom_in: 'gradual zoom in',
    zoom_out: 'gradual zoom out',
    orbit: 'camera orbits slowly around the subject',
    push_in: 'slow cinematic push in on the subject',
    pull_out: 'slow cinematic pull out revealing the environment',
    handheld: 'subtle handheld camera movement, natural breathing motion',
  };

  return [
    params.motionPrompt?.trim() || `Bring this still to life in keeping with: ${params.narration.slice(0, 160)}`,
    `Camera: ${camera[params.cameraMotion] ?? 'slow cinematic push in'}.`,
    `Mood: ${params.emotion || 'neutral'}.`,
    'Natural, physically plausible motion. Preserve the subject\'s identity, clothing and the frame\'s colour grade exactly. No text overlays. No audio.',
  ].join(' ');
}

export function brollPrompt(params: {
  subject: string;
  narration: string;
  styleSuffix: string;
  aspectRatio: string;
}): string {
  return `Cinematic B-roll shot of ${params.subject}, illustrating the narration: "${params.narration.slice(0, 200)}".

No people's faces in focus. Shallow depth of field, filmic movement, editorial quality.

STYLE: ${params.styleSuffix}

Composed for a ${params.aspectRatio} frame. No text, no watermarks, no logos.`;
}

export const QUALITY_REVIEW_SYSTEM = `You are a picky post-production supervisor doing a final QC pass before a video ships. You score honestly and flag concrete, fixable problems.`;

export function qualityReviewPrompt(payload: unknown): string {
  return `Review this generated video project and score it.

Return JSON:
{
  "storyAlignment": { "score": 0-100, "notes": "..." },
  "visualQuality": { "score": 0-100, "notes": "..." },
  "warnings": ["specific, actionable issues"]
}

Project data:
${JSON.stringify(payload, null, 2)}`;
}
