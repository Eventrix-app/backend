import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Observable, throwError } from 'rxjs';
import { tap, catchError } from 'rxjs/operators';
import { Request, Response } from 'express';
import * as jwt from 'jsonwebtoken';

@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger('HTTP');

  constructor(private readonly configService: ConfigService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    // This interceptor is registered globally (APP_INTERCEPTOR), so it also fires for WS
    // gateway handlers — those have no Express request/response to log in this shape.
    if (context.getType() !== 'http') {
      return next.handle();
    }

    const ctx = context.switchToHttp();
    const request = ctx.getRequest<Request>();
    const response = ctx.getResponse<Response>();

    const startTime = Date.now();
    // Unique ID for request correlation
    const requestId = Math.random().toString(36).substring(2, 10).toUpperCase();

    // Identify User Type (role) and payload from the bearer token (if any). We do not
    // verify the signature here — log enrichment only. The guard enforces auth.
    let userType = 'guest';
    let userId = 'N/A';
    let userEmail = 'N/A';

    const authHeader = request.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.split(' ')[1];
      try {
        const decoded = jwt.decode(token) as any;
        if (decoded && typeof decoded === 'object') {
          userType = Array.isArray(decoded.roles) && decoded.roles.length ? decoded.roles[0] : 'user';
          userId = decoded.id || 'unknown';
          userEmail = decoded.email || 'unknown';
        } else {
          userType = 'invalid_token';
        }
      } catch {
        userType = 'invalid_token';
      }
    }

    const method = request.method;
    const url = request.originalUrl || request.url;
    const ip =
      request.ip ||
      request.headers['x-forwarded-for'] ||
      request.socket.remoteAddress;

    // Mask sensitive details in request body
    const maskedBody = this.maskSensitiveData(request.body);
    const queryStr = Object.keys(request.query || {}).length
      ? ` | Query: ${JSON.stringify(request.query)}`
      : '';
    const bodyStr = Object.keys(maskedBody || {}).length
      ? ` | Body: ${JSON.stringify(maskedBody)}`
      : '';

    this.logger.log(
      `[Request] [${requestId}] [UserType: ${userType}] [UserEmail: ${userEmail}] [UserID: ${userId}] [IP: ${ip}] ${method} ${url}${queryStr}${bodyStr}`,
    );

    return next.handle().pipe(
      tap((data) => {
        const duration = Date.now() - startTime;
        const statusCode = response.statusCode;

        // Mask response data as well to prevent credentials leakage
        const maskedData = this.maskSensitiveData(data);
        const responseStr = maskedData
          ? ` | ResponseData: ${JSON.stringify(maskedData)}`
          : '';

        this.logger.log(
          `[Response] [${requestId}] [UserType: ${userType}] [UserEmail: ${userEmail}] [UserID: ${userId}] ${method} ${url} - Status: ${statusCode} - Duration: ${duration}ms${responseStr}`,
        );
      }),
      catchError((error) => {
        const duration = Date.now() - startTime;
        const statusCode = error.status || error.statusCode || 500;
        const errorMessage = error.message || 'Internal server error';

        this.logger.error(
          `[Error] [${requestId}] [UserType: ${userType}] [UserEmail: ${userEmail}] [UserID: ${userId}] ${method} ${url} - Status: ${statusCode} - Duration: ${duration}ms - Message: ${errorMessage}`,
        );
        return throwError(() => error);
      }),
    );
  }

  private maskSensitiveData(data: any): any {
    if (!data) return data;
    if (typeof data !== 'object') return data;

    // Matched as case-insensitive *substrings*, not exact keys. The previous exact-match list
    // held 'password' but not 'currentPassword' or 'newPassword', and both are real fields on
    // DTOs this interceptor logs (UpdateParticipantDto, the change-password and erase-my-data
    // routes) — so plaintext passwords were being written to the request log. Same gap let
    // 'otp' through on password reset, and 'accountNumber'/'ifscCode' through on payout setup,
    // which is a full bank account number in a log line the UI is not even allowed to render.
    //
    // Substring matching over-masks rather than under-masks by design: masking one extra
    // field costs a log line some detail, missing one leaks a credential.
    const sensitivePatterns = [
      'password',
      'secret',
      'token',
      'otp',
      'accountnumber',
      'accountholder',
      'ifsc',
      'cvv',
      'authorization',
      'apikey',
      'api_key',
    ];

    // Perform deep copy for safety, avoiding mutation of actual request/response payload reference
    const masked = Array.isArray(data) ? [...data] : { ...data };

    for (const key of Object.keys(masked)) {
      const normalized = key.toLowerCase();
      if (sensitivePatterns.some((pattern) => normalized.includes(pattern))) {
        masked[key] = '********';
      } else if (typeof masked[key] === 'object' && masked[key] !== null) {
        masked[key] = this.maskSensitiveData(masked[key]);
      }
    }
    return masked;
  }
}
