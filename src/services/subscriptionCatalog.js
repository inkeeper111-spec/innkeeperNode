import { SubscriptionModule, SubscriptionSettings } from '../models/index.js';

export const SUBSCRIPTION_MODULE_CATALOG = [
  ['dashboard', 'Hotel Dashboard'],
  ['frontdesk', 'Front Desk'],
  ['rooms', 'Rooms & Room Types'],
  ['reservations', 'Reservations'],
  ['guests', 'Guests'],
  ['billing', 'Billing'],
  ['housekeeping', 'Housekeeping'],
  ['restaurant', 'Restaurant & POS'],
  ['inventory', 'Inventory'],
  ['expenses', 'Expenses'],
  ['maintenance', 'Maintenance'],
  ['staff', 'Staff & Attendance'],
  ['reports', 'Reports'],
  ['ai_assistant', 'AI Assistant'],
  ['notifications', 'Notifications'],
  ['settings', 'Hotel Settings']
].map(([key, name]) => ({ key, name }));

export const ensureSubscriptionCatalog = async () => {
  await Promise.all(SUBSCRIPTION_MODULE_CATALOG.map(({ key, name }) => SubscriptionModule.updateOne(
    { key },
    { $setOnInsert: { key, name, description: '', monthlyPrice: 0, annualPrice: 0, enabled: true } },
    { upsert: true }
  )));
  await SubscriptionSettings.updateOne(
    { key: 'global' },
    { $setOnInsert: { key: 'global', minimumMonthlyAmount: 999 } },
    { upsert: true }
  );
};
