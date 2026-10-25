import jwt from 'jsonwebtoken';

const getJwtSecret = () => process.env.JWT_SECRET || 'super_secret_jwt_key_change_in_production_grandstay_2026';
const getJwtRefreshSecret = () => process.env.JWT_REFRESH_SECRET || 'super_secret_refresh_jwt_key_change_in_production_grandstay_2026';

export const generateTokens = (user) => {
  const payload = {
    id: user._id,
    role: user.role,
    hotelId: user.hotelId,
    propertyId: user.propertyId,
    email: user.email,
    name: user.name
  };

  const accessToken = jwt.sign(payload, getJwtSecret(), {
    expiresIn: process.env.JWT_EXPIRES_IN || '1h'
  });

  const refreshToken = jwt.sign({ id: user._id }, getJwtRefreshSecret(), {
    expiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '7d'
  });

  return { accessToken, refreshToken };
};

export const verifyRefreshToken = (token) => {
  return jwt.verify(token, getJwtRefreshSecret());
};

