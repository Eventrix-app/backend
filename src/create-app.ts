import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { ValidationPipe } from '@nestjs/common';
import { join } from 'path';
import { AppModule } from './app.module';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { setupSwagger } from './crud/swagger-helper';

// Builds and configures the Nest app without binding a port, so the same setup can be
// reused by both the traditional long-running server (main.ts) and the Vercel serverless
// entrypoint (api/index.ts), which must never call app.listen().
export async function createApp(): Promise<NestExpressApplication> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );
  app.useGlobalFilters(app.get(HttpExceptionFilter));

  // Enable view engine
  app.useStaticAssets(join(__dirname, '..', 'public'));
  app.setBaseViewsDir(join(__dirname, '..', 'views'));
  app.setViewEngine('hbs');

  app.setGlobalPrefix('api');

  // Enable CORS for frontend. Expo's web dev server doesn't run on a fixed port — it
  // bumps to the next free one (8082, 8083, ...) whenever 8081 is already taken by
  // another Metro instance, so a hardcoded single-port allowlist breaks on every restart
  // that happens to land on a different port. Any localhost/127.0.0.1 origin is allowed
  // in development for that reason; FRONTEND_URL covers a deployed (non-localhost) web
  // build, e.g. in production.
  const isLocalhostOrigin = (origin: string) => /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
  app.enableCors({
    origin: (origin, callback) => {
      if (!origin || isLocalhostOrigin(origin) || origin === process.env.FRONTEND_URL) {
        callback(null, true);
      } else {
        callback(new Error(`Origin ${origin} not allowed by CORS`), false);
      }
    },
    credentials: true,
  });

  // Setup Swagger API Documentation
  setupSwagger(app);

  return app;
}
