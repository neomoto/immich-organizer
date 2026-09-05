import { fireEvent, render, waitFor } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { organizer, type AssetAnalysis, type OrganizerStatus } from '$lib/components/organizer/api';
import Organize from './+page.svelte';

vi.mock(
  '$lib/components/layouts/UserPageLayout.svelte',
  async () => import('@test-data/mocks/UserPageLayout.mock.svelte'),
);
vi.mock('$lib/components/organizer/api', async (original) => ({
  ...(await original<typeof import('$lib/components/organizer/api')>()),
  organizer: vi.fn(),
}));
vi.mock('@immich/sdk', () => ({ getAllAlbums: vi.fn().mockResolvedValue([{ id: 'album-one', albumName: 'Summer' }]) }));

const photo = (id: string): AssetAnalysis => ({ id, filename: `${id}.jpg`, status: 'analyzed', locks: {}, facts: {} });

describe('Organize page', () => {
  let status: OrganizerStatus;
  let failure: string;
  let assets: AssetAnalysis[];
  let searchResults: (path: string) => Promise<AssetAnalysis[]>;

  beforeEach(() => {
    status = {
      connected: true,
      settings: { enabled: true, automatic: true, continuous: true, dailyLimit: 5000 },
      counts: [],
      usage: [],
      runs: [],
      provider: { model: 'synthetic', configured: true },
    };
    failure = '';
    assets = [photo('one'), photo('two')];
    searchResults = () => Promise.resolve(assets);
    vi.mocked(organizer)
      .mockReset()
      .mockImplementation(async (path, body) => {
        if (path === failure) {
          throw new Error('Synthetic operation failed');
        }
        if (path === '/status') {
          return structuredClone(status);
        }
        if (path.startsWith('/assets?')) {
          return searchResults(path);
        }
        if (path === '/settings') {
          Object.assign(status.settings, body);
          return { settings: status.settings };
        }
        if (path === '/runs') {
          return { runId: 'run-one', requested: (body as { limit: number }).limit };
        }
        if (path === '/connect') {
          status.connected = true;
          return { connected: true };
        }
        return [];
      });
  });

  async function open() {
    const view = render(Organize);
    await view.findByRole('button', { name: 'Analyze pilot · 200' });
    return view;
  }

  it('queues a bounded read-only pilot before any automatic metadata writes', async () => {
    const view = await open();
    await fireEvent.click(view.getByRole('button', { name: 'Analyze pilot · 200' }));
    expect(await view.findByText(/Pilot mode: metadata changes are disabled/)).toBeInTheDocument();
    const mutations = vi.mocked(organizer).mock.calls.filter(([, body]) => body !== undefined);
    expect(mutations).toEqual([
      ['/settings', { enabled: true, continuous: false, automatic: false }, 'PUT'],
      ['/runs', { limit: 200 }],
    ]);
  });

  it('queues the library and enables continuous discovery', async () => {
    const view = await open();
    await fireEvent.click(view.getByRole('button', { name: 'Analyze library' }));
    await view.findByText(/Analysis run queued for up to 100000 assets/);
    expect(organizer).toHaveBeenCalledWith('/settings', { enabled: true, continuous: true }, 'PUT');
    expect(organizer).toHaveBeenCalledWith('/runs', { limit: 100_000 });
  });

  it('queues only selected IDs or the chosen album without changing settings', async () => {
    const view = await open();
    await fireEvent.click(view.getByRole('checkbox', { name: 'Select one.jpg' }));
    await fireEvent.click(view.getByRole('button', { name: 'Analyze selected (1)' }));
    await view.findByText(/Run run-one queued for up to 1 assets/);
    expect(organizer).toHaveBeenCalledWith('/runs', { assetIds: ['one'], limit: 1, reanalyze: true });
    await waitFor(() => expect(view.getByRole('button', { name: 'Analyze selected (1)' })).not.toBeDisabled());
    const albumSelect = view.getByRole('combobox', { name: 'Album to analyze' }) as HTMLSelectElement;
    const querySelector = albumSelect.querySelector.bind(albumSelect);
    // happy-dom does not match selected options with :checked; Svelte uses this browser selector for binding.
    vi.spyOn(albumSelect, 'querySelector').mockImplementation((selector: string) =>
      selector === ':checked' ? albumSelect.selectedOptions[0] || null : querySelector(selector),
    );
    await userEvent.selectOptions(albumSelect, 'album-one');
    expect(albumSelect).toHaveValue('album-one');
    await waitFor(() => expect(view.getByRole('button', { name: 'Analyze album' })).not.toBeDisabled());
    await fireEvent.click(view.getByRole('button', { name: 'Analyze album' }));
    await view.findByText(/Run run-one queued for up to 100000 assets/);
    expect(organizer).toHaveBeenCalledWith('/runs', { albumId: 'album-one', limit: 100_000, reanalyze: true });
    expect(vi.mocked(organizer).mock.calls.some(([path]) => path === '/settings')).toBe(false);
  });

  it('pauses and resumes acquisition through the current settings', async () => {
    const view = await open();
    await fireEvent.click(view.getByRole('button', { name: 'Pause analysis' }));
    await view.findByRole('button', { name: 'Resume analysis' });
    expect(organizer).toHaveBeenCalledWith('/settings', { enabled: false }, 'PUT');
    await fireEvent.click(view.getByRole('button', { name: 'Resume analysis' }));
    await view.findByRole('button', { name: 'Pause analysis' });
    expect(organizer).toHaveBeenCalledWith('/settings', { enabled: true }, 'PUT');
  });

  it.each(['/settings', '/runs'])('does not report success when %s fails', async (path) => {
    failure = path;
    const view = await open();
    await fireEvent.click(view.getByRole('button', { name: 'Analyze pilot · 200' }));
    expect(await view.findByRole('alert')).toHaveTextContent('Synthetic operation failed');
    expect(view.queryByText(/Analysis run queued/)).not.toBeInTheDocument();
    if (path === '/settings') {
      expect(vi.mocked(organizer).mock.calls.some(([route]) => route === '/runs')).toBe(false);
    }
  });

  it('shows connection errors without exposing run actions or success', async () => {
    status.connected = false;
    failure = '/connect';
    const view = render(Organize);
    await fireEvent.click(await view.findByRole('button', { name: 'Connect Organize' }));
    expect(await view.findByRole('alert')).toHaveTextContent('Synthetic operation failed');
    expect(view.queryByRole('button', { name: 'Analyze pilot · 200' })).not.toBeInTheDocument();
    expect(view.queryByText(/queued for up to/)).not.toBeInTheDocument();
  });

  it('ignores a stale search response even if the server ignores cancellation', async () => {
    let resolveOld!: (value: AssetAnalysis[]) => void;
    searchResults = (path) => {
      const q = new URL(path, 'http://test').searchParams.get('q');
      return q === 'old'
        ? new Promise((resolve) => {
            resolveOld = resolve;
          })
        : Promise.resolve(q === 'new' ? [photo('new')] : assets);
    };
    const view = await open();
    const search = view.getByRole('textbox', { name: 'Search detected content' });
    await fireEvent.input(search, { target: { value: 'old' } });
    await waitFor(() => expect(resolveOld).toBeDefined());
    await fireEvent.input(search, { target: { value: 'new' } });
    await view.findByRole('checkbox', { name: 'Select new.jpg' });
    resolveOld([photo('old')]);
    await Promise.resolve();
    expect(view.queryByRole('checkbox', { name: 'Select old.jpg' })).not.toBeInTheDocument();
    expect(view.getByRole('checkbox', { name: 'Select new.jpg' })).toBeInTheDocument();
  });
});
