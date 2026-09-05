export interface AnalysisResult {
  caption: string;
  tags: string[];
  objects?: string[];
  activities?: string[];
  ocr?: string[];
  category?: string;
  date?: { start: string; end: string; precision: string; kind: string; confidence: string };
  location?: { name: string; precision: string; kind: string; confidence: string };
  evidence: { id?: string; kind: string; text: string }[];
  webSources?: { url: string; title: string }[];
  model: string;
  promptVersion: string;
}
export type LockField = 'date' | 'location' | 'description' | 'suppressed';
export interface AssetAnalysis {
  id: string;
  filename?: string;
  status: string;
  result?: AnalysisResult | null;
  proposal?: { estimatedLocation?: AnalysisResult['location']; locationApproximate?: boolean };
  error?: string;
  locks: Partial<Record<LockField, boolean>>;
  facts: { captureDay?: string | null; note?: string; suspectDate?: boolean; suspectLocation?: boolean };
  provenance?: unknown;
}
export interface Run {
  id: string;
  status: string;
  count: number;
  error?: string;
  created_at: string;
}
export interface OrganizerStatus {
  connected: boolean;
  settings: Record<string, boolean | number>;
  counts: { status: string; count: number }[];
  usage: { day: string; calls: number }[];
  runs: Run[];
  provider: { model: string; configured: boolean };
}
export interface Change {
  id: string;
  asset: string;
  kind: string;
  status: string;
  created_at: string;
  before_value: unknown;
  after_value: unknown;
}
export interface Event {
  id: string;
  album?: string;
  title: string;
  data: Pick<AnalysisResult, 'date' | 'location'>;
}
export interface QueuedRun {
  runId: string;
  requested: number;
}

export interface KeeperSession {
  id: string;
  owner?: string;
  title: string;
  summary: string;
  summary_seq: string | number;
  created_at: string;
  updated_at: string;
}

export interface KeeperMessage {
  seq: string | number;
  id: string;
  session: string;
  run: string;
  role: 'user' | 'assistant' | 'tool' | 'system';
  content: string;
  message?: Record<string, unknown>;
  created_at: string;
}

export interface KeeperRun {
  id: string;
  owner?: string;
  session: string;
  source: 'chat' | 'schedule' | string;
  status: 'queued' | 'running' | 'waiting' | 'complete' | 'failed' | 'stopped' | string;
  prompt: string;
  asset_ids: string[];
  options?: Record<string, unknown>;
  lease_until?: string | null;
  next_at?: string | null;
  stop_requested: boolean;
  slice_turns: number;
  slice_tool_calls: number;
  slice_mutations: number;
  total_turns: number;
  total_tool_calls: number;
  total_mutations: number;
  checkpoint: Record<string, unknown>;
  blocked_reason?: string | null;
  error?: string | null;
  created_at: string;
  ended_at?: string | null;
}

export interface KeeperEvent {
  seq: string | number;
  owner?: string;
  run: string;
  type: string;
  data: Record<string, unknown>;
  created_at: string;
}

export interface KeeperSchedule {
  owner?: string;
  enabled: boolean;
  hour: number;
  time_zone: string;
  next_at?: string | null;
  last_run_at?: string | null;
  last_run_id?: string | null;
  last_error?: string | null;
  updated_at?: string;
}

export interface KeeperPage<T> {
  [key: string]: T[] | string | null;
  nextCursor: string | null;
}

export interface KeeperQueuedMessage {
  run: KeeperRun;
  message: KeeperMessage;
}

export function keeperSessions(cursor?: string, limit = 50, signal?: AbortSignal) {
  const params = new URLSearchParams({ limit: String(limit) });
  if (cursor) {params.set('cursor', cursor);}
  return organizer<{ sessions: KeeperSession[]; nextCursor: string | null }>(`/keeper/sessions?${params}`, undefined, 'GET', signal);
}

export function keeperCreateSession(title?: string, signal?: AbortSignal) {
  return organizer<KeeperSession>('/keeper/sessions', { ...(title && { title }) }, 'POST', signal);
}

export function keeperMessages(sessionId: string, cursor?: string, limit = 100, signal?: AbortSignal) {
  const params = new URLSearchParams({ limit: String(limit) });
  if (cursor) {params.set('cursor', cursor);}
  return organizer<{ messages: KeeperMessage[]; nextCursor: string | null }>(`/keeper/sessions/${sessionId}/messages?${params}`, undefined, 'GET', signal);
}

export function keeperEnqueueMessage(sessionId: string, content: string, signal?: AbortSignal) {
  return organizer<KeeperQueuedMessage>(`/keeper/sessions/${sessionId}/messages`, { content }, 'POST', signal);
}

export function keeperSessionRuns(sessionId: string, cursor?: string, limit = 50, signal?: AbortSignal) {
  const params = new URLSearchParams({ limit: String(limit) });
  if (cursor) {params.set('cursor', cursor);}
  return organizer<{ runs: KeeperRun[]; nextCursor: string | null }>(`/keeper/sessions/${sessionId}/runs?${params}`, undefined, 'GET', signal);
}

export function keeperRun(runId: string, signal?: AbortSignal) {
  return organizer<KeeperRun>(`/keeper/runs/${runId}`, undefined, 'GET', signal);
}

export function keeperEvents(runId: string, cursor?: string, limit = 100, signal?: AbortSignal) {
  const params = new URLSearchParams({ limit: String(limit) });
  if (cursor) {params.set('cursor', cursor);}
  return organizer<{ events: KeeperEvent[]; nextCursor: string | null }>(`/keeper/runs/${runId}/events?${params}`, undefined, 'GET', signal);
}

export function keeperStop(runId: string, signal?: AbortSignal) {
  return organizer<KeeperRun>(`/keeper/runs/${runId}/stop`, {}, 'POST', signal);
}

export function keeperResume(runId: string, signal?: AbortSignal) {
  return organizer<KeeperRun>(`/keeper/runs/${runId}/resume`, {}, 'POST', signal);
}

export function keeperSchedule(signal?: AbortSignal) {
  return organizer<KeeperSchedule>('/keeper/schedule', undefined, 'GET', signal);
}

export function keeperSetSchedule(body: Partial<Pick<KeeperSchedule, 'enabled' | 'hour' | 'time_zone'>> & { timeZone?: string }, signal?: AbortSignal) {
  const { time_zone: _timeZone, ...rest } = body;
  return organizer<KeeperSchedule>('/keeper/schedule', { ...rest, ...(body.timeZone && { timeZone: body.timeZone }), ...(_timeZone && { time_zone: _timeZone }) }, 'PUT', signal);
}

export function safeSourceUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) ? url.href : undefined;
  } catch {
    return undefined;
  }
}

export async function organizer<T = unknown>(
  path: string,
  body?: unknown,
  method = body === undefined ? 'GET' : 'POST',
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(`/api/organizer${path}`, {
    method,
    signal,
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  if (!response.ok) {
    const data: unknown = await response.json().catch(() => null);
    const detail =
      data && typeof data === 'object' && 'error' in data && typeof data.error === 'string' ? data.error : undefined;
    throw new Error(
      detail ||
        (response.status === 503
          ? 'Organizer worker is not configured.'
          : `Organizer request failed (${response.status})`),
    );
  }
  if (response.status === 204) {
    return undefined as T;
  }
  return response.json();
}
