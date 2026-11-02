import { describe, expect, it, vi } from 'vitest';
import { validatePhoneFields } from '../middlewares/phoneValidator.js';

const runValidator = (body, ...fields) => {
  const req = { body };
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn()
  };
  const next = vi.fn();
  validatePhoneFields(...fields)(req, res, next);
  return { res, next };
};

describe('validatePhoneFields', () => {
  it('accepts a country code and 10 to 15 total digits', () => {
    const { next, res } = runValidator(
      { guestData: { phone: '+91 - 123456789' } },
      { path: 'guestData.phone', required: true }
    );

    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('rejects alphabetic and formatted legacy phone values', () => {
    const { next, res } = runValidator(
      { phone: '+1 (555) ABC-1234' },
      { path: 'phone', required: true }
    );

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      message: 'Digits only; the full number including country code must be 10 to 15 digits.'
    });
  });

  it('uses the same validation message when a required phone number is missing', () => {
    const { next, res } = runValidator({}, { path: 'phone', required: true });

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      message: 'Digits only; the full number including country code must be 10 to 15 digits.'
    });
  });

  it('allows an omitted optional phone field', () => {
    const { next, res } = runValidator({}, { path: 'phone' });

    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });
});
