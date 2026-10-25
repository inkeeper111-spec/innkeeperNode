import { MenuCategory, MenuItem, FoodOrder, Reservation, Invoice, Room } from '../models/index.js';
import { FOOD_ORDER_STATUS, RESERVATION_STATUS } from '../config/constants.js';
import { generateReference } from '../utils/reference.js';
import { logAudit } from '../services/auditService.js';

export const getMenu = async (req, res, next) => {
  try {
    const categories = await MenuCategory.find({ hotelId: req.hotelId, isActive: true }).sort({ displayOrder: 1 });
    const items = await MenuItem.find({ hotelId: req.hotelId, isAvailable: true }).populate('categoryId');

    res.json({
      success: true,
      data: {
        categories,
        items
      }
    });
  } catch (err) {
    next(err);
  }
};

export const createCategory = async (req, res, next) => {
  try {
    const category = await MenuCategory.create({
      ...req.body,
      hotelId: req.hotelId
    });
    res.status(201).json({ success: true, data: category });
  } catch (err) {
    next(err);
  }
};

export const updateCategory = async (req, res, next) => {
  try {
    const category = await MenuCategory.findOneAndUpdate(
      { _id: req.params.id, hotelId: req.hotelId },
      req.body,
      { new: true }
    );
    if (!category) {
      return res.status(404).json({ success: false, message: 'Category not found.' });
    }
    res.json({ success: true, data: category });
  } catch (err) {
    next(err);
  }
};

export const createMenuItem = async (req, res, next) => {
  try {
    const item = await MenuItem.create({
      ...req.body,
      hotelId: req.hotelId
    });
    res.status(201).json({ success: true, data: item });
  } catch (err) {
    next(err);
  }
};

export const updateMenuItem = async (req, res, next) => {
  try {
    const item = await MenuItem.findOneAndUpdate(
      { _id: req.params.id, hotelId: req.hotelId },
      req.body,
      { new: true }
    ).populate('categoryId');
    if (!item) {
      return res.status(404).json({ success: false, message: 'Menu item not found.' });
    }
    res.json({ success: true, data: item });
  } catch (err) {
    next(err);
  }
};

export const getOrders = async (req, res, next) => {
  try {
    const { status, orderType } = req.query;
    const filter = { hotelId: req.hotelId };

    if (status && status !== 'all') filter.status = status;
    if (orderType && orderType !== 'all') filter.orderType = orderType;

    const orders = await FoodOrder.find(filter)
      .populate('roomId', 'roomNumber')
      .populate('reservationId', 'bookingReference guestName')
      .sort({ createdAt: -1 });

    res.json({ success: true, data: orders });
  } catch (err) {
    next(err);
  }
};

export const createOrder = async (req, res, next) => {
  try {
    const {
      orderType = 'dine_in',
      tableNumber = '',
      roomId = null,
      reservationId = null,
      items, // [{ menuItemId, quantity, specialInstructions }]
      discountAmount = 0
    } = req.body;

    if (!items || items.length === 0) {
      return res.status(400).json({ success: false, message: 'At least one item is required.' });
    }

    let subtotal = 0;
    const orderItems = [];

    for (const item of items) {
      const menuItem = await MenuItem.findOne({ _id: item.menuItemId, hotelId: req.hotelId });
      if (!menuItem) {
        return res.status(400).json({ success: false, message: `Menu item not found: ${item.menuItemId}` });
      }

      const itemTotal = menuItem.price * item.quantity;
      subtotal += itemTotal;

      orderItems.push({
        menuItemId: menuItem._id,
        name: menuItem.name,
        quantity: item.quantity,
        unitPrice: menuItem.price,
        amount: itemTotal,
        specialInstructions: item.specialInstructions || ''
      });
    }

    const taxAmount = Math.round(subtotal * 0.05 * 100) / 100; // 5% F&B tax
    const totalAmount = Math.round((subtotal - discountAmount + taxAmount) * 100) / 100;

    let roomNumber = '';
    let guestName = '';
    let guestId = null;

    if (roomId) {
      const room = await Room.findById(roomId);
      if (room) roomNumber = room.roomNumber;
    }

    if (reservationId) {
      const resv = await Reservation.findById(reservationId);
      if (resv) {
        guestName = resv.guestName;
        guestId = resv.guestId;
      }
    }

    const orderNumber = generateReference('ORD');
    const order = await FoodOrder.create({
      hotelId: req.hotelId,
      propertyId: req.propertyId,
      orderNumber,
      orderType,
      tableNumber,
      roomId,
      roomNumber,
      reservationId,
      guestId,
      guestName,
      items: orderItems,
      subtotal,
      taxAmount,
      discountAmount,
      totalAmount,
      status: FOOD_ORDER_STATUS.PENDING,
      paymentStatus: 'unpaid',
      createdBy: req.user._id
    });

    res.status(201).json({
      success: true,
      message: 'Restaurant order placed successfully.',
      data: order
    });
  } catch (err) {
    next(err);
  }
};

