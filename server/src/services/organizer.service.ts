import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Kysely, sql, Updateable } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { createHmac } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { LockableProperty } from 'src/database';
import { OnEvent } from 'src/decorators';
import { AuthDto } from 'src/dtos/auth.dto';
import { AssetVisibility, JobName, Permission } from 'src/enum';
import { ArgOf } from 'src/repositories/event.repository';
import { DB } from 'src/schema';
import { AssetExifTable } from 'src/schema/tables/asset-exif.table';
import { AlbumService } from 'src/services/album.service';
import { BaseService } from 'src/services/base.service';
import { TagService } from 'src/services/tag.service';

type MetadataValues = Partial<
  Record<'description' | 'latitude' | 'longitude' | 'dateTimeOriginal' | 'timeZone', string | number | null>
>;
type OrganizerChange = {
  asset: string;
  kind: string;
  status: string;
  before_value: MetadataValues & { tagId: string; albumId: string };
  after_value: MetadataValues;
};
const normal = (key: string, value: unknown) =>
  key === 'description'
    ? (value ?? '')
    : key === 'dateTimeOriginal' && value != null
      ? new Date(String(value)).toISOString()
      : (value ?? null);

@Injectable()
export class OrganizerService extends BaseService {
  @InjectKysely()
  private db!: Kysely<DB>;

