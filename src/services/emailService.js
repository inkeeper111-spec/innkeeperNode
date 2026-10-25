import nodemailer from 'nodemailer';
import { logger } from '../config/logger.js';

let transporter = null;

const getTransporter = () => {
  if (!transporter) {
    if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_USER !== 'test_user') {
      transporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: parseInt(process.env.SMTP_PORT || '587'),
        secure: process.env.SMTP_PORT === '465',
        auth: {
          user: process.env.SMTP_USER,
          pass: process.env.SMTP_PASS
        }
      });
    } else {
      // Mock logger transport for testing & local zero-config
      transporter = {
        sendMail: async (options) => {
          logger.info(`[Email Service Simulation] To: ${options.to} | Subject: ${options.subject}`);
          return { messageId: 'simulated-' + Date.now() };
        }
      };
    }
  }
  return transporter;
};

export const sendEmail = async ({ to, subject, html, text }) => {
  try {
    const client = getTransporter();
    const info = await client.sendMail({
      from: process.env.EMAIL_FROM || '"Innkeeper" <noreply@innkeeper.com>',
      to,
      subject,
      text,
      html
    });
    return info;
  } catch (error) {
    logger.error('Failed to send email:', error);
    // Do not throw - fail-safe so business process continues
    return null;
  }
};

