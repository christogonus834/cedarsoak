import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { Request, Response } from 'express';

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const isHttpException = exception instanceof HttpException;
    const status = isHttpException
      ? exception.getStatus()
      : HttpStatus.INTERNAL_SERVER_ERROR;

    const message = isHttpException
      ? exception.getResponse()
      : 'An unexpected error occurred. Please try again.';

    // Log full detail server-side (structured, ready to ship to a log aggregator).
    // Never send stack traces or raw error objects to the client — that's an
    // information-disclosure risk (schema names, file paths, library versions).
    if (!isHttpException) {
      // eslint-disable-next-line no-console
      console.error('UNHANDLED EXCEPTION', {
        path: request.url,
        method: request.method,
        error: exception,
      });
    }

    response.status(status).json({
      statusCode: status,
      path: request.url,
      timestamp: new Date().toISOString(),
      message: typeof message === 'string' ? message : (message as any).message ?? message,
    });
  }
}
