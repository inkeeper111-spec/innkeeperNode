import { User, Hotel, Property, StaffProfile, SubscriptionPlan, Subscription } from '../models/index.js';
import { ROLES, HOTEL_STATUS, SUBSCRIPTION_STATUS } from '../config/constants.js';
import { logger } from '../config/logger.js';

const DEMO_PASSWORD = {
  super: 'AdminPassword123!',
  hotel: 'HotelPassword123!',
  staff: 'StaffPassword123!'
};

const upsertUser = async (data) => {
  let user = await User.findOne({ email: data.email.toLowerCase() }).select('+password');
  if (!user) {
    user = new User({ ...data, email: data.email.toLowerCase(), isActive: true, isEmailVerified: true });
  } else {
    user.name = data.name || user.name;
    user.role = data.role || user.role;
    user.hotelId = data.hotelId ?? user.hotelId;
    user.propertyId = data.propertyId ?? user.propertyId;
    user.isActive = true;
    user.password = data.password;
  }
  await user.save();
  return user;
};

const ensureStaffProfile = async (hotelId, user, extra = {}) => {
  const existing = await StaffProfile.findOne({ hotelId, userId: user._id });
  if (existing) return existing;
  const count = await StaffProfile.countDocuments({ hotelId });
  return StaffProfile.create({
    hotelId,
    userId: user._id,
    employeeId: extra.employeeId || `EMP-${String(count + 1001).padStart(4, '0')}`,
    department: extra.department || 'management',
    designation: extra.designation || user.role.replace(/_/g, ' '),
    salary: extra.salary || 0,
    basicSalary: extra.salary || 0,
    status: 'active'
  });
};

