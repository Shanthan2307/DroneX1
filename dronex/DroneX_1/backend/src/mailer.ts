// Where sign-in and deletion codes go. Development prints them; plug a real
// provider (SMTP, Resend, SES...) in behind the same interface.

export interface Mailer {
  send(to: string, subject: string, text: string): Promise<void>;
}

export const consoleMailer: Mailer = {
  async send(to, subject, text) {
    console.log(`[mail] to=${to} subject="${subject}"\n${text}`);
  },
};

/** Keeps what was sent, for tests. */
export class MemoryMailer implements Mailer {
  sent: { to: string; subject: string; text: string }[] = [];
  async send(to: string, subject: string, text: string) {
    this.sent.push({ to, subject, text });
  }
  /** The last 6-digit code sent to `to`. */
  codeFor(to: string): string | undefined {
    const mail = this.sent.findLast((m) => m.to === to);
    return mail?.text.match(/\b\d{6}\b/)?.[0];
  }
}
