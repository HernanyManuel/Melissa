import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Request } from 'express';
import { Actor, AuthService } from './auth.service';
export interface AuthRequest extends Request {
  actor: Actor;
}
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly auth: AuthService) {}
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthRequest>();
    request.actor = await this.auth.authenticate(request.headers.authorization);
    return true;
  }
}
