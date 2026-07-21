import { BadRequestException, Controller, Get, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { GeocodeService } from './geocode.service';

@ApiTags('geocode')
@Controller('geocode')
export class GeocodeController {
  constructor(private readonly geocodeService: GeocodeService) {}

  @Get('reverse')
  async reverse(@Query('lat') lat: string, @Query('lng') lng: string) {
    const parsedLat = Number(lat);
    const parsedLng = Number(lng);
    if (!lat || !lng || Number.isNaN(parsedLat) || Number.isNaN(parsedLng)) {
      throw new BadRequestException('lat and lng query params are required and must be numbers');
    }
    if (parsedLat < -90 || parsedLat > 90 || parsedLng < -180 || parsedLng > 180) {
      throw new BadRequestException('lat must be between -90 and 90, lng between -180 and 180');
    }
    return this.geocodeService.reverseGeocode(parsedLat, parsedLng);
  }
}
