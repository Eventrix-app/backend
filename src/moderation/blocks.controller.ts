import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Request } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { BlocksService } from './blocks.service';
import { CreateBlockDto } from './dto/create-block.dto';
import { JwtPayload } from '../auth/jwt.util';

@ApiTags('blocks')
@Controller('blocks')
export class BlocksController {
  constructor(private readonly blocksService: BlocksService) {}

  @Post()
  @HttpCode(HttpStatus.NO_CONTENT)
  async block(@Body() dto: CreateBlockDto, @Request() req: Request & { user: JwtPayload }) {
    await this.blocksService.block(req.user.id, dto.blockedUserId);
  }

  @Delete(':userId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async unblock(
    @Param('userId', ParseUUIDPipe) userId: string,
    @Request() req: Request & { user: JwtPayload },
  ) {
    await this.blocksService.unblock(req.user.id, userId);
  }

  // Deliberately self-only — see BlocksService.getBlockedUserIds's comment on why there's
  // no symmetric "who blocked me" endpoint.
  @Get()
  async list(@Request() req: Request & { user: JwtPayload }) {
    return await this.blocksService.listBlocked(req.user.id);
  }
}
