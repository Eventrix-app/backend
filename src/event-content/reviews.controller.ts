import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Request } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Public } from '../common/decorators/public.decorator';
import { JwtPayload } from '../auth/jwt.util';
import { ReviewsService } from './reviews.service';
import { CreateReviewDto, UpdateReviewDto } from './dto/review.dto';

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

  @Patch(':reviewId')
  async update(
    @Param('eventId', ParseUUIDPipe) eventId: string,
    @Param('reviewId', ParseUUIDPipe) reviewId: string,
    @Body() dto: UpdateReviewDto,
    @Request() req: Request & { user: JwtPayload },
  ) {
    return this.reviewsService.update(eventId, reviewId, dto, req.user.id);
  }

  @Delete(':reviewId')
  async remove(
    @Param('eventId', ParseUUIDPipe) eventId: string,
    @Param('reviewId', ParseUUIDPipe) reviewId: string,
    @Request() req: Request & { user: JwtPayload },
  ) {
    await this.reviewsService.remove(eventId, reviewId, req.user.id, req.user.roles);
    return { message: 'Review deleted' };
  }
}
