import dayjs from 'dayjs';
import { Room, Reservation, Invoice, Payment, HousekeepingTask, MaintenanceTicket } from '../models/index.js';
import { ROOM_STATUS, HOUSEKEEPING_STATUS, RESERVATION_STATUS, PAYMENT_STATUS } from '../config/constants.js';

export const getDashboardSummary = async (req, res, next) => {
  try {
    const hotelId = req.hotelId;
    const todayStart = dayjs().startOf('day').toDate();
    const todayEnd = dayjs().endOf('day').toDate();
    const monthStart = dayjs().startOf('month').toDate();
    const monthEnd = dayjs().endOf('month').toDate();

    // 1. Room Counts
    const totalRooms = await Room.countDocuments({ hotelId, isActive: true });
    const availableRooms = await Room.countDocuments({ hotelId, isActive: true, roomStatus: ROOM_STATUS.AVAILABLE });
    const occupiedRooms = await Room.countDocuments({ hotelId, roomStatus: ROOM_STATUS.OCCUPIED });
    const reservedRooms = await Room.countDocuments({ hotelId, roomStatus: ROOM_STATUS.RESERVED });
    const dirtyRooms = await Room.countDocuments({
      hotelId,
      housekeepingStatus: { $in: [HOUSEKEEPING_STATUS.DIRTY, HOUSEKEEPING_STATUS.CLEANING_IN_PROGRESS] }
    });

    const occupancyRate = totalRooms > 0 ? Math.round((occupiedRooms / totalRooms) * 100) : 0;

    // 2. Today's Arrivals and Departures
    const todayArrivals = await Reservation.countDocuments({
      hotelId,
      status: { $in: [RESERVATION_STATUS.APPROVED, RESERVATION_STATUS.CONFIRMED, RESERVATION_STATUS.CHECKED_IN] },
      checkInDate: { $gte: todayStart, $lte: todayEnd }
    });

    const todayDepartures = await Reservation.countDocuments({
      hotelId,
      status: { $in: [RESERVATION_STATUS.CHECKED_IN, RESERVATION_STATUS.CHECKED_OUT] },
      checkOutDate: { $gte: todayStart, $lte: todayEnd }
    });

    // 3. Revenue
    const todayRevenueAgg = await Payment.aggregate([
      {
        $match: {
          hotelId,
          status: 'captured',
          paymentDate: { $gte: todayStart, $lte: todayEnd }
        }
      },
      { $group: { _id: null, total: { $sum: '$amount' } } }
    ]);
    const todayRevenue = todayRevenueAgg[0]?.total || 0;

    const monthRevenueAgg = await Payment.aggregate([
      {
        $match: {
          hotelId,
          status: 'captured',
          paymentDate: { $gte: monthStart, $lte: monthEnd }
        }
      },
      { $group: { _id: null, total: { $sum: '$amount' } } }
    ]);
    const monthlyRevenue = monthRevenueAgg[0]?.total || 0;

    // 4. Pending payments balance
    const pendingBalanceAgg = await Invoice.aggregate([
      {
        $match: {
          hotelId,
          status: { $in: ['issued', 'partially_paid'] }
        }
      },
      { $group: { _id: null, total: { $sum: '$balanceAmount' } } }
    ]);
    const pendingPayments = pendingBalanceAgg[0]?.total || 0;

    // 5. Active Reservations
    const activeReservations = await Reservation.countDocuments({
      hotelId,
      status: { $in: [RESERVATION_STATUS.APPROVED, RESERVATION_STATUS.CONFIRMED, RESERVATION_STATUS.CHECKED_IN] }
    });

    // 6. Recent lists
    const recentBookings = await Reservation.find({ hotelId })
      .populate('guestId', 'name email phone')
      .sort({ createdAt: -1 })
      .limit(5);

    const recentTransactions = await Payment.find({ hotelId })
      .populate('invoiceId', 'invoiceNumber')
      .sort({ paymentDate: -1 })
      .limit(5);

    const housekeepingAlerts = await HousekeepingTask.find({
      hotelId,
      status: { $in: [HOUSEKEEPING_STATUS.DIRTY, HOUSEKEEPING_STATUS.CLEANING_IN_PROGRESS] }
    })
      .populate('roomId', 'roomNumber floor')
      .limit(5);

    const maintenanceAlerts = await MaintenanceTicket.find({
      hotelId,
      status: { $in: ['open', 'in_progress'] }
    })
      .sort({ priority: -1 })
      .limit(5);

    // 7. Last 7 Days Revenue Trend
    const last7Days = [];
    for (let i = 6; i >= 0; i--) {
      const d = dayjs().subtract(i, 'day');
      const start = d.startOf('day').toDate();
      const end = d.endOf('day').toDate();

      const dayPayments = await Payment.aggregate([
        {
          $match: {
            hotelId,
            status: 'captured',
            paymentDate: { $gte: start, $lte: end }
          }
        },
        { $group: { _id: null, total: { $sum: '$amount' } } }
      ]);

      const dayBookings = await Reservation.countDocuments({
        hotelId,
        createdAt: { $gte: start, $lte: end }
      });

      last7Days.push({
        date: d.format('MMM DD'),
        revenue: dayPayments[0]?.total || 0,
        bookings: dayBookings
      });
    }

    res.json({
      success: true,
      data: {
        totalRooms,
        availableRooms,
        occupiedRooms,
        reservedRooms,
        dirtyRooms,
        occupancyRate,
        todayArrivals,
        todayDepartures,
        todayRevenue,
        monthlyRevenue,
        pendingPayments,
        activeReservations,
        recentBookings,
        recentTransactions,
        housekeepingAlerts,
        maintenanceAlerts,
        revenueTrend: last7Days
      }
    });
  } catch (err) {
    next(err);
  }
};

