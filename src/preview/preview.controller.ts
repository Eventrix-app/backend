import { Controller, Get, Render } from '@nestjs/common';
import { PreviewService } from './preview.service';
import { join } from 'path';
import { ApiTags } from '@nestjs/swagger';
import { Public } from 'src/common/decorators/public.decorator';

@ApiTags('preview')
@Public()
@Controller('preview')
export class PreviewController {
  constructor(private readonly previewService: PreviewService) { }

  @Get()
  @Render('preview')
  async getPreview() {
    const components = await this.previewService.getAllComponents();
    return {
      title: 'Component Preview',
      components,
    };
  }

  @Get('api')
  async getComponentsApi() {
    return this.previewService.getAllComponents();
  }
}
