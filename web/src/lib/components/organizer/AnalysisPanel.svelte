<script lang="ts">
  import { organizer, safeSourceUrl, type AssetAnalysis, type LockField } from './api';
  let { assetId }: { assetId: string } = $props();
  let analysis = $state<AssetAnalysis | null>(null);
  let location = $derived(analysis?.proposal?.estimatedLocation || analysis?.result?.location);
  let loading = $state(true);
  let refreshVersion = $state(0);
  let notice = $state('');
  let suspectDate = $state(false);
  let suspectLocation = $state(false);
  let error = $state('');
  let busy = $state(false);
  let captureDay = $state('');
  let note = $state('');
  $effect(() => {
    void refreshVersion;
    const id = assetId;
    let current = true;
    analysis = null;
    error = '';
    notice = '';
    busy = false;
    loading = true;
    captureDay = '';
    note = '';
    const controller = new AbortController();
    organizer<AssetAnalysis | null>(`/assets/${id}`, undefined, 'GET', controller.signal)
      .then((r) => {
        if (!current) {
          return;
        }

        analysis = r;
        captureDay = r?.facts?.captureDay || '';
        note = r?.facts?.note || '';
        suspectDate = r?.facts?.suspectDate || false;
        suspectLocation = r?.facts?.suspectLocation || false;
      })
      .catch((error_: unknown) => {
        if (current) {
          error = String(error_);
        }
      })
      .finally(() => {
        if (current) {
          loading = false;
        }
      });
    return () => {
      current = false;
      controller.abort();
    };
  });
  async function analyze() {
    if (busy) {
      return;
    }
    const id = assetId;
    busy = true;
    error = '';
    try {
      await organizer('/runs', { assetIds: [id], limit: 1, reanalyze: true });
      if (assetId === id) {
        notice = 'Analysis queued. Paused runs wait until you resume Organize.';
      }
    } catch (error_) {
      if (assetId === id) {
        error = String(error_);
      }
    } finally {
      if (assetId === id) {
        busy = false;
      }
    }
  }
  async function update(body: unknown) {
    if (busy) {
      return;
    }
    const id = assetId;
    busy = true;
    error = '';
    notice = '';
    try {
      const result = await organizer<AssetAnalysis>(`/assets/${id}`, body, 'PUT');
      if (assetId === id) {
        analysis = result;
        notice = 'Saved. Analysis will use your corrections when processing resumes.';
      }
    } catch (error_) {
      if (assetId === id) {
        error = String(error_);
      }
    } finally {
      if (assetId === id) {
        busy = false;
      }
    }
  }
  async function lock(field: LockField) {
    await update({ locks: { [field]: (analysis?.locks || {})[field] !== true } });
  }
  async function saveFacts() {
    await update({ facts: { captureDay: captureDay || null, note, suspectDate, suspectLocation } });
  }
</script>

