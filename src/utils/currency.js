const getLocale = (currency) => currency === 'INR' ? 'en-IN' : 'en-US';

export const formatCurrency = (amount, currency = 'USD') => {
  const numericAmount = Number(amount);
  try {
    return new Intl.NumberFormat(getLocale(currency), {
      style: 'currency',
      currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    }).format(Number.isFinite(numericAmount) ? numericAmount : 0);
  } catch {
    return `${currency} ${Number.isFinite(numericAmount) ? numericAmount.toFixed(2) : '0.00'}`;
  }
};
