import { Body, Controller, Get, Param, Post, Put, Query } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { AuthDto } from 'src/dtos/auth.dto';
import { Permission } from 'src/enum';
import { Auth, Authenticated } from 'src/middleware/auth.guard';
import { OrganizerService } from 'src/services/organizer.service';
import { UUIDParamDto } from 'src/validation';
import z from 'zod';

class OrganizerBody extends createZodDto(z.record(z.string(), z.unknown())) {}

@ApiExcludeController()
@Controller('organizer')
export class OrganizerController {
  constructor(private service: OrganizerService) {}

  @Put('metadata/:id')
  @Authenticated({ permission: Permission.AssetUpdate })
  metadata(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto, @Body() body: OrganizerBody) {
    return this.service.metadata(auth, id, body as Parameters<OrganizerService['metadata']>[2]);
  }

  @Get('storage/:id')
  @Authenticated({ permission: Permission.AssetRead })
  storage(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto) {
    return this.service.storage(auth, id);
  }

  @Get('status')
  @Authenticated()
  status(@Auth() auth: AuthDto) {
    this.service.session(auth);
    return this.service.forward(auth.user.id, '/status');
  }

  @Post('connect')
  @Authenticated()
  connect(@Auth() auth: AuthDto) {
    return this.service.connect(auth);
  }

  @Put('settings')
  @Authenticated()
  settings(@Auth() auth: AuthDto, @Body() body: OrganizerBody) {
    this.service.session(auth);
    return this.service.forward(auth.user.id, '/settings', 'PUT', body);
  }

  @Post('runs')
  @Authenticated()
  run(@Auth() auth: AuthDto, @Body() body: OrganizerBody) {
    this.service.session(auth);
    return this.service.forward(auth.user.id, '/runs', 'POST', body);
  }

  @Post('manifest')
  @Authenticated()
  manifest(@Auth() auth: AuthDto, @Body() body: OrganizerBody) {
    this.service.session(auth);
    return this.service.forward(auth.user.id, '/manifest', 'POST', body);
  }

  @Get('assets')
  @Authenticated()
  assets(@Auth() auth: AuthDto, @Query() query: Record<string, string>) {
    this.service.session(auth);
    const params = new URLSearchParams();
    for (const key of ['q', 'offset', 'status', 'category', 'datePrecision', 'locationPrecision']) {
      if (typeof query[key] === 'string') {
        params.set(key, query[key]);
      }
    }
    return this.service.forward(auth.user.id, `/assets?${params}`);
  }

  @Get('assets/:id')
  @Authenticated()
  asset(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto) {
    this.service.session(auth);
    return this.service.forward(auth.user.id, `/assets/${id}`);
  }

  @Put('assets/:id')
  @Authenticated()
  edit(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto, @Body() body: OrganizerBody) {
    this.service.session(auth);
    return this.service.forward(auth.user.id, `/assets/${id}`, 'PUT', body);
  }

  @Get('events')
  @Authenticated()
  events(@Auth() auth: AuthDto) {
    this.service.session(auth);
    return this.service.forward(auth.user.id, '/events');
  }

  @Get('history')
  @Authenticated()
  history(@Auth() auth: AuthDto, @Query('offset') offset = '0') {
    this.service.session(auth);
    return this.service.forward(auth.user.id, `/history?offset=${encodeURIComponent(offset)}`);
  }

  @Post('undo/:id')
  @Authenticated()
  undo(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto) {
    return this.service.undo(auth, id);
  }

  @Get('keeper/sessions')
  @Authenticated()
  keeperSessions(@Auth() auth: AuthDto, @Query() query: Record<string, string>) {
    this.service.session(auth);
    const params = new URLSearchParams();
    for (const key of ['cursor', 'limit']) {
      if (typeof query[key] === 'string') {
        params.set(key, query[key]);
      }
    }
    return this.service.forward(auth.user.id, `/keeper/sessions?${params}`);
  }

  @Post('keeper/sessions')
  @Authenticated()
  keeperCreateSession(@Auth() auth: AuthDto, @Body() body: OrganizerBody) {
    this.service.session(auth);
    return this.service.forward(auth.user.id, '/keeper/sessions', 'POST', body);
  }

  @Get('keeper/sessions/:id')
  @Authenticated()
  keeperSession(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto) {
    this.service.session(auth);
    return this.service.forward(auth.user.id, `/keeper/sessions/${id}`);
  }

  @Get('keeper/sessions/:id/messages')
  @Authenticated()
  keeperMessages(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto, @Query() query: Record<string, string>) {
    this.service.session(auth);
    const params = new URLSearchParams();
    for (const key of ['cursor', 'limit']) {
      if (typeof query[key] === 'string') {
        params.set(key, query[key]);
      }
    }
    return this.service.forward(auth.user.id, `/keeper/sessions/${id}/messages?${params}`);
  }

  @Post('keeper/sessions/:id/messages')
  @Authenticated()
  keeperEnqueueMessage(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto, @Body() body: OrganizerBody) {
    this.service.session(auth);
    return this.service.forward(auth.user.id, `/keeper/sessions/${id}/messages`, 'POST', body);
  }

  @Get('keeper/sessions/:id/runs')
  @Authenticated()
  keeperSessionRuns(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto, @Query() query: Record<string, string>) {
    this.service.session(auth);
    const params = new URLSearchParams();
    for (const key of ['cursor', 'limit']) {
      if (typeof query[key] === 'string') {
        params.set(key, query[key]);
      }
    }
    return this.service.forward(auth.user.id, `/keeper/sessions/${id}/runs?${params}`);
  }

  @Get('keeper/runs/:id')
  @Authenticated()
  keeperRun(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto) {
    this.service.session(auth);
    return this.service.forward(auth.user.id, `/keeper/runs/${id}`);
  }

  @Get('keeper/runs/:id/events')
  @Authenticated()
  keeperRunEvents(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto, @Query() query: Record<string, string>) {
    this.service.session(auth);
    const params = new URLSearchParams();
    for (const key of ['cursor', 'limit']) {
      if (typeof query[key] === 'string') {
        params.set(key, query[key]);
      }
    }
    return this.service.forward(auth.user.id, `/keeper/runs/${id}/events?${params}`);
  }

  @Post('keeper/runs/:id/stop')
  @Authenticated()
  keeperStop(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto) {
    this.service.session(auth);
    return this.service.forward(auth.user.id, `/keeper/runs/${id}/stop`, 'POST', {});
  }

  @Post('keeper/runs/:id/resume')
  @Authenticated()
  keeperResume(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto) {
    this.service.session(auth);
    return this.service.forward(auth.user.id, `/keeper/runs/${id}/resume`, 'POST', {});
  }

  @Get('keeper/schedule')
  @Authenticated()
  keeperSchedule(@Auth() auth: AuthDto) {
    this.service.session(auth);
    return this.service.forward(auth.user.id, '/keeper/schedule');
  }

  @Put('keeper/schedule')
  @Authenticated()
  keeperSetSchedule(@Auth() auth: AuthDto, @Body() body: OrganizerBody) {
    this.service.session(auth);
    return this.service.forward(auth.user.id, '/keeper/schedule', 'PUT', body);
  }
}
