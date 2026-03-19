import { createParamDecorator, type ExecutionContext } from '@nestjs/common';

export type AuthUser = {
  userId: string;
  username: string | null;
  displayName: string | null;
  avatarUrl?: string | null;
  chatId?: string;
  chatTitle?: string | null;
};

export const CurrentUser = createParamDecorator((_data: unknown, ctx: ExecutionContext): AuthUser => {
  const request = ctx.switchToHttp().getRequest<{ user: AuthUser }>();
  return request.user;
});
