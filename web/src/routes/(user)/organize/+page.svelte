<script lang="ts">
  import { onMount } from 'svelte';
  import UserPageLayout from '$lib/components/layouts/UserPageLayout.svelte';
  import AnalysisPanel from '$lib/components/organizer/AnalysisPanel.svelte';
  import KeeperPanel from '$lib/components/organizer/KeeperPanel.svelte';
  import {
    organizer,
    type OrganizerStatus,
    type AssetAnalysis,
    type Event,
    type Change,
    type QueuedRun,
  } from '$lib/components/organizer/api';
  import { getAllAlbums, type AlbumResponseDto } from '@immich/sdk';
  let albums = $state<AlbumResponseDto[]>([]),
    albumId = $state('');
  let status = $state<OrganizerStatus | null>(null),
    assets = $state<AssetAnalysis[]>([]),
    events = $state<Event[]>([]),
    history = $state<Change[]>([]);
  let checked = $state<string[]>([]);
  let filter = $state('');
  let category = $state('');
  let datePrecision = $state('');
  let locationPrecision = $state('');
  let loading = $state(true);
  let historyOffset = $state(0);
  let generation = 0;
  let mounted = false;
  let searchTimer: ReturnType<typeof setTimeout>;
  let controller: AbortController | undefined;
  let error = $state(''),
    notice = $state(''),
    query = $state(''),
    selected = $state(''),
    tab = $state('Photos'),
    offset = $state(0),
    busy = $state(false);
  async function refresh() {
    const request = ++generation;
    controller?.abort();
    controller = new AbortController();
    const signal = controller.signal;
    loading = true;
    try {
      const nextStatus = await organizer<OrganizerStatus>('/status', undefined, 'GET', signal);
      if (nextStatus.connected) {
        const params = new URLSearchParams({
          q: query,
          offset: String(offset),
          status: filter,
          category,
          datePrecision,
          locationPrecision,
        });
        const next = await Promise.all([
          organizer<AssetAnalysis[]>(`/assets?${params}`, undefined, 'GET', signal),
          organizer<Event[]>('/events', undefined, 'GET', signal),
          organizer<Change[]>(`/history?offset=${historyOffset}`, undefined, 'GET', signal),
        ]);
        if (request !== generation || !mounted) {
          return;
        }
        [assets, events, history] = next;
      } else {
        if (request !== generation || !mounted) {
          return;
        }
        assets = [];
        events = [];
        history = [];
        checked = [];
        selected = '';
      }
      status = nextStatus;
      error = '';
    } catch (error_) {
      if (request === generation && mounted) {
        error = String(error_);
      }
    } finally {
      if (request === generation && mounted) {
        loading = false;
      }
    }
  }
  function search() {
    offset = 0;
    clearTimeout(searchTimer);
    // Invalidate requests immediately, before the debounce finishes.
    generation++;
    controller?.abort();
    searchTimer = setTimeout(() => void refresh(), 250);
  }
  onMount(() => {
    mounted = true;
    void getAllAlbums({})
      .then((r) => {
        if (mounted) {
          albums = r;
        }
      })
      .catch(() => {
        if (mounted) {
          error = 'Albums could not be loaded. Refresh the page to retry.';
        }
      });
    void refresh();
    const timer = setInterval(() => {
      if (!busy && !loading) {
        void refresh();
      }
    }, 10_000);
    return () => {
      mounted = false;
      generation++;
      controller?.abort();
      clearInterval(timer);
      clearTimeout(searchTimer);
    };
  });
  async function action(fn: () => Promise<unknown>) {
    if (busy) {
      return;
    }
    busy = true;
    notice = '';
    error = '';
    try {
      await fn();
      await refresh();
    } catch (error_) {
      error = String(error_);
    } finally {
      busy = false;
    }
  }
  async function setting(key: string, value: boolean | number) {
    await organizer('/settings', { [key]: value }, 'PUT');
  }
  async function importManifest(file: File) {
    if (file.size > 20_000_000) {
      throw new Error('Source manifest must be at most 20 MB. Split larger manifests before uploading.');
    }
    const manifest: unknown = JSON.parse(await file.text());
    if (!manifest || typeof manifest !== 'object' || !('entries' in manifest) || !Array.isArray(manifest.entries)) {
      throw new Error('Expected a source manifest with entries');
    }
    for (let i = 0; i < manifest.entries.length; i += 1000) {
      try {
        await organizer('/manifest', { entries: manifest.entries.slice(i, i + 1000) });
      } catch (error_) {
        throw new Error(`Import stopped after ${i} records. Retrying the file is safe. ${String(error_)}`, {
          cause: error_,
        });
      }
    }
    notice = `Imported ${manifest.entries.length} source records; only matching library assets are updated.`;
  }
  async function run(limit: number) {
    await organizer(
      '/settings',
      { enabled: true, continuous: limit > 200, ...(limit === 200 && { automatic: false }) },
      'PUT',
    );
    const r = await organizer<QueuedRun>('/runs', { limit });
    notice = `Analysis run queued for up to ${r.requested} assets. ${limit === 200 ? 'Pilot mode: metadata changes are disabled.' : 'Analysis follows the current settings.'}`;
  }
  async function runScope(scope: { assetIds: string[] } | { albumId: string }) {
    const r = await organizer<QueuedRun>('/runs', {
      ...scope,
      limit: 'assetIds' in scope ? scope.assetIds.length : 100_000,
      reanalyze: true,
    });
    notice = `Run ${r.runId} queued for up to ${r.requested} assets. ${status?.settings.enabled ? 'Follow discovery progress below.' : 'Analysis is paused; resume to process this run.'}`;
  }
