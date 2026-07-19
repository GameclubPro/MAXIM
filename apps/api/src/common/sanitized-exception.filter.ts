import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { sanitizeErrorForLogs } from './log-error.util';

@Catch()
export class SanitizedExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(SanitizedExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const response = http.getResponse<FastifyReply>();
    const request = http.getRequest<FastifyRequest>();
    const statusCode = exception instanceof HttpException ? exception.getStatus() : 500;

    if (!(exception instanceof HttpException)) {
      this.logger.error(
        {
          err: sanitizeErrorForLogs(exception),
          method: request?.method,
          url: request?.url,
        },
        'Unhandled HTTP exception',
      );
    }

    response.status(statusCode).send(this.buildResponseBody(exception, statusCode));
  }

  private buildResponseBody(exception: unknown, statusCode: number): unknown {
    if (exception instanceof HttpException) {
      const response = exception.getResponse();
      return typeof response === 'string' ? { statusCode, message: response } : response;
    }

    return {
      statusCode,
      message: 'Internal server error',
    };
  }
}
