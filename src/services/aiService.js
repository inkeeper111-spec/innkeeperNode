import dayjs from 'dayjs';
import { Reservation, Room, Invoice, Expense, InventoryItem } from '../models/index.js';
import { RESERVATION_STATUS, PAYMENT_STATUS, ROOM_STATUS } from '../config/constants.js';

export const getAIAnalytics = async (hotelId, queryText = '') => {
  const startOfMonth = dayjs().startOf('month').toDate();
  const endOfMonth = dayjs().endOf('month').toDate();
  const startOfPrevMonth = dayjs().subtract(1, 'month').startOf('month').toDate();
  const endOfPrevMonth = dayjs().subtract(1, 'month').endOf('month').toDate();
  const startOfWeek = dayjs().startOf('week').toDate();
  const endOfWeek = dayjs().endOf('week').toDate();

  // 1. Total & Room metrics
  const totalRooms = await Room.countDocuments({ hotelId, isActive: true });
  const occupiedRooms = await Room.countDocuments({ hotelId, roomStatus: ROOM_STATUS.OCCUPIED });
  const currentOccupancy = totalRooms > 0 ? Math.round((occupiedRooms / totalRooms) * 100) : 0;

  // 2. Revenue this month
  const revenueAgg = await Invoice.aggregate([
    {
      $match: {
        hotelId,
        status: { $in: ['issued', 'paid', 'partially_paid'] },
        createdAt: { $gte: startOfMonth, $lte: endOfMonth }
      }
    },
    {
      $group: {
        _id: null,
        totalRevenue: { $sum: '$totalAmount' },
        totalPaid: { $sum: '$paidAmount' },
        totalBalance: { $sum: '$balanceAmount' }
      }
    }
  ]);

  const thisMonthRevenue = revenueAgg[0]?.totalRevenue || 0;
  const thisMonthPaid = revenueAgg[0]?.totalPaid || 0;
  const thisMonthOutstanding = revenueAgg[0]?.totalBalance || 0;

  // 3. Revenue previous month
  const prevRevenueAgg = await Invoice.aggregate([
    {
      $match: {
        hotelId,
        status: { $in: ['issued', 'paid', 'partially_paid'] },
        createdAt: { $gte: startOfPrevMonth, $lte: endOfPrevMonth }
      }
    },
    {
      $group: {
        _id: null,
        totalRevenue: { $sum: '$totalAmount' }
      }
    }
  ]);
  const prevMonthRevenue = prevRevenueAgg[0]?.totalRevenue || 0;

  // 4. Room Nights Sold & ADR / RevPAR
  const bookingsThisMonth = await Reservation.find({
    hotelId,
    status: { $in: [RESERVATION_STATUS.CONFIRMED, RESERVATION_STATUS.CHECKED_IN, RESERVATION_STATUS.CHECKED_OUT] },
    checkInDate: { $gte: startOfMonth, $lte: endOfMonth }
  });

  const roomsSold = bookingsThisMonth.reduce((acc, b) => acc + (b.rooms?.length || 1), 0);
  const totalRoomRevenue = bookingsThisMonth.reduce((acc, b) => acc + b.totalAmount, 0);

  const adr = roomsSold > 0 ? (totalRoomRevenue / roomsSold).toFixed(2) : 0;
  const revpar = totalRooms > 0 ? ((totalRoomRevenue / (totalRooms * dayjs().date())).toFixed(2)) : 0;

  // 5. Unpaid bookings
  const unpaidBookings = await Reservation.find({
    hotelId,
    paymentStatus: { $in: [PAYMENT_STATUS.UNPAID, PAYMENT_STATUS.PARTIALLY_PAID] },
    status: { $nin: [RESERVATION_STATUS.CANCELLED] }
  }).select('bookingReference guestName totalAmount paidAmount balanceAmount checkInDate').limit(10);

  // 6. Low stock items
  const lowStockItems = await InventoryItem.find({
    hotelId,
    $expr: { $lte: ['$currentStock', '$minStockThreshold'] }
  }).select('name code currentStock minStockThreshold unit');

  // 7. Expenses this month vs last month
  const expensesThisMonth = await Expense.aggregate([
    {
      $match: {
        hotelId,
        status: 'approved',
        date: { $gte: startOfMonth, $lte: endOfMonth }
      }
    },
    {
      $group: {
        _id: '$category',
        total: { $sum: '$amount' }
      }
    }
  ]);

  const totalExpensesThisMonth = expensesThisMonth.reduce((sum, e) => sum + e.total, 0);

  // Synthesize answer based on query
  const q = queryText.toLowerCase();
  let aiAnswer = '';
  let queryCategory = 'general';

  if (q.includes('revenue') || q.includes('earned') || q.includes('sales')) {
    queryCategory = 'revenue';
    const growth = prevMonthRevenue > 0
      ? (((thisMonthRevenue - prevMonthRevenue) / prevMonthRevenue) * 100).toFixed(1)
      : 'N/A';
    aiAnswer = `This month's total invoiced revenue is $${thisMonthRevenue.toLocaleString()}, with $${thisMonthPaid.toLocaleString()} collected in payments and $${thisMonthOutstanding.toLocaleString()} outstanding. Compared to last month ($${prevMonthRevenue.toLocaleString()}), revenue performance shows a ${growth}% variance.`;
  } else if (q.includes('occupancy') || q.includes('rate') || q.includes('adr') || q.includes('revpar')) {
    queryCategory = 'occupancy';
    aiAnswer = `Current live occupancy is ${currentOccupancy}% (${occupiedRooms} of ${totalRooms} rooms occupied). For the current month, your Average Daily Rate (ADR) stands at $${adr} across ${roomsSold} room bookings, yielding an estimated RevPAR of $${revpar}.`;
  } else if (q.includes('unpaid') || q.includes('pending payment') || q.includes('balance')) {
    queryCategory = 'unpaid_bookings';
    if (unpaidBookings.length === 0) {
      aiAnswer = 'All active bookings currently have their balances cleared. Outstanding balance is $0.';
    } else {
      const list = unpaidBookings.slice(0, 5).map(b => `${b.bookingReference} (${b.guestName || 'Guest'}): $${b.balanceAmount} due`).join('; ');
      aiAnswer = `There are ${unpaidBookings.length} booking(s) with pending balances. Key items: ${list}. Total uncollected balance this month: $${thisMonthOutstanding.toLocaleString()}.`;
    }
  } else if (q.includes('stock') || q.includes('inventory') || q.includes('low')) {
    queryCategory = 'inventory';
    if (lowStockItems.length === 0) {
      aiAnswer = 'All inventory items are currently above their safe minimum stock thresholds.';
    } else {
      const list = lowStockItems.map(i => `${i.name} (Stock: ${i.currentStock} ${i.unit}, Min: ${i.minStockThreshold})`).join(', ');
      aiAnswer = `Attention: ${lowStockItems.length} inventory item(s) are at or below minimum threshold: ${list}. Immediate purchase reorder recommended.`;
    }
  } else if (q.includes('expense')) {
    queryCategory = 'expenses';
    aiAnswer = `Approved expenses this month total $${totalExpensesThisMonth.toLocaleString()}. Top categories: ${expensesThisMonth.map(e => `${e._id}: $${e.total.toLocaleString()}`).join(', ') || 'No expenses recorded yet'}.`;
  } else {
    queryCategory = 'summary';
    aiAnswer = `Executive Briefing: Invoiced revenue this month is $${thisMonthRevenue.toLocaleString()} with ${currentOccupancy}% current occupancy. You have ${unpaidBookings.length} unpaid bookings and ${lowStockItems.length} inventory items requiring restocking.`;
  }

  // Actionable business insights
  const insights = [
    {
      title: 'Occupancy Optimization',
      type: currentOccupancy < 50 ? 'warning' : 'positive',
      text: currentOccupancy < 50
        ? 'Occupancy is currently below 50%. Consider launching promotional rates or weekend packages for standard rooms.'
        : `Strong occupancy of ${currentOccupancy}%. Revenue management opportunity to apply premium pricing for remaining suites.`
    },
    {
      title: 'Inventory Alert',
      type: lowStockItems.length > 0 ? 'alert' : 'info',
      text: lowStockItems.length > 0
        ? `${lowStockItems.length} essential items need replenishment to prevent service disruption.`
        : 'Supplies and consumables are at healthy operating levels.'
    },
    {
      title: 'Cashflow Health',
      type: thisMonthOutstanding > 0 ? 'warning' : 'positive',
      text: thisMonthOutstanding > 0
        ? `Pending payment collections total $${thisMonthOutstanding.toLocaleString()}. Ensure front-desk collects remaining balances at check-in or checkout.`
        : 'Zero outstanding receivables recorded for this billing cycle.'
    }
  ];

  return {
    query: queryText,
    category: queryCategory,
    answer: aiAnswer,
    insights,
    metrics: {
      totalRooms,
      occupiedRooms,
      currentOccupancy,
      thisMonthRevenue,
      thisMonthPaid,
      thisMonthOutstanding,
      adr: Number(adr),
      revpar: Number(revpar),
      unpaidCount: unpaidBookings.length,
      lowStockCount: lowStockItems.length,
      totalExpensesThisMonth
    }
  };
};

