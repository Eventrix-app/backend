import { ExecutionContext, Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';

// ThrottlerGuard is registered globally (APP_GUARD in app.module.ts), so it also fires for
// WS gateway handlers (@SubscribeMessage) — its default request/response reading
// (req.headers, res.header(...)) assumes an HTTP context and throws on a WS one (the
// "request"/"response" objects Nest hands it there are actually the Socket client and
// message payload). `shouldSkip` is the hook the base class exposes for exactly this: skip
// throttling entirely for non-HTTP contexts, leaving existing HTTP rate-limiting untouched.
@Injectable()
export class HttpOnlyThrottlerGuard extends ThrottlerGuard {
  protected async shouldSkip(context: ExecutionContext): Promise<boolean> {
    return context.getType() !== 'http';
  }
}
