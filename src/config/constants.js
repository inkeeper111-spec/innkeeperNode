export const ROLES = {
  SUPER_ADMIN: 'super_admin',
  HOTEL_ADMIN: 'hotel_admin',
  RECEPTIONIST: 'receptionist',
  RESTAURANT_STAFF: 'restaurant_staff',
  HOUSEKEEPING_STAFF: 'housekeeping_staff',
  MAINTENANCE_STAFF: 'maintenance_staff',
  GUEST: 'guest'
};

export const HOTEL_STATUS = {
  PENDING_APPROVAL: 'pending_approval',
  ACTIVE: 'active',
  SUSPENDED: 'suspended',
  REJECTED: 'rejected'
};

export const SUBSCRIPTION_STATUS = {
  TRIALING: 'trialing',
  ACTIVE: 'active',
  PAST_DUE: 'past_due',
  CANCELED: 'canceled',
  EXPIRED: 'expired'
};

export const ROOM_STATUS = {
  AVAILABLE: 'available',
  OCCUPIED: 'occupied',
  RESERVED: 'reserved',
  OUT_OF_SERVICE: 'out_of_service'
};

export const HOUSEKEEPING_STATUS = {
  CLEAN: 'clean',
  DIRTY: 'dirty',
  CLEANING_IN_PROGRESS: 'cleaning_in_progress',
  INSPECTED: 'inspected'
};

export const RESERVATION_STATUS = {
  PENDING: 'pending',
  CONFIRMED: 'confirmed',
  CHECKED_IN: 'checked_in',
  CHECKED_OUT: 'checked_out',
  CANCELLED: 'cancelled',
  NO_SHOW: 'no_show'
};

export const PAYMENT_STATUS = {
  UNPAID: 'unpaid',
  PARTIALLY_PAID: 'partially_paid',
  PAID: 'paid',
  REFUNDED: 'refunded'
};

export const PAYMENT_METHODS = {
  RAZORPAY: 'razorpay',
  CASH: 'cash',
  CARD: 'card',
  UPI: 'upi',
  BANK_TRANSFER: 'bank_transfer'
};

export const INVOICE_STATUS = {
  DRAFT: 'draft',
  ISSUED: 'issued',
  PAID: 'paid',
  PARTIALLY_PAID: 'partially_paid',
  VOIDED: 'voided',
  REFUNDED: 'refunded'
};

export const FOOD_ORDER_STATUS = {
  PENDING: 'pending',
  ACCEPTED: 'accepted',
  PREPARING: 'preparing',
  READY: 'ready',
  SERVED: 'served',
  CANCELLED: 'cancelled'
};

export const MAINTENANCE_STATUS = {
  OPEN: 'open',
  ASSIGNED: 'assigned',
  IN_PROGRESS: 'in_progress',
  ON_HOLD: 'on_hold',
  RESOLVED: 'resolved',
  CLOSED: 'closed'
};

export const PRIORITY = {
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high',
  CRITICAL: 'critical'
};

