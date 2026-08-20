import { INestApplication } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';

/**
 * Mounts Swagger UI for the Eventrix API at /api/docs.
 * Note: despite the historical filename, this helper does NOT generate a Postman
 * collection — see api-routes.json for the hand-maintained Postman collection.
 */
export function setupSwagger(app: INestApplication) {
  // Fail-closed opt-in, same pattern (and same reasoning) as ALLOW_LOCALHOST_CORS and
  // ALLOW_DEV_OTP_BYPASS: this app never requires NODE_ENV to be set, so inferring
  // "production" from its value would leave the docs silently public on any deployment that
  // just never set it.
  //
  // Until this gate existed, /api/docs and /api/docs-json were both publicly readable on the
  // deployed API — verified returning 200 with a 47KB spec. That is the entire attack surface
  // handed over in one request: every route, every DTO field, every query parameter, plus
  // which endpoints are unauthenticated. Nothing here is a secret on its own, which is why it
  // is easy to leave on; it is reconnaissance, and there is no reason to publish it.
  if (process.env.ENABLE_API_DOCS !== 'true') return;

  const config = new DocumentBuilder()
    .setTitle('Eventrix API')
    .setDescription('Eventrix backend API docs')
    .setVersion('1.0')
    .addBearerAuth()
    .build();

  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api/docs', app, document);
}
