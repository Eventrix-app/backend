import { Body, Controller, Post, Request } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { UploadsService } from './uploads.service';
import { CreateSignedUrlDto } from './dto/create-signed-url.dto';
import { JwtPayload } from '../auth/jwt.util';

@ApiTags('uploads')
@Controller('uploads')
export class UploadsController {
  constructor(private readonly uploadsService: UploadsService) {}

  // Requires authentication (no @Public()) — the specific role check per `purpose`
  // happens inside UploadsService, since it depends on the request body, not just the route.
  @Post('signed-url')
  async createSignedUrl(
    @Body() dto: CreateSignedUrlDto,
    @Request() req: Request & { user: JwtPayload },
  ) {
    return await this.uploadsService.createSignedUrl(dto, req.user.id, req.user.roles);
  }
}
