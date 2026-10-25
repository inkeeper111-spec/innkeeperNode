import crypto from 'crypto';

export const generateReference = (prefix = 'REF') => {
  const year = new Date().getFullYear();
  const random = crypto.randomBytes(3).toString('hex').toUpperCase();
  return `${prefix}-${year}-${random}`;
};

