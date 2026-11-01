const PHONE_FORMAT = /^\+\d{1,3} - \d+$/;

const getValue = (object, path) => path.split('.').reduce((value, key) => value?.[key], object);

export const validatePhoneFields = (...fields) => (req, res, next) => {
  for (const { path, required = false } of fields) {
    const value = getValue(req.body, path);
    if (value === undefined || value === null || value === '') {
      if (required) {
        return res.status(400).json({
          success: false,
          message: `${path} is required and must include a country calling code.`
        });
      }
      continue;
    }

    const digitCount = typeof value === 'string' ? value.replace(/\D/g, '').length : 0;
    if (!PHONE_FORMAT.test(value) || digitCount < 10 || digitCount > 15) {
      return res.status(400).json({
        success: false,
        message: `${path} must use the format +<country code> - <number> and contain 10 to 15 digits.`
      });
    }
  }

  next();
};
