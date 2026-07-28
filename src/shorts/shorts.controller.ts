import { Body, Controller, DefaultValuePipe, Delete, Get, HttpCode, HttpStatus, Param, ParseIntPipe, ParseUUIDPipe, Patch, Post, Query, Request } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ShortsService } from './shorts.service';
import { CreateShortDto } from './dto/create-short.dto';
import { RemoveShortDto } from './dto/remove-short.dto';
import { Roles } from '../common/decorators/roles.decorator';
import { Public } from '../common/decorators/public.decorator';
import { AuditAction } from '../common/decorators/audit-action.decorator';
import { ShortModerationStatus } from '../entities/short.entity';
import { JwtPayload } from '../auth/jwt.util';

@ApiTags('shorts')
@Controller('shorts')
export class ShortsController {
  constructor(private readonly shortsService: ShortsService) {}

  // Creator-facing — no @Roles, only authentication is required (global JwtAuthGuard),
  // same as every other participant-facing route in this app. Declared ahead of any
  // future :id-shaped GET to avoid the routing-shadow issue documented elsewhere
  // (events.controller.ts) where a literal-segment route must win over a param route.
  @Post()
  async create(
    @Body() dto: CreateShortDto,
    @Request() req: Request & { user: JwtPayload },
  ) {
    return await this.shortsService.create(req.user.id, dto);
  }

  // The public reel feed. @Public() because Shorts is browsable before signing in, the same
  // way the event listings are. Declared above the ':id'-shaped routes below so the literal
  // segment wins the routing match (see the shadowing note on create() above).
  //
  // Returns published reels only — see findFeed()'s own comment for why the moderation
  // filter and the narrowed uploader projection both live server-side.
  @Public()
  @Get('feed')
  async findFeed(
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page?: number,
    @Query('limit', new DefaultValuePipe(10), ParseIntPipe) limit?: number,
  ) {
    return await this.shortsService.findFeed({ page, limit });
  }

  @Get('mine')
  async findMine(@Request() req: Request & { user: JwtPayload }) {
    return await this.shortsService.findMine(req.user.id);
  }

  @Get('my-likes')
  async findMyLikedIds(@Request() req: Request & { user: JwtPayload }) {
    return await this.shortsService.findMyLikedIds(req.user.id);
  }

  @Post(':id/like')
  @HttpCode(HttpStatus.OK)
  async like(
    @Param('id', ParseUUIDPipe) id: string,
    @Request() req: Request & { user: JwtPayload },
  ) {
    return await this.shortsService.like(id, req.user.id);
  }

  @Delete(':id/like')
  @HttpCode(HttpStatus.OK)
  async unlike(
    @Param('id', ParseUUIDPipe) id: string,
    @Request() req: Request & { user: JwtPayload },
  ) {
    return await this.shortsService.unlike(id, req.user.id);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async removeOwn(
    @Param('id', ParseUUIDPipe) id: string,
    @Request() req: Request & { user: JwtPayload },
  ) {
    await this.shortsService.removeOwn(id, req.user.id);
  }

  // --- Admin-only moderation surface below (unchanged behavior, @Roles moved from
  // class-level to per-method so the creator-facing routes above aren't admin-gated too
  // — matches the per-method @Roles('admin') convention already used in
  // events.controller.ts's bulk-seed rather than a class-wide lock).

  @Roles('admin')
  @Get('admin')
  async findAllForAdmin(
    @Query('moderationStatus') moderationStatus?: ShortModerationStatus,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page?: number,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit?: number,
  ) {
    return await this.shortsService.findAllForAdmin({ moderationStatus, page, limit });
  }

  @Roles('admin')
  @AuditAction('short.approve', 'short')
  @Patch(':id/approve')
  async approve(@Param('id', ParseUUIDPipe) id: string) {
    return await this.shortsService.approve(id);
  }

  @Roles('admin')
  @AuditAction('short.remove', 'short')
  @Patch(':id/remove')
  async remove(@Param('id', ParseUUIDPipe) id: string, @Body() dto: RemoveShortDto) {
    return await this.shortsService.remove(id, dto.reason);
  }
}
