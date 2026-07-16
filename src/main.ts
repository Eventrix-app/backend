import { createApp } from './create-app';

// Traditional long-running server entrypoint (local dev, or any non-serverless host).
// Vercel's serverless deployment uses api/index.ts instead, which reuses createApp()
// but never calls listen() — see that file for why.
async function bootstrap() {
  const app = await createApp();
  await app.listen(process.env.PORT ?? 3000);
  console.log(
    `Preview endpoint available at http://localhost:${process.env.PORT ?? 3000}/preview`,
  );
  console.log(
    `Swagger documentation available at http://localhost:${process.env.PORT ?? 3000}/api/docs`,
  );
}
bootstrap();