export const updateOrderStatus = async (req, res, next) => {
  try {
    const { status } = req.body;
    const order = await FoodOrder.findOneAndUpdate(
      { _id: req.params.id, hotelId: req.hotelId },
      { status },
      { new: true }
    );

    if (!order) {
      return res.status(404).json({ success: false, message: 'Order not found.' });
    }

    res.json({ success: true, message: `Order status updated to ${status}.`, data: order });
  } catch (err) {
    next(err);
  }
};

/**
 * Transfer restaurant charge to guest's room folio (Invoice)
 */
export const transferToRoomFolio = async (req, res, next) => {
  try {
    const { orderId, reservationId } = req.body;

    const order = await FoodOrder.findOne({ _id: orderId, hotelId: req.hotelId });
    if (!order) {
      return res.status(404).json({ success: false, message: 'Food order not found.' });
    }

    if (order.isBilledToRoomFolio) {
      return res.status(400).json({ success: false, message: 'Order charges have already been transferred to folio.' });
    }

    const reservation = await Reservation.findOne({
      _id: reservationId || order.reservationId,
      hotelId: req.hotelId,
      status: RESERVATION_STATUS.CHECKED_IN
    });

    if (!reservation) {
      return res.status(400).json({
        success: false,
        message: 'Active in-house checked-in reservation not found for folio billing.'
      });
    }

    // Find active invoice for this reservation
    const invoice = await Invoice.findOne({ reservationId: reservation._id, hotelId: req.hotelId });
    if (!invoice) {
      return res.status(404).json({ success: false, message: 'Invoice not found for this reservation.' });
    }

    // Append restaurant line item to the invoice
    invoice.items.push({
      description: `Restaurant Order #${order.orderNumber} (${order.orderType})`,
      quantity: 1,
      unitPrice: order.totalAmount,
      amount: order.totalAmount,
      itemType: 'restaurant',
      sourceRef: order._id.toString()
    });

    invoice.subtotal = Math.round((invoice.subtotal + order.totalAmount) * 100) / 100;
    invoice.totalAmount = Math.round((invoice.totalAmount + order.totalAmount) * 100) / 100;
    invoice.balanceAmount = Math.round((invoice.totalAmount - invoice.paidAmount) * 100) / 100;
    await invoice.save();

    // Update reservation total & balance
    reservation.totalAmount = Math.round((reservation.totalAmount + order.totalAmount) * 100) / 100;
    reservation.balanceAmount = Math.round((reservation.totalAmount - reservation.paidAmount) * 100) / 100;
    await reservation.save();

    // Mark order as billed to room folio
    order.isBilledToRoomFolio = true;
    order.paymentStatus = 'transferred_to_folio';
    order.reservationId = reservation._id;
    await order.save();

    await logAudit({
      hotelId: req.hotelId,
      action: 'FOLIO_TRANSFER',
      entity: 'FoodOrder',
      entityId: order._id,
      details: { orderNumber: order.orderNumber, bookingReference: reservation.bookingReference, amount: order.totalAmount },
      req
    });

    res.json({
      success: true,
      message: `Charge of $${order.totalAmount} transferred to Room Folio (${reservation.bookingReference}).`,
      data: {
        order,
        invoice
      }
    });
  } catch (err) {
    next(err);
  }
};

