<script lang="ts">
  import { onMount } from 'svelte';
  import UserPageLayout from '$lib/components/layouts/UserPageLayout.svelte';
  import AnalysisPanel from '$lib/components/organizer/AnalysisPanel.svelte';
  import { organizer } from '$lib/components/organizer/api';
  let status = $state<any>(null),
    assets = $state<any[]>([]),
    events = $state<any[]>([]),
    history = $state<any[]>([]);
  let error = $state(''),
    notice = $state(''),
    query = $state(''),
    selected = $state(''),
    tab = $state('Photos'),
    offset = $state(0),
    busy = $state(false);
  async function refresh() {
    try {
      status = await organizer('/status');
      if (status.connected) {
        [assets, events, history] = await Promise.all([
          organizer(`/assets?q=${encodeURIComponent(query)}&offset=${offset}`),
          organizer('/events'),
          organizer('/history'),
        ]);
      }
      error = '';
    } catch (e) {
      error = String(e);
    }
  }
  onMount(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 10000);
    return () => clearInterval(timer);
  });
  async function action(fn: () => Promise<unknown>) {
    busy = true;
    notice = '';
    try {
      await fn();
      await refresh();
    } catch (e) {
      error = String(e);
    } finally {
      busy = false;
    }
  }
  async function setting(key: string, value: boolean | number) {
    await organizer('/settings', { [key]: value }, 'PUT');
  }
  async function run(limit: number) {
    await organizer(
      '/settings',
      { enabled: true, continuous: limit > 200, ...(limit === 200 ? { automatic: false } : {}) },
      'PUT',
    );
    const r = await organizer('/runs', { limit });
    notice = `${r.queued} assets inventoried. ${limit === 200 ? 'Pilot mode: metadata changes are disabled.' : 'Analysis follows the current settings.'}`;
  }
</script>

