import { fireEvent, render, waitFor } from '@testing-library/svelte';
import KeeperPanel from './KeeperPanel.svelte';
import {
  keeperCreateSession,
  keeperEnqueueMessage,
  keeperEvents,
  keeperMessages,
  keeperResume,
  keeperRun,
  keeperSchedule,
  keeperSessions,
  keeperSessionRuns,
  keeperSetSchedule,
  keeperStop,
  type KeeperRun,
} from './api';

vi.mock('./api', async (original) => ({
  ...(await original<typeof import('./api')>()),
  keeperCreateSession: vi.fn(),
  keeperEnqueueMessage: vi.fn(),
  keeperEvents: vi.fn(),
  keeperMessages: vi.fn(),
  keeperResume: vi.fn(),
  keeperRun: vi.fn(),
  keeperSchedule: vi.fn(),
  keeperSessions: vi.fn(),
  keeperSessionRuns: vi.fn(),
  keeperSetSchedule: vi.fn(),
  keeperStop: vi.fn(),
}));

const session = {
  id: 'session-one',
  title: 'Archive keeper',
  summary: '',
  summary_seq: 0,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
};

const run: KeeperRun = {
  id: 'run-one',
  session: session.id,
  source: 'chat',
  status: 'waiting',
  prompt: 'Review my archive',
  asset_ids: [],
  stop_requested: false,
  slice_turns: 1,
  slice_tool_calls: 1,
  slice_mutations: 0,
  total_turns: 1,
  total_tool_calls: 1,
  total_mutations: 0,
  checkpoint: { messageSeq: 4 },
  blocked_reason: 'quota',
  error: null,
  created_at: '2026-01-01T00:00:00.000Z',
};

function setup() {
  vi.mocked(keeperSessions).mockResolvedValue({ sessions: [session], nextCursor: null });
  vi.mocked(keeperSchedule).mockResolvedValue({ enabled: false, hour: 3, time_zone: 'UTC' });
  vi.mocked(keeperMessages).mockResolvedValue({ messages: [], nextCursor: null });
  vi.mocked(keeperSessionRuns).mockResolvedValue({ runs: [run], nextCursor: null });
  vi.mocked(keeperEvents).mockResolvedValue({ events: [{ seq: 1, run: run.id, type: 'run.checkpoint', data: {}, created_at: '2026-01-01T00:00:00.000Z' }], nextCursor: null });
  vi.mocked(keeperRun).mockResolvedValue(run);
  vi.mocked(keeperCreateSession).mockResolvedValue({ ...session, id: 'session-two', title: 'New keeper' });
  vi.mocked(keeperEnqueueMessage).mockResolvedValue({ run, message: { seq: 2, id: 'message-one', session: session.id, run: run.id, role: 'user', content: 'Hello', created_at: '2026-01-01T00:00:00.000Z' } });
  vi.mocked(keeperStop).mockResolvedValue({ ...run, status: 'stopped' });
  vi.mocked(keeperResume).mockResolvedValue({ ...run, status: 'queued', blocked_reason: null });
  vi.mocked(keeperSetSchedule).mockResolvedValue({ enabled: true, hour: 3, time_zone: 'UTC' });
}

describe('KeeperPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setup();
  });

  it('shows persistent sessions and queues a message with background continuation text', async () => {
    const view = render(KeeperPanel);
    await view.findByRole('button', { name: 'Archive keeper' });
    const input = view.getByLabelText('Message Keeper');
    await fireEvent.input(input, { target: { value: 'Hello Keeper' } });
    await fireEvent.click(view.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(keeperEnqueueMessage).toHaveBeenCalledWith(session.id, 'Hello Keeper', expect.anything()));
    expect(await view.findByText(/continues in the worker/)).toBeInTheDocument();
  });

  it('shows quota/checkpoint state and supports stop then resume', async () => {
    const view = render(KeeperPanel);
    expect(await view.findByText(/Waiting for the daily model quota/)).toBeInTheDocument();
    expect(view.getByText(/Checkpoint saved/)).toBeInTheDocument();
    await fireEvent.click(view.getByRole('button', { name: 'Stop' }));
    await waitFor(() => expect(keeperStop).toHaveBeenCalledWith(run.id));
    await fireEvent.click(view.getByRole('button', { name: 'Resume' }));
    await waitFor(() => expect(keeperResume).toHaveBeenCalledWith(run.id));
  });

  it('exposes the NAS-local three o’clock schedule control', async () => {
    const view = render(KeeperPanel);
    const schedule = await view.findByRole('region', { name: 'Keeper schedule' });
    expect(schedule).toHaveTextContent('Start hour (NAS time)');
    expect(schedule.querySelector('input[type="number"]')).toHaveValue(3);
    await fireEvent.click(view.getByRole('checkbox', { name: 'Enable' }));
    await waitFor(() => expect(keeperSetSchedule).toHaveBeenCalledWith({ enabled: true, hour: 3, timeZone: 'UTC' }));
  });
});
