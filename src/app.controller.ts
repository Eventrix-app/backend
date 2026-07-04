import { Controller, Get } from '@nestjs/common';
import { AppService } from './app.service';
import { Public } from './common/decorators/public.decorator';

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Public()
  @Get()
  getHealth() {
    // #region agent log
    fetch('http://127.0.0.1:7900/ingest/60f87d47-04ee-4c91-8969-d73cd3960c98',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'947f72'},body:JSON.stringify({sessionId:'947f72',runId:'post-fix',hypothesisId:'H2',location:'app.controller.ts:getHealth',message:'health endpoint hit without auth',data:{public:true},timestamp:Date.now()})}).catch(()=>{});
    // #endregion
    return this.appService.getHealth();
  }
}
