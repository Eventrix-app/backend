import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Response, Request } from 'express';
import * as jwt from 'jsonwebtoken';
import { Sentry } from '../../config/sentry';

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('HttpExceptionFilter');

  constructor(private readonly configService: ConfigService) {}

  async catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const status =
      exception instanceof HttpException
        ? exception.getStatus()
        : HttpStatus.INTERNAL_SERVER_ERROR;

    const exceptionResponse =
      exception instanceof HttpException ? exception.getResponse() : null;

    let message = 'Internal server error';
    let details: any = null;

    if (exception instanceof HttpException) {
      if (typeof exceptionResponse === 'string') {
        message = exceptionResponse;
      } else if (
        typeof exceptionResponse === 'object' &&
        exceptionResponse !== null
      ) {
        message =
          (exceptionResponse as any).message ||
          JSON.stringify(exceptionResponse);
        details = (exceptionResponse as any).error || null;
      }
    } else if (exception instanceof Error) {
      message = exception.message;
    }

    // Determine user role from the request's bearer token, if any.
    // We deliberately do NOT verify the token here — log enrichment only. We use the raw
    // jwt.decode (no signature check) for log labeling. The actual authentication happens
    // in JwtAuthGuard. This is safe because the data is only attached to a log line.
    let userType = 'guest';
    let userId = 'N/A';
    const authHeader = request.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.split(' ')[1];
      try {
        const decoded = jwt.decode(token) as any;
        if (decoded && typeof decoded === 'object') {
          userType = Array.isArray(decoded.roles) && decoded.roles.length ? decoded.roles[0] : 'user';
          userId = decoded.id || 'unknown';
        } else {
          userType = 'invalid_token';
        }
      } catch {
        userType = 'invalid_token';
      }
    }

    // Log the exception in detail
    if (status === HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error(
        `Unhandled exception: ${exception instanceof Error ? exception.stack : JSON.stringify(exception)}`,
        `[UserType: ${userType}] [UserID: ${userId}] ${request.method} ${request.url}`,
      );

      // Only genuine 500s go to Sentry — 4xx (validation failures, 401/403/404s) are
      // normal operation, not crashes, and would drown out real signal. flush() is
      // awaited (not fire-and-forget) because a serverless container can freeze the
      // instant this response is sent, before a background send would otherwise complete —
      // see Sentry's own Vercel/serverless guidance. Capped at 2s so a Sentry outage can
      // never turn an already-failing request into a hung one.
      Sentry.captureException(exception, {
        tags: { userType },
        user: userId !== 'N/A' ? { id: userId } : undefined,
        extra: { method: request.method, url: request.url },
      });
      await Sentry.flush(2000).catch(() => {});
    } else {
      this.logger.warn(
        `HttpException: ${status} - Message: ${JSON.stringify(message)}${details ? ` - Details: ${JSON.stringify(details)}` : ''}`,
        `[UserType: ${userType}] [UserID: ${userId}] ${request.method} ${request.url}`,
      );
    }

    response.status(status).json({
      statusCode: status,
      message,
      error:
        details ||
        (status === HttpStatus.INTERNAL_SERVER_ERROR
          ? 'Internal Server Error'
          : undefined),
      timestamp: new Date().toISOString(),
      path: request.url,
    });
  }
}
