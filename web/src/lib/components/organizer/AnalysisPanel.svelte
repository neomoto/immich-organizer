<script lang="ts">
  import { organizer } from './api';
  let { assetId }: { assetId: string } = $props();
  let analysis = $state<any>(null);
  let error = $state('');
  let busy = $state(false);
  $effect(() => {
    const id = assetId;
    let current = true;
    analysis = null;
    error = '';
    organizer(`/assets/${id}`)
      .then((r) => {
        if (current) analysis = r;
      })
      .catch(() => {});
    return () => {
      current = false;
    };
  });
  async function analyze() {
    busy = true;
    error = '';
    try {
      await organizer('/runs', { assetIds: [assetId], limit: 1, reanalyze: true });
      analysis = { ...analysis, status: 'pending' };
    } catch (e) {
      error = String(e);
    } finally {
      busy = false;
    }
  }
  async function lock(field: string) {
    try {
      analysis = await organizer(`/assets/${assetId}`, { locks: { [field]: !analysis?.locks?.[field] } }, 'PUT');
    } catch (e) {
      error = String(e);
    }
  }
</script>

<section class="m-4 rounded-xl border border-immich-primary/20 p-4" aria-label="AI details">
  <div class="flex items-center justify-between">
    <h3 class="text-lg font-medium">AI details</h3>
    <button class="text-immich-primary" onclick={analyze} disabled={busy}>{busy ? 'Queuing…' : 'Analyze again'}</button>
  </div>
  {#if error}<p role="alert" class="my-2 text-red-500">{error}</p>{/if}
  {#if analysis?.result}
    <p class="my-3">{analysis.result.caption}</p>
    {#if analysis.result.date}<p>
        Estimated date: {analysis.result.date.start} – {analysis.result.date.end} ({analysis.result.date.precision})
      </p>{/if}
    {#if analysis.result.location}<p>
        Estimated place: {analysis.result.location.name} ({analysis.result.location.precision}; {analysis.result
          .location.kind})
      </p>{/if}
    <div class="my-2 flex flex-wrap gap-2">
      {#each analysis.result.tags as tag}<span class="rounded-full bg-immich-primary/10 px-2 py-1 text-sm">{tag}</span
        >{/each}
    </div>
    <details>
      <summary class="cursor-pointer">Evidence and sources</summary>
      <ul class="my-2 space-y-2">
        {#each analysis.result.evidence as evidence}<li>{evidence.kind}: {evidence.text}</li>{/each}
      </ul>
      {#each analysis.result.webSources || [] as source}<a
          class="block text-immich-primary"
          href={source.url}
          rel="noreferrer"
          target="_blank">{source.title}</a
        >{/each}
      <p class="my-2 text-sm">{analysis.result.model} · prompt {analysis.result.promptVersion}</p>
    </details>
  {:else}<p class="my-2 text-sm">{analysis?.status || 'Not analyzed'}</p>{/if}
  {#if analysis?.error}<p role="status">{analysis.error}</p>{/if}
  <div class="mt-3 flex flex-wrap gap-3">
    {#each ['date', 'location', 'description'] as field}
      <button class="text-sm text-immich-primary" onclick={() => lock(field)}
        >{analysis?.locks?.[field] ? 'Unlock' : 'Lock'} {field}</button
      >
    {/each}
  </div>
  <a class="mt-3 block text-sm text-immich-primary" href="/organize">Open Organize</a>
</section>