  async metadata(auth: AuthDto, id: string, body: { before: MetadataValues; after: MetadataValues }) {
    if (auth.sharedLink) {
      throw new ForbiddenException();
    }
    await this.requireAccess({ auth, permission: Permission.AssetUpdate, ids: [id] });
    const asset = await this.assetRepository.getById(id);
    if (!asset || asset.ownerId !== auth.user.id) {
      throw new ForbiddenException();
    }
    if (asset.visibility === AssetVisibility.Locked || asset.deletedAt || asset.isOffline) {
      throw new ForbiddenException('Asset is not available to Organize');
    }
    const storage = await this.storage(auth, id);
    if (!storage.writable) {
      throw new ServiceUnavailableException('Storage is read-only');
    }
    const fields = ['description', 'latitude', 'longitude', 'dateTimeOriginal', 'timeZone'] as const;
    for (const values of [body.before, body.after]) {
      if (
        !values ||
        typeof values !== 'object' ||
        Array.isArray(values) ||
        Object.keys(values).some((k) => !fields.includes(k as (typeof fields)[number]))
      ) {
        throw new BadRequestException('Invalid metadata');
      }
      for (const [key, value] of Object.entries(values)) {
        if (value === null) {
          continue;
        }
        if (key === 'latitude' || key === 'longitude') {
          if (
            typeof value !== 'number' ||
            !Number.isFinite(value) ||
            Math.abs(value) > (key === 'latitude' ? 90 : 180)
          ) {
            throw new BadRequestException('Invalid coordinates');
          }
        } else if (
          typeof value !== 'string' ||
          value.length > 10_000 ||
          (key === 'dateTimeOriginal' && !Number.isFinite(Date.parse(value)))
        ) {
          throw new BadRequestException('Invalid metadata value');
        }
      }
    }
    if (Object.keys(body.before).sort().join(',') !== Object.keys(body.after).sort().join(',')) {
      throw new BadRequestException('Metadata comparison fields must match');
    }
    const updateMetadata = async () => this.db.transaction().execute(async (tx) => {
      // Lock the parent too: an asset without EXIF must not race first insertion.
      const lockedAsset = await tx
        .selectFrom('asset')
        .select(['id', 'visibility', 'deletedAt', 'isOffline'])
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirstOrThrow();
      if (lockedAsset.visibility === AssetVisibility.Locked || lockedAsset.deletedAt || lockedAsset.isOffline) {
        throw new ForbiddenException('Asset is not available to Organize');
      }
      await tx
        .insertInto('asset_exif')
        .values({ assetId: id })
        .onConflict((oc) => oc.column('assetId').doNothing())
        .execute();
      const current = await tx
        .selectFrom('asset_exif')
        .selectAll()
        .where('assetId', '=', id)
        .forUpdate()
        .executeTakeFirstOrThrow();
      const matches = (values: MetadataValues) =>
        Object.entries(values).every(
          ([key, value]) => normal(key, current[key as keyof typeof current]) === normal(key, value),
        );
      if (!matches(body.after)) {
        if (!matches(body.before)) {
          throw new ConflictException('A newer edit prevents this change');
        }
        const update: Updateable<AssetExifTable> = {};
        for (const key of fields) {
          if (!(key in body.after)) {
            continue;
          }
          const value = body.after[key];
          Object.assign(update, {
            [key]:
              key === 'dateTimeOriginal' && value != null
                ? new Date(String(value))
                : key === 'description'
                  ? (value ?? '')
                  : value,
          });
        }
        const locks = [
          ...new Set([...(current.lockedProperties || []), ...Object.keys(body.after)]),
        ] as LockableProperty[];
        await tx
          .updateTable('asset_exif')
          .set({ ...update, lockedProperties: locks })
          .where('assetId', '=', id)
          .execute();
      }
    });
    if (typeof this.assetRepository.withMetadataLock === 'function') {
      await this.assetRepository.withMetadataLock(id, updateMetadata);
    } else {
      await updateMetadata();
    }
    // Always retry the durable queue acknowledgment, even after an idempotent replay.
    await this.jobRepository.queue({ name: JobName.SidecarWrite, data: { id } });
    return { updated: true };
  }
  async storage(auth: AuthDto, id: string) {
    await this.requireAccess({ auth, permission: Permission.AssetRead, ids: [id] });
    const asset = await this.assetRepository.getById(id);
    if (!asset || asset.ownerId !== auth.user.id) {
      throw new ForbiddenException();
    }
    const mountInfo = await readFile('/proc/self/mountinfo', 'utf8');
    const mounts = mountInfo
      .trim()
      .split('\n')
      .map((line) => {
        const [left, right] = line.split(' - ', 2);
        const fields = left.split(' ');
        return { path: fields[4].replaceAll(String.raw`\040`, ' '), options: fields[5] + ',' + right.split(' ', 3)[2] };
      })
      .filter((m) => asset.originalPath === m.path || asset.originalPath.startsWith(m.path.replace(/\/$/, '') + '/'))
      .sort((a, b) => b.path.length - a.path.length);
    return { writable: !!mounts[0] && !mounts[0].options.split(',').includes('ro') };
  }
  async forward<T = Record<string, unknown>>(owner: string, path: string, method = 'GET', body?: unknown): Promise<T> {
    const url = process.env.ORGANIZER_URL;
    const secret = process.env.ORGANIZER_SECRET;
    if (!url || !secret) {
      throw new ServiceUnavailableException('Organizer worker is not configured');
    }
    const response = await fetch(`${url.replace(/\/$/, '')}${path}`, {
      method,
      headers: { Authorization: `Bearer ${secret}`, 'x-organizer-owner': owner, 'Content-Type': 'application/json' },
      ...(body !== undefined && { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(path === '/event' ? 2000 : 120_000),
    });
    if (!response.ok) {
      throw new HttpException(await response.text(), response.status);
    }
    return response.json();
  }

  session(auth: AuthDto) {
    if (!auth.session || auth.sharedLink || auth.apiKey) {
      throw new ForbiddenException('Use your Immich login to manage Organize');
    }
  }

  async connect(auth: AuthDto) {
    this.session(auth);
    // Cross-process serialization avoids provisioning concurrent losing keys.
    return this.db.transaction().execute(async (tx) => {
      await sql`select pg_advisory_xact_lock(hashtextextended(${`organizer-connect:${auth.user.id}`},0))`.execute(tx);
      const status = await this.forward(auth.user.id, '/status');
      const secret = process.env.ORGANIZER_SECRET;
      if (!secret || secret.length < 32) {
        throw new ServiceUnavailableException('Organizer secret is not configured');
      }
      // Stable, domain-separated credentials make a process crash between the two
      // databases recoverable without leaving an unused provisioned API key.
      const token = createHmac('sha256', secret).update(`organizer-api-key:${auth.user.id}`).digest('base64url');
      const hex = createHmac('sha256', secret).update(`organizer-key-id:${auth.user.id}`).digest('hex');
      const connectionId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
      if (status.connected && status.connectionId !== connectionId) {
        return status;
      }
      await tx
        .insertInto('api_key')
        .values({
          id: connectionId,
          userId: auth.user.id,
          key: this.cryptoRepository.hashSha256(token),
          name: 'Immich Organize worker',
          permissions: [
            Permission.AssetRead,
            Permission.AssetView,
            Permission.AssetDownload,
            Permission.AssetUpdate,
            Permission.AlbumRead,
            Permission.AlbumCreate,
            Permission.AlbumUpdate,
            Permission.AlbumAssetCreate,
            Permission.AlbumAssetDelete,
            Permission.TagRead,
            Permission.TagCreate,
            Permission.TagAsset,
            Permission.UserRead,
            Permission.ServerAbout,
          ],
        })
        .onConflict((oc) => oc.column('id').doNothing())
        .execute();
      try {
        const connected = await this.forward(auth.user.id, '/connect', 'POST', {
          key: token,
          connectionId,
        });
        if (connected.connectionId !== connectionId) {
          await tx.deleteFrom('api_key').where('id', '=', connectionId).where('userId', '=', auth.user.id).execute();
        }
        return { connected: true };
      } catch (error) {
        // A timed-out response may follow a successful worker commit.
        const connected = await this.forward(auth.user.id, '/status').catch(() => null);
        if (connected?.connectionId === connectionId) {
          return { connected: true };
        }
        throw error;
      }
    });
  }

  async undo(auth: AuthDto, id: string) {
    this.session(auth);
    const change = await this.forward<OrganizerChange>(auth.user.id, `/undo/${id}/prepare`, 'POST', {});
    if (change.status === 'undone') {
      return { undone: true };
    }
    await this.requireAccess({ auth, permission: Permission.AssetUpdate, ids: [change.asset] });
    const asset = await this.assetRepository.getById(change.asset);
    if (!asset || asset.ownerId !== auth.user.id) {
      throw new ForbiddenException();
    }
    const before = change.before_value;
    if (change.kind === 'tag') {
      await BaseService.create(TagService, this).removeAssets(auth, before.tagId, { ids: [asset.id] });
      return this.forward(auth.user.id, `/undo/${id}/complete`, 'POST', {});
    }
    if (change.kind === 'album') {
      await BaseService.create(AlbumService, this).removeAssets(auth, before.albumId, { ids: [asset.id] });
      return this.forward(auth.user.id, `/undo/${id}/complete`, 'POST', {});
    }
    // Native update DTOs cannot restore null GPS/description. Use the same
    // repository and sidecar job as AssetService, with explicitly allowed fields.
    await this.metadata(auth, asset.id, { before: change.after_value, after: before });
    return this.forward(auth.user.id, `/undo/${id}/complete`, 'POST', {});
  }

  @OnEvent({ name: 'AssetCreate' })
  async onOrganizerAssetCreate({ asset }: ArgOf<'AssetCreate'>) {
    if (!process.env.ORGANIZER_URL) {
      return;
    }
    try {
      await this.forward(asset.ownerId, '/event', 'POST', { assetId: asset.id });
    } catch {
      this.logger.warn('Organizer event delivery failed; periodic inventory will retry');
    }
  }
}
