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
  assets(@Auth() auth: AuthDto, @Query('q') q = '', @Query('offset') offset = '0') {
    this.service.session(auth);
    return this.service.forward(
      auth.user.id,
      `/assets?q=${encodeURIComponent(q)}&offset=${encodeURIComponent(offset)}`,
    );
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
  history(@Auth() auth: AuthDto) {
    this.service.session(auth);
    return this.service.forward(auth.user.id, '/history');
  }

  @Post('undo/:id')
  @Authenticated()
  undo(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto) {
    return this.service.undo(auth, id);
  }
}