export const ensureDemoUsers = async () => {
  let starterPlan = await SubscriptionPlan.findOne({ code: 'starter' });
  if (!starterPlan) {
    starterPlan = await SubscriptionPlan.create({
      name: 'Starter Plan',
      code: 'starter',
      description: 'Starter',
      monthlyPrice: 49,
      annualPrice: 490,
      maxRooms: 25,
      maxUsers: 5,
      maxProperties: 1,
      enabledModules: ['rooms', 'reservations', 'guests', 'frontdesk', 'billing', 'housekeeping', 'restaurant', 'inventory', 'expenses', 'maintenance', 'reports'],
      aiUsageAllowance: 100
    });
  }

  const superAdmin = await upsertUser({
    name: 'Innkeeper Platform Admin',
    email: 'superadmin@grandstayhms.com',
    password: DEMO_PASSWORD.super,
    role: ROLES.SUPER_ADMIN,
    phone: '+1 (555) 019-2831'
  });

  let grandRegal = await Hotel.findOne({ slug: 'grand-regal' });
  if (!grandRegal) {
    grandRegal = await Hotel.create({
      name: 'The Grand Regal Hotel & Spa',
      slug: 'grand-regal',
      email: 'contact@grandregal.com',
      phone: '+1 (555) 392-1000',
      address: '742 Evergreen Terrace, Ocean Boulevard',
      city: 'Miami',
      state: 'Florida',
      country: 'United States',
      postalCode: '33139',
      status: HOTEL_STATUS.ACTIVE,
      currency: 'USD',
      currentPlanId: starterPlan._id,
      subscriptionStatus: SUBSCRIPTION_STATUS.ACTIVE
    });
  } else if (grandRegal.status !== HOTEL_STATUS.ACTIVE) {
    grandRegal.status = HOTEL_STATUS.ACTIVE;
    await grandRegal.save();
  }

  let regalProperty = await Property.findOne({ hotelId: grandRegal._id });
  if (!regalProperty) {
    regalProperty = await Property.create({
      hotelId: grandRegal._id,
      name: 'Grand Regal Main Ocean Resort',
      code: 'RESORT-1',
      address: grandRegal.address,
      city: grandRegal.city,
      state: grandRegal.state,
      country: grandRegal.country,
      phone: grandRegal.phone,
      isMainBranch: true,
      status: 'active'
    });
  }

  const sub = await Subscription.findOne({ hotelId: grandRegal._id });
  if (!sub) {
    await Subscription.create({
      hotelId: grandRegal._id,
      planId: starterPlan._id,
      status: SUBSCRIPTION_STATUS.ACTIVE,
      billingCycle: 'monthly',
      startDate: new Date(),
      endDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      amount: 149,
      paymentMethod: 'trial'
    });
  }

  const regalStaff = [
    { name: 'Eleanor Vance (General Manager)', email: 'admin@grandregal.com', password: DEMO_PASSWORD.hotel, role: ROLES.HOTEL_ADMIN, department: 'management', designation: 'General Manager', salary: 7500, employeeId: 'EMP-1001' },
    { name: 'Liam Gallagher (Front Desk Lead)', email: 'reception@grandregal.com', password: DEMO_PASSWORD.staff, role: ROLES.RECEPTIONIST, department: 'front_desk', designation: 'Head Receptionist', salary: 3800, employeeId: 'EMP-1002' },
    { name: 'Chef Marco Rossi (F&B Director)', email: 'chef@grandregal.com', password: DEMO_PASSWORD.staff, role: ROLES.RESTAURANT_STAFF, department: 'restaurant', designation: 'Executive Chef', salary: 5200, employeeId: 'EMP-1003' },
    { name: 'Maria Santos (Housekeeping Supervisor)', email: 'cleaning@grandregal.com', password: DEMO_PASSWORD.staff, role: ROLES.HOUSEKEEPING_STAFF, department: 'housekeeping', designation: 'Housekeeping Lead', salary: 3400, employeeId: 'EMP-1004' },
    { name: 'David Chen (Chief Engineer)', email: 'tech@grandregal.com', password: DEMO_PASSWORD.staff, role: ROLES.MAINTENANCE_STAFF, department: 'maintenance', designation: 'Senior Facility Technician', salary: 4100, employeeId: 'EMP-1005' }
  ];

  for (const member of regalStaff) {
    const user = await upsertUser({
      ...member,
      hotelId: grandRegal._id,
      propertyId: regalProperty._id
    });
    if (member.role === ROLES.HOTEL_ADMIN) {
      grandRegal.ownerId = user._id;
      await grandRegal.save();
    }
    await ensureStaffProfile(grandRegal._id, user, member);
  }

  const continental = await Hotel.findOne({ slug: 'continental-1', status: HOTEL_STATUS.ACTIVE });
  if (continental) {
    const continentalProperty = await Property.findOne({ hotelId: continental._id });
    const continentalAccounts = [
      { email: 'ranjithraja325@gmail.com', password: DEMO_PASSWORD.hotel, role: ROLES.HOTEL_ADMIN, name: 'RRR', department: 'management', designation: 'Hotel Super Admin', salary: 8000, employeeId: 'EMP-C001' },
      { email: 'frontdesk@continental.com', password: DEMO_PASSWORD.hotel, role: ROLES.HOTEL_ADMIN, name: 'Front Desk Continental', department: 'front_desk', designation: 'Front Office Manager', salary: 4200, employeeId: 'EMP-C002' },
      { email: 'receptionist@continental.com', password: DEMO_PASSWORD.staff, role: ROLES.RECEPTIONIST, name: 'Continental Reception', department: 'front_desk', designation: 'Receptionist', salary: 2800, employeeId: 'EMP-C003' }
    ];
    for (const member of continentalAccounts) {
      const user = await upsertUser({
        ...member,
        hotelId: continental._id,
        propertyId: continentalProperty?._id
      });
      await ensureStaffProfile(continental._id, user, member);
    }
  }

  logger.info('Demo and hotel login accounts verified.');
  return { superAdminId: superAdmin._id };
};