<UserPageLayout title="Organize">
  <div class="mx-auto max-w-7xl p-4 md:p-8">
    <div class="mb-6 flex flex-wrap items-start justify-between gap-4">
      <div>
        <h2 class="text-2xl font-semibold">Your archive, understood</h2>
        <p class="mt-1 opacity-70">Find events, recover context, and follow every automatic change.</p>
      </div>
      <button class="rounded-lg bg-immich-primary px-4 py-2 text-white" onclick={() => action(refresh)} disabled={busy}
        >Refresh</button
      >
    </div>
    {#if error}<p role="alert" class="my-4 rounded-lg bg-red-500/10 p-4">{error}</p>{/if}
    {#if notice}<p role="status" class="my-4 rounded-lg bg-immich-primary/10 p-4">{notice}</p>{/if}
    {#if status && !status.connected}
      <div class="rounded-xl border border-immich-primary/20 p-6">
        <h3 class="text-xl">Connect your library</h3>
        <p class="my-3">
          Analysis sends previews to the configured vision provider. Your existing Immich login controls access. Start
          with a pilot before enabling automatic changes.
        </p>
        <button
          class="rounded-lg bg-immich-primary px-4 py-2 text-white"
          onclick={() => action(() => organizer('/connect', {}))}
          disabled={busy}>Connect Organize</button
        >
      </div>
    {:else if status?.connected}
      <div class="mb-6 grid grid-cols-2 gap-3 md:grid-cols-5">
        {#each status.counts as count}
          <div class="rounded-xl bg-immich-primary/5 p-4">
            <p class="text-2xl font-semibold">{count.count}</p>
            <p class="text-sm capitalize">{count.status}</p>
          </div>
        {/each}
      </div>
      <nav class="mb-6 flex gap-5 border-b border-immich-primary/20 pb-3" aria-label="Organizer sections">
        {#each ['Photos', 'Events', 'History', 'Settings'] as name}<button
            class:text-immich-primary={tab === name}
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
            oninput={() => {
              offset = 0;
              void refresh();
            }}
          />
          <button
            class="rounded-lg border border-immich-primary/30 p-2"
            onclick={() => action(() => run(200))}
            disabled={busy}>Analyze pilot · 200</button
          >
          <button
            class="rounded-lg border border-immich-primary/30 p-2"
            onclick={() => action(() => run(100000))}
            disabled={busy}>Analyze library</button
          >
        </div>
        <div class="grid gap-5 lg:grid-cols-[1fr_360px]">
          <div>
            <div class="grid grid-cols-2 gap-3 md:grid-cols-4">
              {#each assets as asset (asset.id)}
                <button
                  class="overflow-hidden rounded-xl border border-immich-primary/20 text-left"
                  onclick={() => (selected = asset.id)}
                >
                  <img
                    class="aspect-square w-full object-cover"
                    src={`/api/assets/${asset.id}/thumbnail?size=thumbnail`}
                    alt={asset.filename}
                    loading="lazy"
                  />
                  <div class="p-3">
                    <p class="truncate text-sm">{asset.filename}</p>
                    <p class="text-xs opacity-70">{asset.status}</p>
                    {#if asset.result?.location}<p class="text-xs">≈ {asset.result.location.name}</p>{/if}
                  </div>
                </button>
              {/each}
            </div>
            {#if assets.length === 0}<p class="p-8 text-center opacity-60">
                No matching assets. Start an analysis run or change the search.
              </p>{/if}
            <div class="my-4 flex gap-4">
              <button
                disabled={offset === 0}
                onclick={() => {
                  offset = Math.max(0, offset - 50);
                  void refresh();
                }}>Previous</button
              ><button
                disabled={assets.length < 50}
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
      {:else if tab === 'Events'}
        <div class="grid gap-4 md:grid-cols-3">
          {#each events as event}
            <a href={`/albums/${event.album}`} class="rounded-xl border border-immich-primary/20 p-5"
              ><h3 class="font-medium">{event.title}</h3>
              <p class="mt-2 text-sm">{event.data.date?.start} – {event.data.date?.end}</p>
              <p class="text-sm">{event.data.location?.name || ''}</p></a
            >
          {/each}
        </div>
      {:else if tab === 'History'}
        <div class="space-y-4">
          {#each history as change}
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
              {#if change.status === 'applied'}<button
                  class="text-immich-primary"
                  onclick={() => action(() => organizer(`/undo/${change.id}`, {}))}
                  disabled={busy}>Undo and suppress reapplication</button
                >{/if}
            </article>
          {/each}
        </div>
      {:else}
        <div class="max-w-2xl space-y-5">
          <p>
            Model: <strong>{status.provider.model}</strong> · {status.provider.configured
              ? 'Configured'
              : 'Provider key missing on worker'}
          </p>
          {#each [['enabled', 'Run analysis'], ['continuous', 'Discover new assets automatically'], ['automatic', 'Apply supported changes automatically'], ['geolocation', 'Infer location from photo content'], ['approximatePins', 'Write approximate map pins'], ['webLookup', 'Corroborate public places with web lookup']] as [key, label]}
            <label class="flex items-center justify-between gap-4 rounded-lg border border-immich-primary/20 p-3"
              >{label}<input
                type="checkbox"
                checked={status.settings[key]}
                onchange={(e) => action(() => setting(key, e.currentTarget.checked))}
              /></label
            >
          {/each}
          <label class="flex items-center justify-between gap-4"
            >Daily model request limit<input
              class="w-32 rounded border bg-transparent p-2"
              type="number"
              min="1"
              max="100000"
              value={status.settings.dailyLimit}
              onchange={(e) => action(() => setting('dailyLimit', Number(e.currentTarget.value)))}
            /></label
          >
          <p class="text-sm opacity-70">
            Estimated map pins may appear without their uncertainty label in official mobile apps. Month/year estimates
            stay in Organize and do not invent an exact capture date.
          </p>
          <h3 class="font-medium">Recent model usage</h3>
          {#each status.usage as day}<p>{day.day}: {day.calls} requests</p>{/each}
        </div>
      {/if}
    {/if}
  </div>
</UserPageLayout>
