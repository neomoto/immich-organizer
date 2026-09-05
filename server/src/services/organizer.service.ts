import { ForbiddenException, HttpException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { readFile } from 'node:fs/promises';
import { OnEvent } from 'src/decorators';
import { AuthDto } from 'src/dtos/auth.dto';
import { JobName, Permission } from 'src/enum';
import { ArgOf } from 'src/repositories/event.repository';
import { AlbumService } from 'src/services/album.service';
import { ApiKeyService } from 'src/services/api-key.service';
import { BaseService } from 'src/services/base.service';
import { TagService } from 'src/services/tag.service';

@Injectable()
export class OrganizerService extends BaseService {
  async storage(auth: AuthDto, id: string) {
    await this.requireAccess({ auth, permission: Permission.AssetRead, ids: [id] });
    const asset = await this.assetRepository.getById(id);
    if (!asset || asset.ownerId !== auth.user.id) throw new ForbiddenException();
    const mounts = (await readFile('/proc/self/mountinfo', 'utf8'))
      .trim()
      .split('\n')
      .map((line) => {
        const [left, right] = line.split(' - ');
        const fields = left.split(' ');
        return { path: fields[4].replaceAll('\\040', ' '), options: fields[5] + ',' + right.split(' ')[2] };
      })
      .filter((m) => asset.originalPath === m.path || asset.originalPath.startsWith(m.path.replace(/\/$/, '') + '/'))
      .sort((a, b) => b.path.length - a.path.length);
    return { writable: !!mounts[0] && !mounts[0].options.split(',').includes('ro') };
  }
  async forward(owner: string, path: string, method = 'GET', body?: unknown): Promise<any> {
    const url = process.env.ORGANIZER_URL;
    const secret = process.env.ORGANIZER_SECRET;
    if (!url || !secret) throw new ServiceUnavailableException('Organizer worker is not configured');
    const response = await fetch(`${url.replace(/\/$/, '')}${path}`, {
      method,
      headers: { Authorization: `Bearer ${secret}`, 'x-organizer-owner': owner, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(path === '/event' ? 2000 : 120000),
    });
    if (!response.ok) throw new HttpException(await response.text(), response.status);
    return response.json();
  }

  session(auth: AuthDto) {
    if (!auth.session || auth.sharedLink || auth.apiKey)
      throw new ForbiddenException('Use your Immich login to manage Organize');
  }

  async connect(auth: AuthDto) {
    this.session(auth);
    const status = await this.forward(auth.user.id, '/status');
    if (status.connected) return status;
    const service = BaseService.create(ApiKeyService, this);
    const key = await service.create(auth, {
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
    });
    try {
      return await this.forward(auth.user.id, '/connect', 'POST', { key: key.secret });
    } catch (error) {
      await service.delete(auth, key.apiKey.id);
      throw error;
    }
  }

  async undo(auth: AuthDto, id: string) {
    this.session(auth);
    const change = await this.forward(auth.user.id, `/undo/${id}`);
    await this.requireAccess({ auth, permission: Permission.AssetUpdate, ids: [change.asset] });
    const asset = await this.assetRepository.getById(change.asset);
    if (!asset || asset.ownerId !== auth.user.id) throw new ForbiddenException();
    const before = change.before_value;
    if (change.kind === 'tag') {
      await BaseService.create(TagService, this).removeAssets(auth, before.tagId, { ids: [asset.id] });
      return this.forward(auth.user.id, `/undo/${id}`, 'POST', {});
    }
    if (change.kind === 'album') {
      await BaseService.create(AlbumService, this).removeAssets(auth, before.albumId, { ids: [asset.id] });
      return this.forward(auth.user.id, `/undo/${id}`, 'POST', {});
    }
    // Native update DTOs cannot restore null GPS/description. Use the same
    // repository and sidecar job as AssetService, with explicitly allowed fields.
    await this.assetRepository.upsertExif({
      exif: {
        assetId: asset.id,
        ...('description' in before ? { description: before.description } : {}),
        ...('latitude' in before ? { latitude: before.latitude, longitude: before.longitude } : {}),
        ...('dateTimeOriginal' in before ? { dateTimeOriginal: new Date(before.dateTimeOriginal) } : {}),
      },
      lockedPropertiesBehavior: 'append',
    });
    await this.jobRepository.queue({ name: JobName.SidecarWrite, data: { id: asset.id } });
    return this.forward(auth.user.id, `/undo/${id}`, 'POST', {});
  }

  @OnEvent({ name: 'AssetCreate' })
  async onOrganizerAssetCreate({ asset }: ArgOf<'AssetCreate'>) {
    if (!process.env.ORGANIZER_URL) return;
    try {
      await this.forward(asset.ownerId, '/event', 'POST', { assetId: asset.id });
    } catch {
      this.logger.warn('Organizer event delivery failed; periodic inventory will retry');
    }
  }
}
