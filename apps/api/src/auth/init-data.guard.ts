import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { InitDataService } from './init-data.service';

@Injectable()
export class InitDataGuard implements CanActivate {
  constructor(private readonly initDataService: InitDataService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context
      .switchToHttp()
      .getRequest<{ headers: Record<string, string>; user?: unknown }>();
    const authHeader = request.headers.authorization;

    if (!authHeader || !authHeader.startsWith('InitData ')) {
      throw new UnauthorizedException('Missing InitData authorization header');
    }

    const initData = authHeader.slice('InitData '.length);
    request.user = this.initDataService.validate(initData);
    return true;
  }
}