<section class="m-4 rounded-xl border border-immich-primary/20 p-4" aria-label="AI details">
  <div class="flex items-center justify-between">
    <h3 class="text-lg font-medium">AI details</h3>
    <button
      type="button"
      class="text-immich-primary"
      onclick={analyze}
      disabled={busy || loading || (!!error && !analysis)}>{busy ? 'Working…' : 'Analyze again'}</button
    >
  </div>
  {#if error}<p role="alert" class="my-2 text-red-500">{error}</p>{/if}
  {#if notice}<p role="status" class="my-2 text-sm">{notice}</p>{/if}
  {#if analysis?.result}
    <p class="my-3">{analysis.result.caption}</p>
    {#if analysis.result.date}<p>
        Estimated {analysis.result.date.kind} date range: {analysis.result.date.start} – {analysis.result.date.end} ({analysis
          .result.date.precision}; {analysis.result.date.confidence} confidence). This is not an exact capture timestamp.
      </p>{/if}
    {#if location}<p>
        Approximate place: {location.name} ({location.precision}; {location.kind}; {location.confidence} confidence)
      </p>{/if}
    <div class="my-2 flex flex-wrap gap-2">
      {#each analysis.result.tags as tag, index (index)}<span
          class="rounded-full bg-immich-primary/10 px-2 py-1 text-sm">{tag}</span
        >{/each}
    </div>
    <details>
      <summary class="cursor-pointer">Evidence and sources</summary>
      <ul class="my-2 space-y-2">
        {#each analysis.result.evidence as evidence, index (index)}<li>{evidence.kind}: {evidence.text}</li>{/each}
      </ul>
      {#each analysis.result.webSources || [] as source, index (index)}{#if safeSourceUrl(source.url)}<a
            class="block text-immich-primary"
            href={safeSourceUrl(source.url)}
            rel="noreferrer"
            target="_blank">{source.title}</a
          >{:else}<p>{source.title} (source URL unavailable)</p>{/if}{/each}
      <p class="my-2 text-sm">{analysis.result.model} · prompt {analysis.result.promptVersion}</p>
    </details>
    {#if analysis.result.ocr?.length}<details>
        <summary>Detected text (OCR)</summary>
        <p class="wrap-break-word whitespace-pre-wrap">{analysis.result.ocr.join('\n')}</p>
      </details>{/if}
    <p class="my-2 text-sm">Objects: {analysis.result.objects?.join(', ') || 'None recorded'}</p>
    <p class="my-2 text-sm">Activities: {analysis.result.activities?.join(', ') || 'None recorded'}</p>
  {:else}<p class="my-2 text-sm">{loading ? 'Loading analysis…' : analysis?.status || 'Not analyzed'}</p>{/if}
  {#if analysis?.error}<p role="status">{analysis.error}</p>{/if}
  <button
    type="button"
    class="my-2 text-sm text-immich-primary"
    disabled={busy || loading}
    onclick={() => refreshVersion++}>Refresh analysis</button
  >
  {#if analysis?.provenance}<details class="my-2">
      <summary>Original source records</summary>
      <pre class="max-h-64 overflow-auto text-xs wrap-break-word whitespace-pre-wrap">{JSON.stringify(
          analysis.provenance,
          null,
          2,
        )}</pre>
    </details>{/if}
  <div class="mt-3 flex flex-wrap gap-3">
    {#each ['date', 'location', 'description', 'suppressed'] as field (field)}
      <button
        type="button"
        class="text-sm text-immich-primary"
        disabled={busy || loading || !analysis}
        aria-pressed={(analysis?.locks || {})[field as LockField] === true}
        onclick={() => lock(field as LockField)}
        >{(analysis?.locks || {})[field as LockField] === true ? 'Unlock' : 'Lock'}
        {field === 'suppressed' ? 'all automatic changes' : field}</button
      >
    {/each}
  </div>
  <a class="mt-3 block text-sm text-immich-primary" href="/organize">Open Organize</a>
  <details class="mt-3">
    <summary class="cursor-pointer">Add a date or context you know</summary>
    <label class="mt-3 block text-sm"
      >Known capture day<input
        class="mt-1 block w-full rounded-sm border bg-transparent p-2"
        type="date"
        bind:value={captureDay}
      /></label
    >
    <label class="mt-3 block text-sm"
      >Context<textarea
        maxlength="3000"
        class="mt-1 block w-full rounded-sm border bg-transparent p-2"
        bind:value={note}
        placeholder="For example: this was our August trip, before we moved."></textarea></label
    >
    <label class="mt-3 block text-sm"
      ><input type="checkbox" bind:checked={suspectDate} /> Existing date may be incorrect</label
    >
    <label class="mt-3 block text-sm"
      ><input type="checkbox" bind:checked={suspectLocation} /> Existing location may be incorrect</label
    >
    <button type="button" class="mt-2 text-immich-primary" disabled={busy || loading || !analysis} onclick={saveFacts}
      >Save evidence and reanalyze</button
    >
  </details>
</section>
