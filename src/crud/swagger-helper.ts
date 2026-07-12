import { INestApplication } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';

/**
 * Mounts Swagger UI for the Eventrix API at /api/docs.
 * Note: despite the historical filename, this helper does NOT generate a Postman
 * collection — see api-routes.json for the hand-maintained Postman collection.
 */
export function setupSwagger(app: INestApplication) {
  const config = new DocumentBuilder()
    .setTitle('Eventrix API')
    .setDescription('Eventrix backend API docs')
    .setVersion('1.0')
    .addBearerAuth()
    .build();

  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api/docs', app, document);
}
