import nodemailer from "nodemailer";

// Plain SMTP — nodemailer handles the actual protocol (AUTH, TLS
// negotiation), which isn't worth hand-rolling over raw sockets. Env-var
// configured; nothing here is Command-Center-specific.
function getTransport() {
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT ?? 587),
    secure: process.env.SMTP_SECURE === "true",
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD },
  });
}

export interface EmailAttachment {
  filename: string;
  content: Buffer;
  contentType?: string;
}

export async function sendEmail(to: string, subject: string, html: string, attachments?: EmailAttachment[]): Promise<void> {
  const transport = getTransport();
  await transport.sendMail({
    from: process.env.SMTP_FROM ?? process.env.SMTP_USER,
    to,
    subject,
    html,
    attachments,
  });
}
