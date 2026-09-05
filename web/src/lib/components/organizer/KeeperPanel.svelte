<script lang="ts">
  import { onMount } from 'svelte';
  import { SvelteMap } from 'svelte/reactivity';
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
    type KeeperEvent,
    type KeeperMessage,
    type KeeperRun,
    type KeeperSchedule,
    type KeeperSession,
  } from './api';

  let sessions = $state<KeeperSession[]>([]);
  let selectedSessionId = $state('');
  let messages = $state<KeeperMessage[]>([]);
  let events = $state<KeeperEvent[]>([]);
  let runs = $state<KeeperRun[]>([]);
  let schedule = $state<KeeperSchedule | null>(null);
  let draft = $state('');
  let newSessionTitle = $state('');
  let busy = $state(false);
  let loading = $state(true);
  let error = $state('');
  let notice = $state('');
  let messageCursor = $state('');
  let eventCursor = $state('');
  let generation = 0;
  let mounted = false;
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  let controller: AbortController | undefined;

  let currentRun = $derived(runs[0]);
  let scheduleReport = $derived(
    messages
      .findLast((message) => message.role === 'assistant' && runs.some((run) => run.source === 'schedule' && run.id === message.run))?.content,
  );

  function resetStream() {
    messageCursor = '';
    eventCursor = '';
    messages = [];
    events = [];
    runs = [];
  }

  function addMessages(next: KeeperMessage[]) {
    if (next.length === 0) {return;}
    const byId = new SvelteMap(messages.map((message) => [message.id, message]));
    for (const message of next) {byId.set(message.id, message);}
    messages = [...byId.values()].sort((a, b) => Number(a.seq) - Number(b.seq));
    messageCursor = String(Math.max(...next.map((message) => Number(message.seq))));
  }

  function addEvents(next: KeeperEvent[]) {
    if (next.length === 0) {return;}
    const bySeq = new SvelteMap(events.map((event) => [String(event.seq), event]));
    for (const event of next) {bySeq.set(String(event.seq), event);}
    events = [...bySeq.values()].sort((a, b) => Number(a.seq) - Number(b.seq));
    eventCursor = String(Math.max(...next.map((event) => Number(event.seq))));
  }

  async function refreshRun(runId: string, request = generation) {
    const signal = controller?.signal;
    try {
      const [nextRun, nextEvents, nextMessages] = await Promise.all([
        keeperRun(runId, signal),
        keeperEvents(runId, eventCursor || undefined, 100, signal),
        selectedSessionId ? keeperMessages(selectedSessionId, messageCursor || undefined, 100, signal) : Promise.resolve({ messages: [], nextCursor: null }),
      ]);
      if (request !== generation || !mounted) {return;}
      runs = [nextRun, ...runs.filter((run) => run.id !== nextRun.id)];
      addEvents(nextEvents.events);
      addMessages(nextMessages.messages);
    } catch (error_) {
      if (request === generation && mounted && !signal?.aborted) {error = String(error_);}
    }
  }

  function startPolling(runId: string) {
    if (pollTimer) {clearInterval(pollTimer);}
    pollTimer = setInterval(() => void refreshRun(runId), 2000);
  }

  async function selectSession(sessionId: string) {
    const request = ++generation;
    controller?.abort();
    if (pollTimer) {clearInterval(pollTimer); pollTimer = undefined;}
    controller = new AbortController();
    resetStream();
    selectedSessionId = sessionId;
    loading = true;
    error = '';
    try {
      const [nextMessages, nextRuns] = await Promise.all([
        keeperMessages(sessionId, undefined, 100, controller.signal),
        keeperSessionRuns(sessionId, undefined, 50, controller.signal),
      ]);
      if (request !== generation || !mounted) {return;}
      addMessages(nextMessages.messages);
      runs = nextRuns.runs;
      const run = runs[0];
      if (run) {
        const nextEvents = await keeperEvents(run.id, undefined, 100, controller.signal);
        if (request !== generation || !mounted) {return;}
        addEvents(nextEvents.events);
        startPolling(run.id);
      }
    } catch (error_) {
      if (request === generation && mounted && !controller.signal.aborted) {error = String(error_);}
    } finally {
      if (request === generation && mounted) {loading = false;}
    }
  }

  async function load() {
    const request = ++generation;
    controller?.abort();
    controller = new AbortController();
    loading = true;
    error = '';
    try {
      const [nextSessions, nextSchedule] = await Promise.all([
        keeperSessions(undefined, 50, controller.signal),
        keeperSchedule(controller.signal),
      ]);
      if (request !== generation || !mounted) {return;}
      sessions = nextSessions.sessions;
      schedule = nextSchedule;
      const selected = selectedSessionId && sessions.some((session) => session.id === selectedSessionId)
        ? selectedSessionId
        : sessions[0]?.id || '';
      if (selected) {await selectSession(selected);}
      else {resetStream();}
    } catch (error_) {
      if (request === generation && mounted && !controller.signal.aborted) {error = String(error_);}
    } finally {
      if (request === generation && mounted) {loading = false;}
    }
  }

  async function createSession() {
    if (busy) {return;}
    busy = true;
    error = '';
    try {
      const session = await keeperCreateSession(newSessionTitle.trim() || undefined, controller?.signal);
      sessions = [session, ...sessions];
      newSessionTitle = '';
      await selectSession(session.id);
    } catch (error_) {
      error = String(error_);
    } finally {
      busy = false;
    }
  }

  async function submit() {
    const content = draft.trim();
    if (!content || busy) {return;}
    busy = true;
    error = '';
    notice = '';
    try {
      if (!selectedSessionId) {
        const session = await keeperCreateSession(undefined, controller?.signal);
        sessions = [session, ...sessions];
        selectedSessionId = session.id;
      }
      const queued = await keeperEnqueueMessage(selectedSessionId, content, controller?.signal);
      addMessages([queued.message]);
      runs = [queued.run, ...runs.filter((run) => run.id !== queued.run.id)];
      events = [];
      eventCursor = '';
      draft = '';
      notice = 'Queued. This task continues in the worker if you close the browser.';
      startPolling(queued.run.id);
      await refreshRun(queued.run.id);
    } catch (error_) {
      error = String(error_);
    } finally {
      busy = false;
    }
  }

  async function stop() {
    if (!currentRun || busy) {return;}
    busy = true;
    try {
      runs = [await keeperStop(currentRun.id), ...runs.filter((run) => run.id !== currentRun?.id)];
      notice = 'Stop requested. Work already acknowledged by the provider may finish its current checkpoint.';
    } catch (error_) {
      error = String(error_);
    } finally {
      busy = false;
    }
  }

  async function resume() {
    if (!currentRun || busy) {return;}
    busy = true;
    try {
      const resumed = await keeperResume(currentRun.id);
      runs = [resumed, ...runs.filter((run) => run.id !== resumed.id)];
      notice = 'Resumed from the durable checkpoint.';
      startPolling(resumed.id);
    } catch (error_) {
      error = String(error_);
    } finally {
      busy = false;
    }
  }

  async function updateSchedule(enabled: boolean, hour: number) {
    if (busy) {return;}
    busy = true;
    try {
      schedule = await keeperSetSchedule({ enabled, hour, timeZone: schedule?.time_zone || undefined });
      notice = enabled ? `Daily housekeeping is scheduled for ${String(hour).padStart(2, '0')}:00 NAS time.` : 'Daily housekeeping is paused.';
    } catch (error_) {
      error = String(error_);
    } finally {
      busy = false;
    }
  }

  function eventLabel(event: KeeperEvent): string {
    const data = event.data || {};
    const name = typeof data.name === 'string' ? data.name : 'photo tool';
    const text = typeof data.text === 'string' ? data.text : '';
    switch (event.type) {
      case 'assistant.message': { return text || 'Keeper replied';
      }
      case 'tool.started': { return `Started ${name}`;
      }
      case 'tool.completed': { return `Completed ${name}`;
      }
      case 'tool.failed': { return `Failed ${name}: ${typeof data.error === 'string' ? data.error : 'operation failed'}`;
      }
      case 'tool.images_hydrated': { return `Inspected ${Number(data.count) || 0} owner-authorized preview(s)`;
      }
      case 'analysis.queued': { return 'Inventory queued; analysis completion is checked separately.';
      }
      case 'run.checkpoint': { return 'Checkpoint saved; the task continues in a later bounded slice.';
      }
      case 'run.waiting': { return data.quota ? 'Waiting for the daily model quota window.' : 'Waiting to retry a recoverable operation.';
      }
      case 'run.completed': { return 'Keeper task completed.';
      }
      case 'run.stopped': { return 'Keeper task stopped.';
      }
      default: { return event.type.replaceAll('.', ' ');
      }
    }
  }

  onMount(() => {
    mounted = true;
    void load();
    return () => {
      mounted = false;
      generation++;
      controller?.abort();
      if (pollTimer) {clearInterval(pollTimer);}
    };
  });
