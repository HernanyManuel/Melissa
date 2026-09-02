import { Inject, Injectable } from '@nestjs/common';
import nodemailer from 'nodemailer';
import { CONFIG, Configuration } from '../config';

@Injectable()
export class IdentityMail {
  constructor(@Inject(CONFIG) private readonly config: Configuration) {}
  async send(email: string, purpose: string, token: string, tenantId?: string): Promise<void> {
    const link = new URL(this.config.CORS_ORIGIN);
    link.hash = `/account?action=${purpose}&token=${encodeURIComponent(token)}${tenantId ? `&tenant=${tenantId}` : ''}`;
    // Development uses Mailpit. Never print authentication links/tokens in logs.
    const transport = nodemailer.createTransport({
      host: this.config.SMTP_HOST,
      port: this.config.SMTP_PORT,
      secure: false,
      connectionTimeout: 5000,
      socketTimeout: 5000,
    });
    await transport.sendMail({
      from: 'Melissa <no-reply@melissa.local>',
      to: email,
      subject: `Melissa — ${purpose}`,
      text: `Melissa\n\n${link.toString()}\n\nIf you did not request this message, ignore it.`,
    });
    transport.close();
  }
}
