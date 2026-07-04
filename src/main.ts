import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { join } from 'path';
import { NestExpressApplication } from '@nestjs/platform-express';
import { ValidationPipe } from '@nestjs/common';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { setupSwagger } from './crud/swagger-helper';

async function bootstrap() {
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

  // Enable CORS for frontend (supporting both modern Metro 8081 and legacy 19006)
  app.enableCors({
    origin: [
      process.env.FRONTEND_URL || 'http://localhost:8081',
      'http://localhost:19006',
    ],
    credentials: true,
  });

  // Setup Swagger API Documentation
  setupSwagger(app);

  await app.listen(process.env.PORT ?? 3000);
  console.log(
    `Preview endpoint available at http://localhost:${process.env.PORT ?? 3000}/preview`,
  );
  console.log(
    `Swagger documentation available at http://localhost:${process.env.PORT ?? 3000}/api/docs`,
  );
}
bootstrap();
