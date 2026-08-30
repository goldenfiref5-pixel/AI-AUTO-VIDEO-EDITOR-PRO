import type { ApiKeyStatus } from '@aiedit/shared';

export interface InlineData {
  mimeType: string;
  data: string; // base64
}

export interface FileRef {
  fileUri: string;
  mimeType: string;
}

export type Part =
  | { text: string }
  | { inlineData: InlineData }
  | { fileData: FileRef };

export interface Content {
  role: 'user' | 'model';
  parts: Part[];
}

export interface GenerationConfig {
  temperature?: number;
  topP?: number;
  topK?: number;
  maxOutputTokens?: number;
  responseMimeType?: string;
  responseSchema?: Record<string, unknown>;
  candidateCount?: number;
  /** Image model knob: which modalities the model may return. */
  responseModalities?: Array<'TEXT' | 'IMAGE'>;
  thinkingConfig?: { thinkingBudget?: number };
  imageConfig?: { aspectRatio?: string; imageSize?: string };
}

export interface SafetySetting {
  category: string;
  threshold: string;
}

export interface GenerateContentRequest {
  contents: Content[];
  systemInstruction?: { parts: Part[] };
  generationConfig?: GenerationConfig;
  safetySettings?: SafetySetting[];
}

export interface UsageMetadata {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  totalTokenCount?: number;
}

export interface Candidate {
  content?: { parts?: Part[]; role?: string };
  finishReason?: string;
  safetyRatings?: Array<{ category: string; probability: string; blocked?: boolean }>;
}

export interface GenerateContentResponse {
  candidates?: Candidate[];
  usageMetadata?: UsageMetadata;
  promptFeedback?: { blockReason?: string };
}

export interface GeminiModelInfo {
  name: string;
  displayName?: string;
  description?: string;
  supportedGenerationMethods?: string[];
  inputTokenLimit?: number;
  outputTokenLimit?: number;
}

export interface LongRunningOperation {
  name: string;
  done?: boolean;
  error?: { code: number; message: string };
  response?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

/** How a failure should be classified against the key that produced it. */
export type FailureClass =
  | 'invalid_key'
  | 'permission'
  | 'quota'
  | 'rate_limit'
  | 'server'
  | 'timeout'
  | 'network'
  | 'safety'
  | 'bad_request'
  | 'unknown';

export class GeminiError extends Error {
  readonly statusCode: number | null;
  readonly failureClass: FailureClass;
  readonly retryable: boolean;
  /** True when the *key* is at fault and the request should move to another. */
  readonly keyAtFault: boolean;
  readonly retryAfterMs: number | null;
  readonly detail: unknown;

  constructor(params: {
    message: string;
    statusCode?: number | null;
    failureClass: FailureClass;
    retryable: boolean;
    keyAtFault: boolean;
    retryAfterMs?: number | null;
    detail?: unknown;
  }) {
    super(params.message);
    this.name = 'GeminiError';
    this.statusCode = params.statusCode ?? null;
    this.failureClass = params.failureClass;
    this.retryable = params.retryable;
    this.keyAtFault = params.keyAtFault;
    this.retryAfterMs = params.retryAfterMs ?? null;
    this.detail = params.detail;
  }

  /** Status to persist on the api_keys row when this key is at fault. */
  toKeyStatus(): ApiKeyStatus {
    switch (this.failureClass) {
      case 'invalid_key':
        return 'invalid';
      case 'permission':
        return 'blocked';
      case 'quota':
        return 'quota_exceeded';
      case 'rate_limit':
        return 'rate_limited';
      default:
        return 'error';
    }
  }
}
