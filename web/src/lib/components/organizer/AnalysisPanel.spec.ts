import { fireEvent, render, waitFor } from '@testing-library/svelte';
import AnalysisPanel from './AnalysisPanel.svelte';
import { organizer, type AssetAnalysis } from './api';

vi.mock('./api', async (original) => ({ ...(await original<typeof import('./api')>()), organizer: vi.fn() }));

const asset = (id: string): AssetAnalysis => ({
  id,
  status: 'analyzed',
  locks: { date: true },
  facts: { captureDay: '2001-01-02', note: 'Family archive' },
  result: {
    caption: `Caption ${id}`,
    tags: [],
    objects: ['boat'],
    activities: [],
    ocr: ['Привет'],
    evidence: [],
    model: 'glm-test',
    promptVersion: 'test',
    date: { start: '2001-01-01', end: '2001-12-31', precision: 'year', kind: 'depicted', confidence: 'low' },
    location: { name: 'Paris', precision: 'city', kind: 'depicted', confidence: 'low' },
    webSources: [{ url: 'javascript:alert(1)', title: 'Unsafe source' }],
  },
});

describe('AnalysisPanel', () => {
  beforeEach(() => vi.mocked(organizer).mockReset());

  it('labels uncertainty, preserves OCR, and excludes unsafe source links', async () => {
    vi.mocked(organizer).mockResolvedValue(asset('one'));
    const view = render(AnalysisPanel, { assetId: 'one' });
    expect(await view.findByText(/not an exact capture timestamp/)).toBeInTheDocument();
    expect(view.getByText(/Approximate place: Paris/)).toBeInTheDocument();
    expect(view.getByText('Привет')).toBeInTheDocument();
    expect(view.queryByRole('link', { name: 'Unsafe source' })).not.toBeInTheDocument();
    expect(view.getByRole('button', { name: 'Unlock date' })).toHaveAttribute('aria-pressed', 'true');
    expect(view.getByLabelText('Known capture day')).toHaveValue('2001-01-02');
  });

  it('ignores stale loads when the selected asset changes', async () => {
    let resolveFirst!: (value: AssetAnalysis) => void;
    vi.mocked(organizer).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFirst = resolve;
        }),
    );
    vi.mocked(organizer).mockResolvedValue(asset('two'));
    const view = render(AnalysisPanel, { assetId: 'one' });
    await waitFor(() => expect(organizer).toHaveBeenCalledTimes(1));
    await view.rerender({ assetId: 'two' });
    expect(await view.findByText('Caption two')).toBeInTheDocument();
    resolveFirst(asset('one'));
    await Promise.resolve();
    expect(view.queryByText('Caption one')).not.toBeInTheDocument();
  });

  it('surfaces a failed queue and never reports it as queued', async () => {
    vi.mocked(organizer).mockResolvedValueOnce(asset('one')).mockRejectedValueOnce(new Error('Connect Organize first'));
    const view = render(AnalysisPanel, { assetId: 'one' });
    await view.findByText('Caption one');
    await fireEvent.click(view.getByRole('button', { name: 'Analyze again' }));
    expect(await view.findByRole('alert')).toHaveTextContent('Connect Organize first');
    expect(view.queryByText(/Analysis queued/)).not.toBeInTheDocument();
  });

  it('clears a known date explicitly and prevents duplicate fact submissions', async () => {
    vi.mocked(organizer)
      .mockResolvedValueOnce(asset('one'))
      .mockImplementationOnce(() => new Promise(() => {}));
    const view = render(AnalysisPanel, { assetId: 'one' });
    await view.findByText('Caption one');
    await fireEvent.input(view.getByLabelText('Known capture day'), { target: { value: '' } });
    const save = view.getByRole('button', { name: 'Save evidence and reanalyze' });
    await fireEvent.click(save);
    await fireEvent.click(save);
    expect(organizer).toHaveBeenCalledTimes(2);
    expect(organizer).toHaveBeenLastCalledWith(
      '/assets/one',
      { facts: { captureDay: null, note: 'Family archive', suspectDate: false, suspectLocation: false } },
      'PUT',
    );
  });
});
