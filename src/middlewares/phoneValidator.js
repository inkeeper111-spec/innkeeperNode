const PHONE_FORMAT = /^\+\d{1,3} - \d+$/;
const PHONE_VALIDATION_MESSAGE = 'Digits only; the full number including country code must be 10 to 15 digits.';

const getValue = (object, path) => path.split('.').reduce((value, key) => value?.[key], object);

export const validatePhoneFields = (...fields) => (req, res, next) => {
  for (const { path, required = false } of fields) {
    const value = getValue(req.body, path);
    if (value === undefined || value === null || value === '') {
      if (required) {
        return res.status(400).json({
          success: false,
          message: PHONE_VALIDATION_MESSAGE
        });
      }
      continue;
    }

    const digitCount = typeof value === 'string' ? value.replace(/\D/g, '').length : 0;
    if (!PHONE_FORMAT.test(value) || digitCount < 10 || digitCount > 15) {
      return res.status(400).json({
        success: false,
        message: PHONE_VALIDATION_MESSAGE
      });
    }
  }

  next();
};