export const getFinancialReport = async (req, res, next) => {
  try {
    const { startDate, endDate } = req.query;
    const start = startDate ? dayjs(startDate).startOf('day').toDate() : dayjs().startOf('month').toDate();
    const end = endDate ? dayjs(endDate).endOf('day').toDate() : dayjs().endOf('month').toDate();

    // Invoices issued in range
    const invoices = await Invoice.find({
      hotelId: req.hotelId,
      createdAt: { $gte: start, $lte: end }
    }).populate('guestId', 'name email');

    const totalInvoiced = invoices.reduce((acc, i) => acc + i.totalAmount, 0);
    const totalCollected = invoices.reduce((acc, i) => acc + i.paidAmount, 0);
    const totalOutstanding = invoices.reduce((acc, i) => acc + i.balanceAmount, 0);

    // Payments in range
    const payments = await Payment.find({
      hotelId: req.hotelId,
      status: 'captured',
      paymentDate: { $gte: start, $lte: end }
    });

    const paymentByMethod = payments.reduce((acc, p) => {
      acc[p.method] = (acc[p.method] || 0) + p.amount;
      return acc;
    }, {});

    res.json({
      success: true,
      data: {
        totalInvoiced,
        totalCollected,
        totalOutstanding,
        paymentByMethod,
        invoicesCount: invoices.length,
        paymentsCount: payments.length
      }
    });
  } catch (err) {
    next(err);
  }
};

export const exportReportCSV = async (req, res, next) => {
  try {
    const { type = 'reservations' } = req.query;

    if (type === 'reservations') {
      const records = await Reservation.find({ hotelId: req.hotelId }).sort({ createdAt: -1 });
      const csvRows = [
        'Booking Reference,Guest Name,Check-In,Check-Out,Total Amount,Paid Amount,Balance,Status,Payment Status'
      ];

      records.forEach(r => {
        csvRows.push(
          `"${r.bookingReference}","${r.guestName}","${dayjs(r.checkInDate).format('YYYY-MM-DD')}","${dayjs(r.checkOutDate).format('YYYY-MM-DD')}",${r.totalAmount},${r.paidAmount},${r.balanceAmount},"${r.status}","${r.paymentStatus}"`
        );
      });

      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename=reservations-${dayjs().format('YYYY-MM-DD')}.csv`);
      return res.send(csvRows.join('\n'));
    }

    if (type === 'invoices') {
      const records = await Invoice.find({ hotelId: req.hotelId }).populate('guestId', 'name').sort({ createdAt: -1 });
      const csvRows = [
        'Invoice Number,Guest Name,Subtotal,Tax,Total Amount,Paid Amount,Balance,Status,Issued Date'
      ];

      records.forEach(inv => {
        csvRows.push(
          `"${inv.invoiceNumber}","${inv.guestId?.name || 'Guest'}",${inv.subtotal},${inv.taxAmount},${inv.totalAmount},${inv.paidAmount},${inv.balanceAmount},"${inv.status}","${dayjs(inv.createdAt).format('YYYY-MM-DD')}"`
        );
      });

      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename=invoices-${dayjs().format('YYYY-MM-DD')}.csv`);
      return res.send(csvRows.join('\n'));
    }

    res.status(400).json({ success: false, message: 'Invalid report export type.' });
  } catch (err) {
    next(err);
  }
};
