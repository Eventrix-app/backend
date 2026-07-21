import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Request } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Public } from '../common/decorators/public.decorator';
import { JwtPayload } from '../auth/jwt.util';
import { ReviewsService } from './reviews.service';
import { CreateReviewDto } from './dto/review.dto';

@ApiTags('event-reviews')
@Controller('events/:eventId/reviews')
export class ReviewsController {
  constructor(private readonly reviewsService: ReviewsService) {}

  @Public()
  @Get()
  async findAll(@Param('eventId', ParseUUIDPipe) eventId: string) {
    return this.reviewsService.findAll(eventId);
  }

  @Post()
  async create(
    @Param('eventId', ParseUUIDPipe) eventId: string,
    @Body() dto: CreateReviewDto,
    @Request() req: Request & { user: JwtPayload },
  ) {
    return this.reviewsService.create(eventId, dto, req.user.id);
  }
}
