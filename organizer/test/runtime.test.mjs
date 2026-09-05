import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID, randomBytes } from 'node:crypto';

const pause = (ms) => new Promise(resolve => setTimeout(resolve, ms));
test('isolated Immich session, analysis, mutations, undo and authorization', { skip: !process.env.RUNTIME_URL, timeout: 300000 }, async t => {
  const base = process.env.RUNTIME_URL;
  assert.ok(['127.0.0.1', 'localhost'].includes(new URL(base).hostname), 'runtime fixture must be local');
  let token;
  async function api(path, body, method = body ? 'POST' : 'GET') {
    const headers = { ...(token ? { Authorization: `Bearer ${token}` } : {}) };
    if (body && !(body instanceof FormData)) headers['Content-Type'] = 'application/json';
    const response = await fetch(base + '/api' + path, {
      method, headers, ...(body ? { body: body instanceof FormData ? body : JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(30000),
    });
    const text = await response.text();
    let data;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    return { status: response.status, data };
  }
  const success = (r) => { assert.ok(r.status >= 200 && r.status < 300, JSON.stringify(r)); return r.data; };
  async function until(read, accept, message) {
    for (let n = 0; n < 75; n++) {
      const value = await read();
      if (accept(value)) return value;
      if (value?.status === 'failed') assert.fail(JSON.stringify(value));
      await pause(1000);
    }
    assert.fail(message);
  }
  async function upload(name) {
    // Random pixel bytes prevent checksum deduplication across repeated test runs.
    const png = execFileSync('ffmpeg', ['-v', 'error', '-f', 'rawvideo', '-pixel_format', 'rgb24',
      '-video_size', '32x32', '-i', 'pipe:0', '-frames:v', '1', '-f', 'image2pipe', '-vcodec', 'png', 'pipe:1'],
    { input: randomBytes(32 * 32 * 3) });
    const form = new FormData();
    form.append('assetData', new Blob([png], { type: 'image/png' }), name);
    form.append('deviceAssetId', randomUUID()); form.append('deviceId', 'organizer-runtime-test');
    form.append('fileCreatedAt', '2024-01-01T12:00:00.000Z'); form.append('fileModifiedAt', '2024-01-01T12:00:00.000Z');
    return success(await api('/assets', form)).id;
  }
  const suffix = randomUUID();
  const admin = { email: 'organizer-test@example.invalid', password: 'Synthetic-local-test-password!' };
  assert.equal((await api('/organizer/status')).status, 401);
  await api('/auth/admin-sign-up', { ...admin, name: 'Organizer test' });
  token = success(await api('/auth/login', admin)).accessToken;
  const adminToken = token;
  const credentials = { email: `organizer-${suffix}@example.invalid`, password: 'Synthetic-local-test-password!' };
  const user = success(await api('/admin/users', { ...credentials, name: 'Synthetic organizer run', shouldChangePassword: false, notify: false }));
  token = success(await api('/auth/login', credentials)).accessToken;
  const ownerToken = token;
  try {
    await t.test('session connection and bounded read-only pilot', async () => {
      success(await api('/organizer/connect', {}));
      assert.equal(success(await api('/organizer/status')).connected, true);
      assert.equal((await api('/organizer/settings', { dailyLimit: -1 }, 'PUT')).status, 400);
      success(await api('/organizer/settings', { enabled: true, automatic: false, continuous: false, webLookup: false, dailyLimit: 5000 }, 'PUT'));
    });
    const id = await upload(`runtime-${suffix}.png`);
    let analysis;
    await t.test('synthetic model produces results without canonical pilot writes', async () => {
      const run = success(await api('/organizer/runs', { assetIds: [id], limit: 100000, reanalyze: true }));
      assert.equal(run.requested, 200, 'pilot request must be clamped');
      await until(async () => success(await api('/organizer/status')).runs.find(r => r.id === run.runId), r => r?.status === 'complete', 'pilot inventory did not finish');
      analysis = await until(async () => success(await api('/organizer/assets/' + id)), a => a?.status === 'analyzed', 'analysis did not finish');
      assert.equal(analysis.result.caption, 'A synthetic archive test image.');
      const asset = success(await api('/assets/' + id));
      assert.equal(asset.exifInfo.latitude ?? null, null);
      assert.equal(asset.exifInfo.description || '', '');
      assert.equal(asset.tags.some(tag => tag.value === 'AI/Synthetic'), false);
      success(await api('/organizer/manifest', { entries: [{
        checksum: asset.checksum, paths: [`/synthetic/夏/${suffix}.png`], filename: `${suffix}.png`,
        group: `/synthetic/夏/${suffix}`, verified: true, captureDate: '2014-08-12T10:00:00+03:00',
        originalExif: { DateTimeOriginal: '2014:08:12 10:00:00', OffsetTimeOriginal: '+03:00' },
      }] }));
    });
    await t.test('automatic application creates caption, approximate GPS, tags and event album', async () => {
      success(await api('/organizer/settings', { automatic: true }, 'PUT'));
      const run = success(await api('/organizer/runs', { assetIds: [id], limit: 1, reanalyze: true }));
      await until(async () => success(await api('/organizer/status')).runs.find(r => r.id === run.runId), r => r?.status === 'complete', 'automatic inventory did not finish');
      analysis = await until(async () => success(await api('/organizer/assets/' + id)), a => a?.status === 'analyzed' && a?.provenance?.group, 'automatic analysis did not finish');
      const after = success(await api('/assets/' + id));
      assert.equal(after.exifInfo.description, analysis.result.caption);
      assert.equal(after.exifInfo.latitude, 48.8566);
      assert.equal(after.exifInfo.longitude, 2.3522);
      assert.equal(analysis.proposal.locationApproximate, true);
      assert.ok(after.tags.some(tag => tag.value === 'AI/Synthetic'));
      const events = success(await api('/organizer/events'));
      assert.ok(events.length > 0);
      assert.ok(success(await api('/albums?assetId=' + id)).some(album => album.id === events[0].album));
    });
    await t.test('Keeper persists chat, executes native tools, hydrates pixels, schedules housekeeping and isolates owners', async () => {
      const session = success(await api('/organizer/keeper/sessions', { title: 'Runtime Keeper' }));
      assert.match(session.id, /^[0-9a-f-]{36}$/i);
      const queued = success(await api(`/organizer/keeper/sessions/${session.id}/messages`, { content: 'Inspect the runtime photo and report what you see.' }));
      assert.match(queued.run.id, /^[0-9a-f-]{36}$/i);
      const run = await until(
        async () => success(await api(`/organizer/keeper/runs/${queued.run.id}`)),
        value => value?.status === 'complete',
        'Keeper run did not complete',
      );
      const messages = success(await api(`/organizer/keeper/sessions/${session.id}/messages`));
      assert.ok(messages.messages.some(message => message.role === 'assistant' && /preview pixels/.test(message.content)));
      assert.equal(JSON.stringify(messages).includes('data:image/'), false, 'Keeper transcript must not persist image bytes');
      const events = success(await api(`/organizer/keeper/runs/${run.id}/events`));
      assert.ok(events.events.some(event => event.type === 'tool.completed' && event.data.name === 'search_photos'));
      assert.ok(events.events.some(event => event.type === 'tool.completed' && event.data.name === 'inspect_photo'));
      assert.ok(events.events.some(event => event.type === 'tool.images_hydrated' && event.data.count > 0));
      assert.equal(JSON.stringify(events).includes('data:image/'), false, 'Keeper events must not persist image bytes');
      const cursor = events.events[0]?.seq;
      if (cursor) assert.ok(success(await api(`/organizer/keeper/runs/${run.id}/events?cursor=${cursor}`)).events.length > 0);
      const defaultSchedule = success(await api('/organizer/keeper/schedule'));
      assert.equal(defaultSchedule.hour, 3);
      const enabledSchedule = success(await api('/organizer/keeper/schedule', { enabled: true, hour: 3 }, 'PUT'));
      assert.equal(enabledSchedule.enabled, true);
      const nextMessage = success(await api(`/organizer/keeper/sessions/${session.id}/messages`, { content: 'Pause this follow-up.' }));
      const stopped = success(await api(`/organizer/keeper/runs/${nextMessage.run.id}/stop`, {}));
      assert.equal(stopped.status, 'stopped');
      const resumed = success(await api(`/organizer/keeper/runs/${nextMessage.run.id}/resume`, {}));
      assert.equal(resumed.status, 'queued');
      success(await api(`/organizer/keeper/runs/${nextMessage.run.id}/stop`, {}));
      token = adminToken;
      success(await api('/organizer/connect', {}));
      assert.deepEqual(success(await api('/organizer/keeper/sessions')).sessions, [], 'Keeper sessions must be owner isolated');
      token = ownerToken;
      success(await api('/organizer/keeper/schedule', { enabled: false }, 'PUT'));
    });
    let metadataChange;
    await t.test('undo restores missing GPS and description and removes managed memberships', async () => {
      const changes = success(await api('/organizer/history')).filter(c => c.asset === id && c.status === 'applied');
      metadataChange = changes.find(c => c.kind === 'metadata');
      assert.ok(metadataChange);
      assert.equal(metadataChange.before_value.latitude, null);
      assert.equal(metadataChange.before_value.longitude, null);
      for (const change of changes) {
        assert.equal(success(await api('/organizer/undo/' + change.id, {})).undone, true);
        assert.equal(success(await api('/organizer/undo/' + change.id, {})).undone, true, 'undo replay must be idempotent');
      }
      const restored = success(await api('/assets/' + id));
      assert.equal(restored.exifInfo.latitude ?? null, null);
      assert.equal(restored.exifInfo.longitude ?? null, null);
      assert.equal(restored.exifInfo.description || '', metadataChange.before_value.description || '');
      assert.ok(!restored.tags.some(tag => tag.value === 'AI/Synthetic'));
      for (const c of changes.filter(c => c.kind === 'album'))
        assert.ok(!success(await api('/albums?assetId=' + id)).some(album => album.id === c.before_value.albumId));
    });
    await t.test('undo resumes after native restore but before worker acknowledgment', async () => {
      assert.match(metadataChange.id, /^[0-9a-f-]{36}$/);
      // Inject only the lost-ack journal state in the isolated test database.
      execFileSync('docker', ['compose', '-f', 'organizer/compose.test.yaml', 'exec', '-T', 'organizer-db',
        'psql', '-U', 'postgres', '-d', 'organizer', '-v', 'ON_ERROR_STOP=1', '-c',
        `UPDATE changes SET status='undoing' WHERE id='${metadataChange.id}' AND status='undone'`], { cwd: new URL('../..', import.meta.url), stdio: 'pipe' });
      assert.equal(success(await api('/organizer/undo/' + metadataChange.id, {})).undone, true);
      assert.equal(success(await api('/organizer/history')).find(c => c.id === metadataChange.id).status, 'undone');
    });
    await t.test('pause keeps new discovery queued and prevents analysis', async () => {
      success(await api('/organizer/settings', { enabled: false }, 'PUT'));
      const pausedId = await upload('paused-' + suffix + '.png');
      const run = success(await api('/organizer/runs', { assetIds: [pausedId], limit: 1 }));
      await pause(2500);
      assert.equal(success(await api('/organizer/assets/' + pausedId)), null);
      const state = success(await api('/organizer/status'));
      assert.equal(state.runs.find(r => r.id === run.runId).status, 'queued');
    });
    await t.test('other owners, locked assets and trash are inaccessible to analysis', async () => {
      token = adminToken;
      success(await api('/organizer/connect', {}));
      assert.ok((await api('/organizer/assets/' + id)).status >= 400);
      token = ownerToken;
      success(await api('/assets/' + id, { visibility: 'locked' }, 'PUT'));
      assert.ok((await api('/organizer/assets/' + id)).status >= 400);
      const trashId = await upload('trash-' + suffix + '.png');
      success(await api('/assets', { ids: [trashId] }, 'DELETE'));
      assert.ok((await api('/organizer/assets/' + trashId)).status >= 400);
    });
  } finally {
    token = ownerToken;
    await api('/organizer/settings', { enabled: false }, 'PUT').catch(() => {});
    // Keep synthetic rows for failure inspection; each run has an isolated owner.
    assert.ok(user.id);
  }
});
