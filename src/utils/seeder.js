import 'dotenv/config';
import { connectDB, closeDB } from '../config/db.js';
import {
  User, Hotel, Property, SubscriptionPlan, Subscription,
  RoomType, Room, Guest, Reservation, Invoice, Payment,
  HousekeepingTask, MenuCategory, MenuItem, FoodOrder,
  InventoryItem, StockMovement, Vendor, Expense,
  StaffProfile, Shift, Attendance, AttendanceLocationAudit, MaintenanceTicket, Notification
} from '../models/index.js';
import {
  ROLES, HOTEL_STATUS, SUBSCRIPTION_STATUS,
  ROOM_STATUS, HOUSEKEEPING_STATUS, RESERVATION_STATUS,
  PAYMENT_STATUS, INVOICE_STATUS, FOOD_ORDER_STATUS,
  MAINTENANCE_STATUS, PRIORITY
} from '../config/constants.js';
import { logger } from '../config/logger.js';

export const seedDatabase = async () => {
  logger.info('Starting database seeding...');

  // Clear existing collections
  await Promise.all([
    User.deleteMany({}),
    Hotel.deleteMany({}),
    Property.deleteMany({}),
    SubscriptionPlan.deleteMany({}),
    Subscription.deleteMany({}),
    RoomType.deleteMany({}),
    Room.deleteMany({}),
    Guest.deleteMany({}),
    Reservation.deleteMany({}),
    Invoice.deleteMany({}),
    Payment.deleteMany({}),
    HousekeepingTask.deleteMany({}),
    MenuCategory.deleteMany({}),
    MenuItem.deleteMany({}),
    FoodOrder.deleteMany({}),
    InventoryItem.deleteMany({}),
    StockMovement.deleteMany({}),
    Vendor.deleteMany({}),
    Expense.deleteMany({}),
    StaffProfile.deleteMany({}),
    Shift.deleteMany({}),
    Attendance.deleteMany({}),
    AttendanceLocationAudit.deleteMany({}),
    MaintenanceTicket.deleteMany({}),
    Notification.deleteMany({})
  ]);

  // 1. Subscription Plans
  const starterPlan = await SubscriptionPlan.create({
    name: 'Starter Plan',
    code: 'starter',
    description: 'Perfect for small boutique hotels and bed & breakfasts',
    monthlyPrice: 49,
    annualPrice: 490,
    maxRooms: 25,
    maxUsers: 5,
    maxProperties: 1,
    enabledModules: ['rooms', 'reservations', 'guests', 'frontdesk', 'billing', 'housekeeping', 'restaurant', 'inventory', 'expenses', 'maintenance', 'reports'],
    aiUsageAllowance: 100,
    supportLevel: 'standard'
  });

  const proPlan = await SubscriptionPlan.create({
    name: 'Professional Plan',
    code: 'professional',
    description: 'Ideal for full-service luxury hotels and resorts',
    monthlyPrice: 149,
    annualPrice: 1490,
    maxRooms: 100,
    maxUsers: 25,
    maxProperties: 3,
    enabledModules: ['rooms', 'reservations', 'guests', 'frontdesk', 'billing', 'housekeeping', 'restaurant', 'inventory', 'expenses', 'maintenance', 'reports', 'ai_assistant'],
    aiUsageAllowance: 1000,
    supportLevel: 'dedicated_24_7'
  });

  // 2. Super Admin User
  const superAdmin = await User.create({
    name: 'Innkeeper Platform Admin',
    email: 'superadmin@grandstayhms.com',
    password: 'AdminPassword123!',
    role: ROLES.SUPER_ADMIN,
    phone: '+1 (555) 019-2831',
    isActive: true,
    isEmailVerified: true
  });

  // 3. Demo Hotel: The Grand Regal Hotel & Spa
  const grandRegal = await Hotel.create({
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
    taxNumber: 'US-TAX-893201',
    currency: 'USD',
    timezone: 'America/New_York',
    checkInTime: '15:00',
    checkOutTime: '11:00',
    cancellationPolicy: 'Full refund 48 hours prior to check-in. One night charged thereafter.',
    invoicePrefix: 'REGAL',
    currentPlanId: proPlan._id,
    subscriptionStatus: SUBSCRIPTION_STATUS.ACTIVE
  });

  const mainProperty = await Property.create({
    hotelId: grandRegal._id,
    name: 'Grand Regal Main Ocean Resort',
    code: 'RESORT-1',
    address: '742 Evergreen Terrace, Ocean Boulevard',
    city: 'Miami',
    state: 'Florida',
    country: 'United States',
    phone: '+1 (555) 392-1000',
    isMainBranch: true,
    status: 'active'
  });

  // Subscription record for demo hotel
  await Subscription.create({
    hotelId: grandRegal._id,
    planId: proPlan._id,
    status: SUBSCRIPTION_STATUS.ACTIVE,
    billingCycle: 'monthly',
    startDate: new Date(),
    endDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    amount: 149,
    paymentMethod: 'razorpay'
  });

  // 4. Hotel Users & Staff
  const hotelAdmin = await User.create({
    name: 'Eleanor Vance (General Manager)',
    email: 'admin@grandregal.com',
    password: 'HotelPassword123!',
    role: ROLES.HOTEL_ADMIN,
    hotelId: grandRegal._id,
    propertyId: mainProperty._id,
    phone: '+1 (555) 392-1001',
    isActive: true,
    isEmailVerified: true
  });

  grandRegal.ownerId = hotelAdmin._id;
  await grandRegal.save();

  const receptionist = await User.create({
    name: 'Liam Gallagher (Front Desk Lead)',
    email: 'reception@grandregal.com',
    password: 'StaffPassword123!',
    role: ROLES.RECEPTIONIST,
    hotelId: grandRegal._id,
    propertyId: mainProperty._id,
    phone: '+1 (555) 392-1002',
    isActive: true,
    isEmailVerified: true
  });

  const restaurantStaff = await User.create({
    name: 'Chef Marco Rossi (F&B Director)',
    email: 'chef@grandregal.com',
    password: 'StaffPassword123!',
    role: ROLES.RESTAURANT_STAFF,
    hotelId: grandRegal._id,
    propertyId: mainProperty._id,
    phone: '+1 (555) 392-1003',
    isActive: true,
    isEmailVerified: true
  });

  const housekeepingStaff = await User.create({
    name: 'Maria Santos (Housekeeping Supervisor)',
    email: 'cleaning@grandregal.com',
    password: 'StaffPassword123!',
    role: ROLES.HOUSEKEEPING_STAFF,
    hotelId: grandRegal._id,
    propertyId: mainProperty._id,
    phone: '+1 (555) 392-1004',
    isActive: true,
    isEmailVerified: true
  });

  const maintenanceStaff = await User.create({
    name: 'David Chen (Chief Engineer)',
    email: 'tech@grandregal.com',
    password: 'StaffPassword123!',
    role: ROLES.MAINTENANCE_STAFF,
    hotelId: grandRegal._id,
    propertyId: mainProperty._id,
    phone: '+1 (555) 392-1005',
    isActive: true,
    isEmailVerified: true
  });

  // Create Staff Profiles
  await StaffProfile.create([
    {
      hotelId: grandRegal._id,
      userId: hotelAdmin._id,
      employeeId: 'EMP-1001',
      department: 'management',
      designation: 'General Manager',
      salary: 7500
    },
    {
      hotelId: grandRegal._id,
      userId: receptionist._id,
      employeeId: 'EMP-1002',
      department: 'front_desk',
      designation: 'Head Receptionist',
      salary: 3800
    },
    {
      hotelId: grandRegal._id,
      userId: restaurantStaff._id,
      employeeId: 'EMP-1003',
      department: 'restaurant',
      designation: 'Executive Chef & F&B Manager',
      salary: 5200
    },
    {
      hotelId: grandRegal._id,
      userId: housekeepingStaff._id,
      employeeId: 'EMP-1004',
      department: 'housekeeping',
      designation: 'Housekeeping Lead',
      salary: 3400
    },
    {
      hotelId: grandRegal._id,
      userId: maintenanceStaff._id,
      employeeId: 'EMP-1005',
      department: 'maintenance',
      designation: 'Senior Facility Technician',
      salary: 4100
    }
  ]);

  // 5. Room Categories
  const deluxeKing = await RoomType.create({
    hotelId: grandRegal._id,
    propertyId: mainProperty._id,
    name: 'Deluxe Ocean King Suite',
    code: 'DKS',
    description: 'Breathtaking ocean views with plush king bed, private balcony, and marble bathroom.',
    maxOccupancy: 3,
    adultCapacity: 2,
    childCapacity: 1,
    bedConfiguration: '1 California King Bed',
    basePrice: 280,
    extraGuestPrice: 50,
    amenities: ['Oceanfront Balcony', 'High-Speed Wi-Fi', 'Smart TV 65"', 'Nespresso Coffee Bar', 'Bathtub & Rain Shower', 'Minibar'],
    images: ['https://images.unsplash.com/photo-1591088398332-8a7791972843?auto=format&fit=crop&w=1000&q=80']
  });

  const executiveDouble = await RoomType.create({
    hotelId: grandRegal._id,
    propertyId: mainProperty._id,
    name: 'Executive Double Queen Room',
    code: 'EDQ',
    description: 'Spacious guestroom with two queen beds, work desk, and luxury city skyline view.',
    maxOccupancy: 4,
    adultCapacity: 2,
    childCapacity: 2,
    bedConfiguration: '2 Queen Beds',
    basePrice: 220,
    extraGuestPrice: 40,
    amenities: ['Ergonomic Workspace', 'High-Speed Wi-Fi', 'Smart TV 55"', 'Complimentary Bottled Water', 'Walk-in Shower'],
    images: ['https://images.unsplash.com/photo-1566665797739-1674de7a421a?auto=format&fit=crop&w=1000&q=80']
  });

  const penthouse = await RoomType.create({
    hotelId: grandRegal._id,
    propertyId: mainProperty._id,
    name: 'Presidential Sky Penthouse',
    code: 'PSP',
    description: 'Top floor luxury penthouse with panoramic wraparound ocean terrace, jacuzzi, and dedicated butler service.',
    maxOccupancy: 6,
    adultCapacity: 4,
    childCapacity: 2,
    bedConfiguration: '2 King Beds + Sofa Bed',
    basePrice: 650,
    extraGuestPrice: 100,
    amenities: ['Private Jacuzzi', 'Wraparound Ocean Terrace', 'Butler Service', 'Cocktail Bar', 'Dual Rain Showers', 'Private Elevator Access'],
    images: ['https://images.unsplash.com/photo-1582719478250-c89cae4dc85b?auto=format&fit=crop&w=1000&q=80']
  });

  const standardQueen = await RoomType.create({
    hotelId: grandRegal._id,
    propertyId: mainProperty._id,
    name: 'Classic Coastal Queen',
    code: 'CCQ',
    description: 'Cozy coastal sanctuary designed for rest, featuring custom linens and artisan bath products.',
    maxOccupancy: 2,
    adultCapacity: 2,
    childCapacity: 0,
    bedConfiguration: '1 Queen Bed',
    basePrice: 160,
    extraGuestPrice: 30,
    amenities: ['High-Speed Wi-Fi', 'Designer Linens', 'Organic Toiletries', 'LED Ambient Lighting'],
    images: ['https://images.unsplash.com/photo-1618773928121-c32242e63f39?auto=format&fit=crop&w=1000&q=80']
  });

  // 6. Rooms
  const roomsData = [
    { roomNumber: '101', floor: '1', roomTypeId: standardQueen._id, roomStatus: ROOM_STATUS.AVAILABLE, housekeepingStatus: HOUSEKEEPING_STATUS.CLEAN },
    { roomNumber: '102', floor: '1', roomTypeId: standardQueen._id, roomStatus: ROOM_STATUS.AVAILABLE, housekeepingStatus: HOUSEKEEPING_STATUS.CLEAN },
    { roomNumber: '201', floor: '2', roomTypeId: executiveDouble._id, roomStatus: ROOM_STATUS.OCCUPIED, housekeepingStatus: HOUSEKEEPING_STATUS.CLEAN },
    { roomNumber: '202', floor: '2', roomTypeId: executiveDouble._id, roomStatus: ROOM_STATUS.AVAILABLE, housekeepingStatus: HOUSEKEEPING_STATUS.CLEAN },
    { roomNumber: '301', floor: '3', roomTypeId: deluxeKing._id, roomStatus: ROOM_STATUS.OCCUPIED, housekeepingStatus: HOUSEKEEPING_STATUS.CLEAN },
    { roomNumber: '302', floor: '3', roomTypeId: deluxeKing._id, roomStatus: ROOM_STATUS.AVAILABLE, housekeepingStatus: HOUSEKEEPING_STATUS.DIRTY },
    { roomNumber: '401', floor: '4', roomTypeId: penthouse._id, roomStatus: ROOM_STATUS.RESERVED, housekeepingStatus: HOUSEKEEPING_STATUS.INSPECTED },
    { roomNumber: '402', floor: '4', roomTypeId: penthouse._id, roomStatus: ROOM_STATUS.AVAILABLE, housekeepingStatus: HOUSEKEEPING_STATUS.CLEAN }
  ];

  const createdRooms = [];
  for (const r of roomsData) {
    const room = await Room.create({
      hotelId: grandRegal._id,
      propertyId: mainProperty._id,
      ...r
    });
    createdRooms.push(room);
  }

  // 7. Guests
  const guest1 = await Guest.create({
    hotelId: grandRegal._id,
    name: 'Alexander Sterling',
    email: 'alex.sterling@example.com',
    phone: '+1 (555) 781-9023',
    city: 'San Francisco',
    country: 'United States',
    idDocumentType: 'passport',
    idDocumentNumber: 'US9482019',
    vipStatus: true,
    preferences: 'Prefers high floor room with extra feather pillows.'
  });

  const guest2 = await Guest.create({
    hotelId: grandRegal._id,
    name: 'Sophia Laurent',
    email: 'sophia.laurent@example.com',
    phone: '+1 (555) 412-8874',
    city: 'Paris',
    country: 'France',
    idDocumentType: 'passport',
    idDocumentNumber: 'FR847291',
    preferences: 'Vegan breakfast menu options requested.'
  });

  const guest3 = await Guest.create({
    hotelId: grandRegal._id,
    name: 'Marcus Brody',
    email: 'marcus.brody@example.com',
    phone: '+1 (555) 673-9912',
    city: 'London',
    country: 'United Kingdom',
    idDocumentType: 'driver_license',
    idDocumentNumber: 'UK6638104'
  });

  // 8. Reservations & Invoices & Payments
  // Reservation 1: Alexander Sterling in Room 301 (Checked In)
  const room301 = createdRooms.find(r => r.roomNumber === '301');
  const resv1 = await Reservation.create({
    hotelId: grandRegal._id,
    propertyId: mainProperty._id,
    bookingReference: 'BK-2026-9014',
    guestId: guest1._id,
    guestName: guest1.name,
    guestEmail: guest1.email,
    guestPhone: guest1.phone,
    checkInDate: new Date(),
    checkOutDate: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000),
    rooms: [{
      roomId: room301._id,
      roomTypeId: deluxeKing._id,
      roomNumber: '301',
      ratePerNight: 280
    }],
    adultsCount: 2,
    childrenCount: 0,
    bookingSource: 'online',
    status: RESERVATION_STATUS.CHECKED_IN,
    paymentStatus: PAYMENT_STATUS.PAID,
    subtotal: 840,
    taxAmount: 84,
    totalAmount: 924,
    paidAmount: 924,
    balanceAmount: 0,
    checkedInAt: new Date(),
    checkedInBy: receptionist._id
  });

  const inv1 = await Invoice.create({
    hotelId: grandRegal._id,
    propertyId: mainProperty._id,
    invoiceNumber: 'INV-2026-1001',
    reservationId: resv1._id,
    guestId: guest1._id,
    items: [{
      description: 'Deluxe Ocean King Suite (Room 301) - 3 Nights',
      quantity: 3,
      unitPrice: 280,
      amount: 840,
      itemType: 'room'
    }],
    subtotal: 840,
    taxAmount: 84,
    totalAmount: 924,
    paidAmount: 924,
    balanceAmount: 0,
    status: INVOICE_STATUS.PAID
  });

  await Payment.create({
    hotelId: grandRegal._id,
    reservationId: resv1._id,
    invoiceId: inv1._id,
    amount: 924,
    method: 'card',
    status: 'captured',
    transactionRef: 'TXN-948201',
    notes: 'Paid via Visa card machine at front desk',
    recordedBy: receptionist._id
  });

  // Reservation 2: Sophia Laurent in Room 201 (Checked In, partial payment)
  const room201 = createdRooms.find(r => r.roomNumber === '201');
  const resv2 = await Reservation.create({
    hotelId: grandRegal._id,
    propertyId: mainProperty._id,
    bookingReference: 'BK-2026-8812',
    guestId: guest2._id,
    guestName: guest2.name,
    guestEmail: guest2.email,
    guestPhone: guest2.phone,
    checkInDate: new Date(),
    checkOutDate: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000),
    rooms: [{
      roomId: room201._id,
      roomTypeId: executiveDouble._id,
      roomNumber: '201',
      ratePerNight: 220
    }],
    adultsCount: 2,
    childrenCount: 1,
    bookingSource: 'walk_in',
    status: RESERVATION_STATUS.CHECKED_IN,
    paymentStatus: PAYMENT_STATUS.PARTIALLY_PAID,
    subtotal: 440,
    taxAmount: 44,
    totalAmount: 484,
    paidAmount: 200,
    balanceAmount: 284,
    checkedInAt: new Date(),
    checkedInBy: receptionist._id
  });

  const inv2 = await Invoice.create({
    hotelId: grandRegal._id,
    propertyId: mainProperty._id,
    invoiceNumber: 'INV-2026-1002',
    reservationId: resv2._id,
    guestId: guest2._id,
    items: [{
      description: 'Executive Double Queen Room (Room 201) - 2 Nights',
      quantity: 2,
      unitPrice: 220,
      amount: 440,
      itemType: 'room'
    }],
    subtotal: 440,
    taxAmount: 44,
    totalAmount: 484,
    paidAmount: 200,
    balanceAmount: 284,
    status: INVOICE_STATUS.PARTIALLY_PAID
  });

  await Payment.create({
    hotelId: grandRegal._id,
    reservationId: resv2._id,
    invoiceId: inv2._id,
    amount: 200,
    method: 'cash',
    status: 'captured',
    transactionRef: 'CASH-REC-101',
    notes: 'Advance deposit paid in cash',
    recordedBy: receptionist._id
  });

  // Reservation 3: Marcus Brody (Confirmed future arrival in Room 401)
  const room401 = createdRooms.find(r => r.roomNumber === '401');
  await Reservation.create({
    hotelId: grandRegal._id,
    propertyId: mainProperty._id,
    bookingReference: 'BK-2026-7721',
    guestId: guest3._id,
    guestName: guest3.name,
    guestEmail: guest3.email,
    guestPhone: guest3.phone,
    checkInDate: new Date(Date.now() + 1 * 24 * 60 * 60 * 1000),
    checkOutDate: new Date(Date.now() + 4 * 24 * 60 * 60 * 1000),
    rooms: [{
      roomId: room401._id,
      roomTypeId: penthouse._id,
      roomNumber: '401',
      ratePerNight: 650
    }],
    adultsCount: 2,
    childrenCount: 0,
    bookingSource: 'online',
    status: RESERVATION_STATUS.CONFIRMED,
    paymentStatus: PAYMENT_STATUS.UNPAID,
    subtotal: 1950,
    taxAmount: 195,
    totalAmount: 2145,
    paidAmount: 0,
    balanceAmount: 2145
  });

  // 9. Housekeeping Task
  const room302 = createdRooms.find(r => r.roomNumber === '302');
  await HousekeepingTask.create({
    hotelId: grandRegal._id,
    propertyId: mainProperty._id,
    roomId: room302._id,
    assignedTo: housekeepingStaff._id,
    priority: PRIORITY.HIGH,
    taskType: 'checkout_cleaning',
    status: HOUSEKEEPING_STATUS.DIRTY,
    notes: 'Prioritize for 14:00 check-in. Change all linens and restock coffee pods.'
  });

  // 10. Restaurant Menu & Orders
  const catStarters = await MenuCategory.create({
    hotelId: grandRegal._id,
    name: 'Appetizers & Starters',
    description: 'Fresh seafood and artisanal bites',
    displayOrder: 1
  });

  const catMains = await MenuCategory.create({
    hotelId: grandRegal._id,
    name: 'Chef Specials & Mains',
    description: 'Prime dry-aged steaks and wild-caught seafood',
    displayOrder: 2
  });

  const catBeverages = await MenuCategory.create({
    hotelId: grandRegal._id,
    name: 'Cocktails & Wine',
    description: 'Handcrafted signature cocktails and cellar wines',
    displayOrder: 3
  });

  const calamari = await MenuItem.create({
    hotelId: grandRegal._id,
    categoryId: catStarters._id,
    name: 'Crispy Salt & Pepper Calamari',
    description: 'Served with yuzu aioli and sweet chili dipping reduction',
    price: 18,
    isAvailable: true
  });

  const filetMignon = await MenuItem.create({
    hotelId: grandRegal._id,
    categoryId: catMains._id,
    name: '8oz USDA Prime Filet Mignon',
    description: 'Truffle mashed potatoes, asparagus, and red wine demi-glace',
    price: 52,
    isAvailable: true
  });

  const martini = await MenuItem.create({
    hotelId: grandRegal._id,
    categoryId: catBeverages._id,
    name: 'Grand Ocean Azure Martini',
    description: 'Artisanal gin, blue curacao, lime essence, and edible gold leaf',
    price: 16,
    isAvailable: true
  });

  // Restaurant Order transferred to Room 301 Folio
  await FoodOrder.create({
    hotelId: grandRegal._id,
    propertyId: mainProperty._id,
    orderNumber: 'ORD-2026-4012',
    orderType: 'room_service',
    roomId: room301._id,
    roomNumber: '301',
    reservationId: resv1._id,
    guestId: guest1._id,
    guestName: guest1.name,
    items: [
      { menuItemId: filetMignon._id, name: filetMignon.name, quantity: 1, unitPrice: 52, amount: 52 },
      { menuItemId: martini._id, name: martini.name, quantity: 2, unitPrice: 16, amount: 32 }
    ],
    subtotal: 84,
    taxAmount: 4.2,
    totalAmount: 88.2,
    status: FOOD_ORDER_STATUS.SERVED,
    isBilledToRoomFolio: true,
    paymentStatus: 'transferred_to_folio',
    createdBy: restaurantStaff._id
  });

  // 11. Vendor and Inventory
  const vendor = await Vendor.create({
    hotelId: grandRegal._id,
    name: 'Atlantic Hospitality Supplies Inc.',
    contactPerson: 'Robert Miller',
    email: 'orders@atlantichospitality.com',
    phone: '+1 (555) 892-3321',
    address: '120 Logistics Parkway, Port of Miami',
    paymentTerms: 'Net 30'
  });

  const shampoo = await InventoryItem.create({
    hotelId: grandRegal._id,
    propertyId: mainProperty._id,
    name: 'Organic Lavender Shampoo (50ml)',
    code: 'TOI-SHMP-01',
    category: 'toiletries',
    unit: 'bottles',
    currentStock: 450,
    minStockThreshold: 100,
    unitCost: 1.20,
    vendorId: vendor._id
  });

  const bathTowels = await InventoryItem.create({
    hotelId: grandRegal._id,
    propertyId: mainProperty._id,
    name: 'Egyptian Cotton Luxury Bath Towels',
    code: 'LIN-TOWL-02',
    category: 'linen_cleaning',
    unit: 'pieces',
    currentStock: 18, // Below threshold of 25 to demonstrate low-stock alert!
    minStockThreshold: 25,
    unitCost: 18.50,
    vendorId: vendor._id
  });

  // 12. Expenses
  await Expense.create([
    {
      hotelId: grandRegal._id,
      propertyId: mainProperty._id,
      expenseNumber: 'EXP-2026-081',
      category: 'electricity',
      amount: 1450,
      date: new Date(),
      description: 'Monthly commercial utility bill - Florida Power & Light',
      paymentMethod: 'bank_transfer',
      status: 'approved',
      createdBy: hotelAdmin._id,
      approvedBy: hotelAdmin._id
    },
    {
      hotelId: grandRegal._id,
      propertyId: mainProperty._id,
      expenseNumber: 'EXP-2026-082',
      category: 'supplies',
      amount: 620,
      date: new Date(),
      description: 'Linen and luxury organic toiletries restock',
      vendorId: vendor._id,
      paymentMethod: 'bank_transfer',
      status: 'approved',
      createdBy: hotelAdmin._id,
      approvedBy: hotelAdmin._id
    }
  ]);

  // 13. Maintenance Ticket
  await MaintenanceTicket.create({
    hotelId: grandRegal._id,
    propertyId: mainProperty._id,
    ticketNumber: 'MNT-2026-042',
    roomId: room302._id,
    roomNumber: '302',
    category: 'plumbing',
    issueDescription: 'Bathroom vanity sink water drain is slow. Check siphon pipe.',
    priority: PRIORITY.MEDIUM,
    status: MAINTENANCE_STATUS.ASSIGNED,
    assignedTechnician: maintenanceStaff._id,
    technicianName: maintenanceStaff.name,
    reportedBy: housekeepingStaff._id
  });

  // 14. Notifications
  await Notification.create([
    {
      hotelId: grandRegal._id,
      title: 'VIP Guest Checked In',
      message: 'Alexander Sterling has checked into Deluxe Suite 301.',
      type: 'booking',
      link: '/frontdesk'
    },
    {
      hotelId: grandRegal._id,
      title: 'Low Stock Alert',
      message: 'Egyptian Cotton Luxury Bath Towels stock is down to 18 pieces (Threshold: 25).',
      type: 'inventory',
      link: '/inventory'
    }
  ]);

  logger.info('Database seeding completed successfully!');
  logger.info('Credentials summary:');
  logger.info('Platform Super Admin: superadmin@grandstayhms.com / AdminPassword123!');
  logger.info('Hotel General Manager: admin@grandregal.com / HotelPassword123!');
  logger.info('Front Desk Reception: reception@grandregal.com / StaffPassword123!');
  logger.info('Restaurant Chef: chef@grandregal.com / StaffPassword123!');
  logger.info('Housekeeping: cleaning@grandregal.com / StaffPassword123!');
  logger.info('Maintenance: tech@grandregal.com / StaffPassword123!');
};

// Auto-run if executed directly
if (process.argv[1]?.endsWith('seeder.js')) {
  (async () => {
    try {
      await connectDB();
      await seedDatabase();
      await closeDB();
      process.exit(0);
    } catch (err) {
      console.error('Seeder execution failed:', err);
      process.exit(1);
    }
  })();
}