</script>

<UserPageLayout title="Organize">
  <div class="mx-auto max-w-7xl p-4 md:p-8">
    <div class="mb-6 flex flex-wrap items-start justify-between gap-4">
      <div>
        <h2 class="text-2xl font-semibold">Your archive, understood</h2>
        <p class="mt-1 opacity-70">Find events, recover context, and follow every automatic change.</p>
      </div>
      <button
        type="button"
        class="rounded-lg bg-immich-primary px-4 py-2 text-white"
        onclick={() => action(refresh)}
        disabled={busy}>Refresh</button
      >
    </div>
    {#if error}<p role="alert" class="my-4 rounded-lg bg-red-500/10 p-4">{error}</p>{/if}
    {#if notice}<p role="status" class="my-4 rounded-lg bg-immich-primary/10 p-4">{notice}</p>{/if}
    {#if loading && !status}<p role="status">Loading Organize…</p>{/if}
    {#if status && !status.connected}
      <div class="rounded-xl border border-immich-primary/20 p-6">
        <h3 class="text-xl">Connect your library</h3>
        <p class="my-3">
          Analysis sends previews to the configured vision provider. Your existing Immich login controls access. Start
          with a pilot before enabling automatic changes.
        </p>
        <button
          type="button"
          class="rounded-lg bg-immich-primary px-4 py-2 text-white"
          onclick={() => action(() => organizer('/connect', {}))}
          disabled={busy}>Connect Organize</button
        >
      </div>
    {:else if status?.connected}
      <div class="mb-4 flex flex-wrap items-center gap-4">
        <p>
          {status.settings.enabled ? 'Analysis is running' : 'Analysis is paused'}. Active requests may finish after
          pausing.
        </p>
        <button
          type="button"
          class="rounded-lg border border-immich-primary/30 p-2"
          disabled={busy}
          onclick={() => action(() => setting('enabled', !status?.settings.enabled))}
          >{status.settings.enabled ? 'Pause analysis' : 'Resume analysis'}</button
        >
      </div>
      <div class="mb-6 grid grid-cols-2 gap-3 md:grid-cols-5">
        {#each status.counts as count (count.status)}
          <div class="rounded-xl bg-immich-primary/5 p-4">
            <p class="text-2xl font-semibold">{count.count}</p>
            <p class="text-sm capitalize">{count.status}</p>
          </div>
        {/each}
      </div>
      <details class="mb-6 rounded-lg border border-immich-primary/20 p-4" open>
        <summary>Recent runs and discovery progress</summary>
        <p class="my-2 text-sm opacity-70">
          Discovery queues assets. Analysis totals above show their processing state; a complete discovery run does not
          mean every asset is analyzed.
        </p>
        {#each status.runs || [] as run (run.id)}
          <article class="my-3 text-sm">
            <p>{new Date(run.created_at).toLocaleString()} · {run.status} · {run.count} assets queued</p>
            <p class="break-all opacity-60">{run.id}</p>
            {#if run.error}<p role="alert">{run.error}</p>{/if}
          </article>
        {:else}<p class="mt-2 text-sm">No runs yet. Start with the read-only pilot.</p>{/each}
      </details>
      <nav class="mb-6 flex gap-5 border-b border-immich-primary/20 pb-3" aria-label="Organizer sections">
        {#each ['Photos', 'Keeper', 'Events', 'History', 'Settings'] as name (name)}<button
            type="button"
            class:text-immich-primary={tab === name}
            aria-current={tab === name ? 'page' : undefined}
            onclick={() => (tab = name)}>{name}</button
          >{/each}
      </nav>
      {#if tab === 'Photos'}
        <div class="mb-5 flex flex-wrap gap-3">
          <input
            class="min-w-60 flex-1 rounded-lg border border-immich-primary/20 bg-transparent p-2"
            aria-label="Search detected content"
            bind:value={query}
            placeholder="Search captions, objects, text, places…"
            maxlength="200"
            oninput={search}
          />
          <button
            type="button"
            class="rounded-lg border border-immich-primary/30 p-2"
            onclick={() => action(() => run(200))}
            disabled={busy}>Analyze pilot · 200</button
          >
          <button
            type="button"
            class="rounded-lg border border-immich-primary/30 p-2"
            onclick={() => action(() => run(100_000))}
            disabled={busy}>Analyze library</button
          >
        </div>
        <div class="mb-4 flex flex-wrap gap-3">
          <select
            aria-label="Analysis status"
            class="rounded-sm border bg-transparent p-2"
            bind:value={filter}
            onchange={search}
            ><option value="">All statuses</option
            >{#each ['pending', 'running', 'retry', 'analyzed', 'failed'] as value (value)}<option {value}
                >{value}</option
              >{/each}</select
          >
          <select
            aria-label="Media category"
            class="rounded-sm border bg-transparent p-2"
            bind:value={category}
            onchange={search}
            ><option value="">All categories</option
            >{#each ['photo', 'screenshot', 'document', 'scan', 'illustration', 'meme', 'video', 'unknown'] as value (value)}<option
                {value}>{value}</option
              >{/each}</select
          >
          <select
            aria-label="Estimated date precision"
            class="rounded-sm border bg-transparent p-2"
            bind:value={datePrecision}
            onchange={search}
            ><option value="">All date estimates</option
            >{#each ['day', 'month', 'year', 'range'] as value (value)}<option {value}>{value}</option>{/each}</select
          >
          <select
            aria-label="Estimated location precision"
            class="rounded-sm border bg-transparent p-2"
            bind:value={locationPrecision}
            onchange={search}
            ><option value="">All location estimates</option
            >{#each ['country', 'region', 'city', 'venue', 'camera'] as value (value)}<option {value}>{value}</option
              >{/each}</select
          >
          <select
            class="min-w-60 rounded-sm border bg-transparent p-2"
            aria-label="Album to analyze"
            bind:value={albumId}
          >
            <option value="">Choose an album</option>{#each albums as album (album.id)}<option value={album.id}
                >{album.albumName}</option
              >{/each}
          </select>
          <button
            type="button"
            class="text-immich-primary"
            disabled={!albumId || busy}
            onclick={() => action(() => runScope({ albumId }))}>Analyze album</button
          >
          <button
            type="button"
            class="text-immich-primary"
            disabled={checked.length === 0 || busy}
            onclick={() => action(() => runScope({ assetIds: [...checked] }))}
            >Analyze selected ({checked.length})</button
          >
          {#if checked.length}<button type="button" onclick={() => (checked = [])}>Clear selection</button>{/if}
        </div>
        <div class="grid gap-5 lg:grid-cols-[1fr_360px]">
          <div>
            <div class="grid grid-cols-2 gap-3 md:grid-cols-4">
              {#each assets as asset (asset.id)}
                <article class="min-w-0">
                  <label class="mb-1 flex items-center gap-2 text-sm"
                    ><input
                      type="checkbox"
                      checked={checked.includes(asset.id)}
                      onchange={(e) => {
                        checked = e.currentTarget.checked
                          ? [...checked, asset.id]
                          : checked.filter((id) => id !== asset.id);
                      }}
                    />Select {asset.filename}</label
                  >
                  <button
                    type="button"
                    class="w-full overflow-hidden rounded-xl border border-immich-primary/20 text-left"
                    aria-pressed={selected === asset.id}
                    onclick={() => (selected = asset.id)}
                  >
                    <img
                      class="aspect-square w-full object-cover"
                      src={`/api/assets/${asset.id}/thumbnail?size=thumbnail`}
                      alt={asset.filename || 'Library asset'}
                      loading="lazy"
                    />
                    <div class="p-3">
                      <p class="truncate text-sm">{asset.filename}</p>
                      <p class="text-xs opacity-70">{asset.status}</p>
                      {#if asset.result?.location}<p class="text-xs">Approximate: {asset.result.location.name}</p>{/if}
                      {#if asset.result?.date}<p class="text-xs">
                          Estimated {asset.result.date.kind}: {asset.result.date.start} – {asset.result.date.end}
                        </p>{/if}
                    </div>
                  </button>
                </article>
              {/each}
            </div>
            {#if assets.length === 0}<p class="p-8 text-center opacity-60">
                No matching assets. Start an analysis run or change the search.
              </p>{/if}
            <div class="my-4 flex gap-4">
              <button
                type="button"
                disabled={offset === 0 || loading}
                onclick={() => {
                  offset = Math.max(0, offset - 50);
                  void refresh();
                }}>Previous</button
              ><button
                type="button"
                disabled={assets.length < 50 || loading}
                onclick={() => {
                  offset += 50;
                  void refresh();
                }}>Next</button
              >
            </div>
          </div>
          <aside>
            {#if selected}<AnalysisPanel assetId={selected} /><a
                class="mx-4 text-immich-primary"
                href={`/photos?at=${selected}`}>Open photo</a
              >{:else}<p class="p-4 opacity-60">Select a photo to see its evidence.</p>{/if}
          </aside>
        </div>
      {:else if tab === 'Keeper'}
        <KeeperPanel />
      {:else if tab === 'Events'}
        <div class="grid gap-4 md:grid-cols-3">
          {#each events as event (event.id)}
            <a href={`/albums/${event.album}`} class="rounded-xl border border-immich-primary/20 p-5"
              ><h3 class="font-medium">{event.title}</h3>
              <p class="mt-2 text-sm">
                Estimated {event.data.date?.kind} range: {event.data.date?.start} – {event.data.date?.end}
              </p>
              <p class="text-sm">
                {event.data.location ? `Approximate: ${event.data.location.name}` : 'No place estimate'}
              </p></a
            >
          {:else}<p>No events have been identified yet.</p>{/each}
        </div>
      {:else if tab === 'History'}
        <div class="space-y-4">
          {#each history as change (change.id)}
            <article class="rounded-xl border border-immich-primary/20 p-4">
              <div class="flex justify-between gap-3">
                <a class="text-immich-primary" href={`/photos?at=${change.asset}`}>Open photo</a><span
                  >{change.status}</span
                >
              </div>
              <p class="text-sm opacity-70">{new Date(change.created_at).toLocaleString()}</p>
              <pre class="my-3 overflow-auto text-xs">{JSON.stringify(
                  { before: change.before_value, after: change.after_value },
                  null,
                  2,
                )}</pre>
              <p class="text-sm">{change.kind}</p>
              {#if change.status === 'undoing'}<p role="status">
                  Undo was interrupted. Resume to reconcile changes and preserve newer edits.
                </p>{/if}
              {#if change.status === 'applied' || change.status === 'undoing'}<button
                  type="button"
                  class="text-immich-primary"
                  onclick={() => action(() => organizer(`/undo/${change.id}`, {}))}
                  disabled={busy}
                  >{change.status === 'undoing' ? 'Resume undo' : 'Undo and suppress reapplication'}</button
                >{/if}
            </article>
          {:else}<p>No changes recorded on this page.</p>{/each}
          <div class="flex gap-4">
            <button
              type="button"
              disabled={historyOffset === 0 || loading}
              onclick={() => {
                historyOffset = Math.max(0, historyOffset - 200);
                void refresh();
              }}>Previous changes</button
            ><button
              type="button"
              disabled={history.length < 200 || loading}
              onclick={() => {
                historyOffset += 200;
                void refresh();
              }}>Next changes</button
            >
          </div>
        </div>
      {:else}
        <div class="max-w-2xl space-y-5">
          <p>
            Model: <strong>{status.provider.model}</strong> · {status.provider.configured
              ? 'Configured'
              : 'Provider key missing on worker'}
          </p>
          {#each [['enabled', 'Run analysis'], ['continuous', 'Discover new assets automatically'], ['automatic', 'Apply supported changes automatically'], ['geolocation', 'Infer location from photo content'], ['approximatePins', 'Write approximate map pins'], ['webLookup', 'Corroborate public places with web lookup']] as [key, label] (key)}
            <label class="flex items-center justify-between gap-4 rounded-lg border border-immich-primary/20 p-3"
              >{label}<input
                type="checkbox"
                disabled={busy}
                checked={status.settings[key] === true}
                onchange={(e) => {
                  const value = e.currentTarget.checked;
                  void action(() => setting(key, value));
                }}
              /></label
            >
          {/each}
          <label class="flex items-center justify-between gap-4"
            >Daily model request limit<input
              class="w-32 rounded-sm border bg-transparent p-2"
              type="number"
              min="1"
              max="100000"
              disabled={busy}
              value={Number(status.settings.dailyLimit)}
              onchange={(e) => {
                const value = Number(e.currentTarget.value);
                void action(() => setting('dailyLimit', value));
              }}
            /></label
          >
          <p class="text-sm opacity-70">
            Estimated map pins may appear without their uncertainty label in official mobile apps. Month/year estimates
            stay in Organize and do not invent an exact capture date.
          </p>
          <p class="text-sm">
            The pilot disables automatic changes and new-asset discovery. Analyze library enables discovery. Selected
            and album runs follow current settings. Resume starts waiting work.
          </p>
          <h3 class="font-medium">Source context</h3>
          <label class="block"
            >Import a private source manifest<input
              disabled={busy}
              class="mt-2 block"
              type="file"
              accept="application/json,.json"
              onchange={(e) => {
                const file = e.currentTarget.files?.[0];
                e.currentTarget.value = '';
                if (file) {
                  void action(() => importManifest(file));
                }
              }}
            /></label
          >
          <p class="text-sm opacity-70">
            JSON with an entries array of checksum and paths records. Paths retain their original language. Imports may
            trigger reanalysis of matching assets.
          </p>
          <h3 class="font-medium">Recent model usage</h3>
          {#each status.usage as day (day.day)}<p>{day.day}: {day.calls} requests</p>{/each}
        </div>
      {/if}
    {/if}
  </div>
</UserPageLayout>
