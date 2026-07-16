import type { IncomingMessage, ServerResponse } from 'http';
// Deliberately imports the *compiled* output rather than '../src/create-app'. Vercel's
// function bundler transpiles this file with esbuild, which does not reliably reproduce
// TypeScript's emitDecoratorMetadata output — and NestJS's dependency injection depends on
// that metadata to resolve constructor parameter types. Routing through dist/ (built by the
// real TypeScript compiler via `nest build`, see vercel.json's buildCommand) sidesteps that
// entirely: only this thin file passes through esbuild, not the whole Nest dependency graph.
import { createApp } from '../dist/create-app';

type ExpressHandler = (req: IncomingMessage, res: ServerResponse) => void;

let appPromise: Promise<ExpressHandler> | null = null;

function getExpressApp(): Promise<ExpressHandler> {
  if (!appPromise) {
    appPromise = createApp()
      .then(async (app) => {
        await app.init();
        return app.getHttpAdapter().getInstance() as ExpressHandler;
      })
      .catch((err) => {
        // Don't cache a failed boot (e.g. a transient DB blip) — let the next invocation
        // in this same warm container retry from scratch instead of 500-ing forever.
        appPromise = null;
        throw err;
      });
  }
  return appPromise;
}

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  const expressApp = await getExpressApp();
  expressApp(req, res);
}