</script>

<section class="rounded-xl border border-immich-primary/20 p-4" aria-label="Keeper">
  <div class="mb-4 flex flex-wrap items-start justify-between gap-3">
    <div>
      <h2 class="text-xl font-semibold">Keeper</h2>
      <p class="text-sm opacity-70">A persistent photo-keeper chat. Bounded slices checkpoint in the worker and continue after you close this page.</p>
    </div>
    <button type="button" class="rounded-lg border border-immich-primary/30 px-3 py-2" onclick={() => void load()} disabled={busy || loading}>Refresh</button>
  </div>
  {#if error}<p role="alert" class="mb-4 rounded-lg bg-red-500/10 p-3">{error}</p>{/if}
  {#if notice}<p role="status" class="mb-4 rounded-lg bg-immich-primary/10 p-3">{notice}</p>{/if}
  <div class="grid gap-5 lg:grid-cols-[220px_1fr]">
    <aside aria-label="Keeper sessions" class="min-w-0">
      <h3 class="mb-2 font-medium">Sessions</h3>
      <div class="mb-3 flex gap-2">
        <input class="min-w-0 flex-1 rounded-sm border bg-transparent p-2 text-sm" aria-label="New session title" bind:value={newSessionTitle} maxlength="200" placeholder="New session" />
        <button type="button" class="rounded-sm border px-2" aria-label="Create Keeper session" onclick={() => void createSession()} disabled={busy}>+</button>
      </div>
      <div class="space-y-1">
        {#each sessions as session (session.id)}
          <button type="button" class={`w-full rounded-sm p-2 text-left text-sm ${selectedSessionId === session.id ? 'bg-immich-primary/10' : ''}`} aria-current={selectedSessionId === session.id ? 'page' : undefined} onclick={() => void selectSession(session.id)}>{session.title}</button>
        {:else}<p class="text-sm opacity-60">No sessions yet. Create one to start a persistent conversation.</p>{/each}
      </div>
    </aside>
    <div class="min-w-0">
      {#if !selectedSessionId}
        <p class="rounded-lg border border-dashed border-immich-primary/30 p-6 text-center opacity-70">Create a session to ask Keeper about your library.</p>
      {:else}
        <div class="mb-4 max-h-112 space-y-3 overflow-y-auto rounded-lg border border-immich-primary/20 p-3" aria-live="polite">
          {#if loading}<p role="status">Loading Keeper history…</p>{/if}
          {#each messages as message (message.id)}
            <article class={`rounded-lg p-3 ${message.role === 'user' ? 'bg-immich-primary/10' : 'bg-gray-500/5'}`}>
              <p class="mb-1 text-xs font-medium uppercase opacity-60">{message.role === 'tool' ? 'Tool result' : message.role}</p>
              <p class="text-sm wrap-break-word whitespace-pre-wrap">{message.content}</p>
            </article>
          {:else}<p class="text-sm opacity-60">No messages yet.</p>{/each}
        </div>
        <form class="mb-4 flex gap-2" onsubmit={(event) => { event.preventDefault(); void submit(); }}>
          <label class="sr-only" for="keeper-message">Message Keeper</label>
          <textarea id="keeper-message" class="min-h-16 min-w-0 flex-1 rounded-lg border bg-transparent p-3" bind:value={draft} maxlength="32000" placeholder="Ask Keeper to inspect evidence or plan safe housekeeping…" disabled={busy}></textarea>
          <button type="submit" class="self-end rounded-lg bg-immich-primary px-4 py-2 text-white" disabled={busy || !draft.trim()}>Send</button>
        </form>
        {#if currentRun}
          <div class="mb-4 rounded-lg border border-immich-primary/20 p-3" aria-label="Keeper task status">
            <div class="flex flex-wrap items-center justify-between gap-2">
              <p class="font-medium">Task: {currentRun.status}</p>
              <div class="flex gap-3">
                {#if ['queued', 'running', 'waiting'].includes(currentRun.status)}<button type="button" class="text-immich-primary" onclick={() => void stop()} disabled={busy}>Stop</button>{/if}
                {#if ['stopped', 'failed', 'waiting'].includes(currentRun.status)}<button type="button" class="text-immich-primary" onclick={() => void resume()} disabled={busy}>Resume</button>{/if}
              </div>
            </div>
            {#if currentRun.blocked_reason === 'quota'}<p role="status" class="mt-2 text-sm">Waiting for the daily model quota. The worker will retry; this page does not need to stay open.</p>{/if}
            {#if currentRun.error}<p role="alert" class="mt-2 text-sm">{currentRun.error}</p>{/if}
            <p class="mt-2 text-xs opacity-70">Checkpoint turns {currentRun.total_turns} · tools {currentRun.total_tool_calls} · changed assets {currentRun.total_mutations}. Slice limits are 10 turns, 20 tools, and 100 changed assets.</p>
          </div>
        {/if}
        <details class="mb-4 rounded-lg border border-immich-primary/20 p-3" open>
          <summary class="cursor-pointer font-medium">Tool activity and evidence</summary>
          <div class="mt-2 space-y-2 text-sm">
            {#each events as event (event.seq)}<p><span class="opacity-60">{new Date(event.created_at).toLocaleTimeString()}</span> · {eventLabel(event)}</p>{:else}<p class="opacity-60">No tool activity yet.</p>{/each}
          </div>
        </details>
        {#if schedule}
          <div class="rounded-lg border border-immich-primary/20 p-3" role="region" aria-label="Keeper schedule">
            <div class="flex flex-wrap items-center justify-between gap-3">
              <div><h3 class="font-medium">Daily housekeeping</h3><p class="text-sm opacity-70">Runs in NAS-local time and continues in the background.</p></div>
              <label class="flex items-center gap-2 text-sm"><span>Enable</span><input type="checkbox" checked={schedule.enabled} disabled={busy} onchange={(event) => void updateSchedule(event.currentTarget.checked, schedule?.hour ?? 3)} /></label>
            </div>
            <label class="mt-3 flex max-w-xs items-center justify-between gap-3 text-sm">Start hour (NAS time)<input class="w-20 rounded-sm border bg-transparent p-2" type="number" min="0" max="23" value={schedule.hour} disabled={busy} onchange={(event) => void updateSchedule(schedule?.enabled ?? false, Number(event.currentTarget.value))} /></label>
            <p class="mt-2 text-xs opacity-70">Next run: {schedule.next_at ? new Date(schedule.next_at).toLocaleString() : 'not scheduled'} · Last run: {schedule.last_run_at ? new Date(schedule.last_run_at).toLocaleString() : 'none'}</p>
            {#if scheduleReport}<p class="mt-2 text-sm">Latest report: {scheduleReport}</p>{/if}
            {#if schedule.last_error}<p role="alert" class="mt-2 text-sm">Last schedule error: {schedule.last_error}</p>{/if}
          </div>
        {/if}
      {/if}
    </div>
  </div>
</section>
