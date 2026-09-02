import {
  Body,
  Controller,
  Post,
  Get,
  Req,
  Res,
  Inject,
  ForbiddenException,
  UnauthorizedException,
  UseGuards,
  HttpCode,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Request, Response } from 'express';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { CONFIG, Configuration } from '../config';
import { opaqueToken } from './password';
import { AuthService } from './auth.service';
import { AuthGuard, AuthRequest } from './auth.guard';
import { EmailDto, LoginDto, RegisterDto, ResetDto, TokenDto } from './dto';
import { IdentityRateLimit } from './rate-limit';

@ApiTags('Identity')
@Controller('api/v1/auth')
export class AuthController {
  private readonly csrfKey = opaqueToken();
  constructor(
    private readonly auth: AuthService,
    private readonly limit: IdentityRateLimit,
    @Inject(CONFIG) private readonly config: Configuration,
  ) {}
  private origin(req: Request): void {
    if (
      req.headers.origin !== this.config.CORS_ORIGIN &&
      !(req.headers.origin === undefined && req.headers['sec-fetch-site'] === 'same-origin')
    )
      throw new ForbiddenException();
  }
  private cookie(req: Request): string {
    const token = req.headers.cookie
      ?.split(';')
      .map((x) => x.trim())
      .find((x) => x.startsWith('melissa_refresh='))
      ?.slice(16);
    if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw new UnauthorizedException();
    return token;
  }
  private csrf(token: string): string {
    return createHmac('sha256', this.config.JWT_SECRET ?? this.csrfKey)
      .update(token)
      .digest('hex');
  }
  private send(res: Response, result: { access_token: string; refresh: string }) {
    res.cookie('melissa_refresh', result.refresh, {
      httpOnly: true,
      secure: this.config.CORS_ORIGIN.startsWith('https:'),
      sameSite: 'strict',
      path: '/api/v1/auth',
      maxAge: 30 * 86400000,
    });
    res.setHeader('Cache-Control', 'no-store');
    return {
      access_token: result.access_token,
      csrf_token: this.csrf(result.refresh),
      expires_in: 600,
    };
  }
  @Post('register')
  @HttpCode(202)
  async register(@Body() body: RegisterDto, @Req() req: Request) {
    this.origin(req);
    await this.limit.check(req.ip ?? '', body.email);
    await this.auth.register(body);
    return { accepted: true };
  }
  @Post('login')
  @HttpCode(200)
  async login(
    @Body() body: LoginDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    this.origin(req);
    await this.limit.check(req.ip ?? '', body.email);
    return this.send(res, await this.auth.login(body.email, body.password));
  }
  @Get('csrf')
  csrfToken(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    this.origin(req);
    res.setHeader('Cache-Control', 'no-store');
    return { csrf_token: this.csrf(this.cookie(req)) };
  }
  @Post('refresh')
  @HttpCode(200)
  async refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    this.origin(req);
    await this.limit.check(req.ip ?? '');
    const token = this.cookie(req);
    const supplied = req.headers['x-csrf-token'];
    const expected = this.csrf(token);
    if (
      typeof supplied !== 'string' ||
      !/^[a-f0-9]{64}$/.test(supplied) ||
      !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))
    )
      throw new ForbiddenException();
    return this.send(res, await this.auth.refresh(token));
  }
  @Post('logout')
  @HttpCode(204)
  @UseGuards(AuthGuard)
  @ApiBearerAuth()
  async logout(@Req() req: AuthRequest, @Res({ passthrough: true }) res: Response) {
    await this.auth.logout(req.actor);
    res.clearCookie('melissa_refresh', { path: '/api/v1/auth' });
  }
  @Get('me')
  @UseGuards(AuthGuard)
  @ApiBearerAuth()
  me(@Req() req: AuthRequest) {
    return this.auth.me(req.actor);
  }
  @Post('verify')
  @HttpCode(204)
  async verify(@Body() body: TokenDto, @Req() req: Request) {
    this.origin(req);
    await this.limit.check(req.ip ?? '');
    await this.auth.consume(body.token, 'verify');
  }
  @Post('resend-verification')
  @HttpCode(202)
  async resend(@Body() body: EmailDto, @Req() req: Request) {
    this.origin(req);
    await this.limit.check(req.ip ?? '', body.email);
    await this.auth.requestToken(body.email, 'verify');
    return { accepted: true };
  }
  @Post('forgot-password')
  @HttpCode(202)
  async forgot(@Body() body: EmailDto, @Req() req: Request) {
    this.origin(req);
    await this.limit.check(req.ip ?? '', body.email);
    await this.auth.requestToken(body.email, 'reset');
    return { accepted: true };
  }
  @Post('reset-password')
  @HttpCode(204)
  async reset(@Body() body: ResetDto, @Req() req: Request) {
    this.origin(req);
    await this.limit.check(req.ip ?? '');
    await this.auth.consume(body.token, 'reset', body.password);
  }
}
